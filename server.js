#!/usr/bin/env node
/* ==========================================================================
   Serpent — Battle Royale server
   Zero dependencies on purpose: this project's whole point is that it has no
   install step, so the WebSocket handshake and frame codec are implemented
   here against RFC 6455 rather than pulled from npm.

       node server.js            then open http://localhost:8080

   The server is authoritative. Clients send a heading; the server runs the
   arena and broadcasts state. That keeps every client honest about who ate
   whom, which matters in a mode where size decides fights.
   ========================================================================== */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const requestedPort = Number(process.env.PORT ?? 8080);
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8080;
const ROOT = __dirname;

/* ==================== arena rules ==================== */
const W = 400, H = 400;              // cells — 160,000 of them, 256x the campaign board
const TICK_MS = 90;
const START_LEN = 6;
const FOOD_TARGET = 3600;            // held at roughly the same density as a smaller arena
const POWER_TARGET = 72;
const BOT_TARGET = 30;               // keeps a world this size from feeling empty
const SEG_PER_LEVEL = 5;
const SHIELD_MS = 8000;
const FRENZY_MS = 7000;
const RESPAWN_CLEAR = 4;             // cells that must be free around a spawn

/* Wire order for food kinds — the client holds the same list and the index is
   what goes over the socket, so the two must not drift. */
const PREY_KINDS = ['APPLE', 'EGG', 'MOUSE', 'FROG', 'LIZARD', 'RABBIT',
                    'RAT', 'CHICKEN', 'HARE', 'MONGOOSE', 'CAT', 'PIGLET',
                    'DOG', 'GOAT', 'FAWN'];

/* What the arena stocks. `w` is a relative spawn weight, so the big game is
   genuinely uncommon: with ~950 animals in the world you can expect roughly
   one fawn and a couple of goats out there at any moment, which is what makes
   crossing the map for one worth doing. */
const ARENA_FOOD = [
    { k: 'APPLE',    w: 300,  grow: 1,  pts: 10   },
    { k: 'EGG',      w: 150,  grow: 1,  pts: 15   },
    { k: 'MOUSE',    w: 240,  grow: 2,  pts: 20   },
    { k: 'FROG',     w: 130,  grow: 2,  pts: 30   },
    { k: 'LIZARD',   w: 100,  grow: 3,  pts: 40   },
    { k: 'RABBIT',   w: 70,   grow: 4,  pts: 60   },
    { k: 'RAT',      w: 55,   grow: 5,  pts: 80   },
    { k: 'CHICKEN',  w: 30,   grow: 7,  pts: 140  },
    { k: 'HARE',     w: 20,   grow: 9,  pts: 200  },
    { k: 'MONGOOSE', w: 14,   grow: 11, pts: 260  },
    { k: 'CAT',      w: 9,    grow: 14, pts: 360  },
    { k: 'PIGLET',   w: 6,    grow: 18, pts: 480  },
    { k: 'DOG',      w: 4.5,  grow: 23, pts: 650  },
    { k: 'GOAT',     w: 2.5,  grow: 28, pts: 820  },
    { k: 'FAWN',     w: 1.5,  grow: 35, pts: 1100 }
];
const RARE = { CAT: 1, PIGLET: 1, DOG: 1, GOAT: 1, FAWN: 1 };
const ARENA_TOTAL = ARENA_FOOD.reduce((a, b) => a + b.w, 0);
const PREY_GROWTH = {}, PREY_POINTS = {};
ARENA_FOOD.forEach(a => { PREY_GROWTH[a.k] = a.grow; PREY_POINTS[a.k] = a.pts; });

function rollFood() {
    let r = Math.random() * ARENA_TOTAL;
    for (let i = 0; i < ARENA_FOOD.length; i++) {
        r -= ARENA_FOOD[i].w;
        if (r <= 0) return ARENA_FOOD[i].k;
    }
    return 'APPLE';
}
const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

const levelOf = len => 1 + Math.floor(Math.max(0, len - START_LEN) / SEG_PER_LEVEL);

/* ==================== world state ==================== */
let nextId = 1;
const players = new Map();           // id -> player
const food = new Map();              // key "x,y" -> {x,y,kind}
const powers = new Map();            // key -> {x,y,kind}
const occupied = new Map();          // "x,y" -> playerId, rebuilt each tick

const key = (x, y) => x + ',' + y;
const rnd = n => Math.floor(Math.random() * n);

/* Food lives in a bucket grid as well as the flat map. Every player's view,
   every prize scan and every bot's search used to walk the whole food
   collection; at 3,600 animals and thirty-odd snakes that is millions of
   comparisons a second and the tick would not hold. Bucketing turns each of
   those into a handful of cells. */
const BUCKET = 20;
const BCOLS = Math.ceil(W / BUCKET);
const foodBuckets = new Map();
const bucketOf = (x, y) => ((y / BUCKET) | 0) * BCOLS + ((x / BUCKET) | 0);

function addFood(x, y, kind) {
    const k = key(x, y);
    if (food.has(k)) return;
    const item = { x: x, y: y, kind: kind };
    food.set(k, item);
    const b = bucketOf(x, y);
    let set = foodBuckets.get(b);
    if (!set) { set = new Map(); foodBuckets.set(b, set); }
    set.set(k, item);
}

function removeFood(k) {
    const item = food.get(k);
    if (!item) return null;
    food.delete(k);
    const set = foodBuckets.get(bucketOf(item.x, item.y));
    if (set) set.delete(k);
    return item;
}

/* Visit every food item within `r` cells of (cx, cy). */
function forEachFoodNear(cx, cy, r, fn) {
    const x0 = Math.max(0, ((cx - r) / BUCKET) | 0), x1 = Math.min(BCOLS - 1, ((cx + r) / BUCKET) | 0);
    const y0 = Math.max(0, ((cy - r) / BUCKET) | 0), y1 = Math.min(Math.ceil(H / BUCKET) - 1, ((cy + r) / BUCKET) | 0);
    for (let by = y0; by <= y1; by++)
        for (let bx = x0; bx <= x1; bx++) {
            const set = foodBuckets.get(by * BCOLS + bx);
            if (!set) continue;
            set.forEach(f => {
                if (Math.abs(f.x - cx) <= r && Math.abs(f.y - cy) <= r) fn(f);
            });
        }
}

function freeCell(margin) {
    margin = margin || 2;
    for (let tries = 0; tries < 400; tries++) {
        const x = margin + rnd(W - margin * 2), y = margin + rnd(H - margin * 2);
        if (!occupied.has(key(x, y)) && !food.has(key(x, y)) && !powers.has(key(x, y)))
            return { x: x, y: y };
    }
    for (let y = margin; y < H - margin; y++)
        for (let x = margin; x < W - margin; x++)
            if (!occupied.has(key(x, y)) && !food.has(key(x, y)) && !powers.has(key(x, y)))
                return { x, y };
    return null;
}

function spawnFood() {
    while (food.size < FOOD_TARGET) {
        const c = freeCell();
        if (!c) break;
        // rarer animals are worth more and grow you a great deal faster
        addFood(c.x, c.y, rollFood());
    }
}

function spawnPowers() {
    while (powers.size < POWER_TARGET) {
        const c = freeCell(6);
        if (!c) break;
        powers.set(key(c.x, c.y), {
            x: c.x, y: c.y, kind: Math.random() < 0.5 ? 'shield' : 'frenzy'
        });
    }
}

/* A spawn point with elbow room, so nobody materialises inside a big snake. */
function safeSpawn() {
    const fits = (x, y, d, roomy) => {
        const dir = DIRS[d];
        for (let i = -START_LEN + 1; i <= RESPAWN_CLEAR; i++) {
            const cx = x + dir.x * i, cy = y + dir.y * i;
            if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1 || occupied.has(key(cx, cy))) return false;
        }
        if (roomy)
            for (let dy = -RESPAWN_CLEAR; dy <= RESPAWN_CLEAR; dy++)
                for (let dx = -RESPAWN_CLEAR; dx <= RESPAWN_CLEAR; dx++)
                    if (occupied.has(key(x + dx, y + dy))) return false;
        return true;
    };
    for (let tries = 0; tries < 500; tries++) {
        const x = 8 + rnd(W - 16), y = 8 + rnd(H - 16);
        const d = rnd(4);
        if (fits(x, y, d, true)) return { x, y, d };
    }
    // A crowded arena may have no safe spawn. Never fall back to an overlap.
    for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++)
            for (let d = 0; d < 4; d++)
                if (fits(x, y, d, false)) return { x, y, d };
    return null;
}

function makeSnake(p) {
    rebuildOccupancy();
    const s = safeSpawn();
    if (!s) return false;
    const d = s.d;
    p.dir = d;
    p.wish = d;
    p.turns = [];
    p.body = [];
    for (let i = 0; i < START_LEN; i++)
        p.body.push({ x: s.x - DIRS[d].x * i, y: s.y - DIRS[d].y * i });
    p.alive = true;
    p.grow = 0;
    p.shieldUntil = 0;
    p.frenzyUntil = 0;
    p.moveAcc = 0;
    p.spawnedAt = Date.now();
    p.best = START_LEN;
    p.deathCause = null;
    p.killedBy = null;
    for (const c of p.body) {
        occupied.set(key(c.x, c.y), p.id);
        removeFood(key(c.x, c.y));
        powers.delete(key(c.x, c.y));
    }
    return true;
}
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function addPlayer(opts) {
    const p = {
        id: nextId++,
        name: typeof opts.name === 'string' ? opts.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 14) || 'Snake' : 'Snake',
        species: WILD.includes(opts.species) || opts.species === 'custom' ? opts.species : 'grassSnake',
        skin: cleanSkin(opts.skin),
        bot: !!opts.bot,
        ws: opts.ws || null,
        score: 0, kills: 0, best: 0,
        alive: false, deadAt: 0
    };
    players.set(p.id, p);
    if (!makeSnake(p)) { players.delete(p.id); return null; }
    return p;
}

function cleanSkin(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const skin = {};
    for (const field of ['base', 'mark', 'pattern', 'eye', 'pupil'])
        if (typeof value[field] === 'string' && /^[a-zA-Z]{1,24}$/.test(value[field])) skin[field] = value[field];
    return skin;
}

function queueTurn(p, d) {
    if (!Number.isInteger(d) || d < 0 || d > 3 || p.turns.length >= 2) return;
    const last = p.turns.length ? p.turns[p.turns.length - 1] : p.dir;
    if (d !== last && d !== (last + 2) % 4) p.turns.push(d);
}

/* ==================== simulation ==================== */
function rebuildOccupancy() {
    occupied.clear();
    players.forEach(p => {
        if (!p.alive) return;
        for (let i = 0; i < p.body.length; i++)
            occupied.set(key(p.body[i].x, p.body[i].y), p.id);
    });
}

function bodyToFood(p) {
    // A kill should be worth something: drop most of the loser as prey.
    for (let i = 0; i < p.body.length; i += 2) {
        const c = p.body[i];
        if (c.x < 1 || c.y < 1 || c.x >= W - 1 || c.y >= H - 1) continue;
        const k = key(c.x, c.y);
        if (food.has(k) || powers.has(k)) continue;
        addFood(c.x, c.y, i % 6 === 0 ? 'MOUSE' : 'APPLE');
    }
}

function killPlayer(p, cause) {
    if (!p.alive) return;
    p.alive = false;
    p.deadAt = Date.now();
    p.cause = cause;
    p.best = Math.max(p.best, p.body.length);
    bodyToFood(p);
    p.body = [];
    if (p.ws) send(p.ws, { t: 'died', cause: cause, score: p.score, kills: p.kills,
                           level: levelOf(p.best), place: aliveCount() + 1 });
}

const aliveCount = () => { let n = 0; players.forEach(p => { if (p.alive) n++; }); return n; };

function tick() {
    const now = Date.now();
    rebuildOccupancy();
    players.forEach(p => { if (p.bot && p.alive) botThink(p); });

    // Frenzy gives an extra move, which is what makes it feel dangerous.
    const movers = [];
    players.forEach(p => {
        if (!p.alive) return;
        const speed = now < p.frenzyUntil ? 1.7 : 1;
        p.moveAcc += speed;
        while (p.moveAcc >= 1) { p.moveAcc -= 1; movers.push(p); }
    });

    // Resolve one step at a time so a frenzied snake's extra move is a real move
    const rounds = movers.length ? Math.max(...countPer(movers)) : 0;
    for (let r = 0; r < rounds; r++) {
        const stepping = [];
        const seen = new Map();
        for (const p of movers) {
            const n = (seen.get(p.id) || 0);
            if (n === r) { stepping.push(p); }
            seen.set(p.id, n + 1);
        }
        stepOnce(stepping, now);
    }

    rebuildOccupancy();
    maintainBots();
    spawnFood();
    spawnPowers();
    broadcast();
}

function countPer(list) {
    const m = new Map();
    for (const p of list) m.set(p.id, (m.get(p.id) || 0) + 1);
    return Array.from(m.values());
}

function stepOnce(list, now) {
    if (!list.length) return;
    rebuildOccupancy();

    const heads = new Map();     // "x,y" -> [players moving there this step]
    const intent = [];

    for (const p of list) {
        if (!p.alive) continue;
        // honour the queued turn unless it is a reversal
        if (!p.bot && p.turns.length) p.wish = p.turns.shift();
        const d = DIRS[p.wish];
        const cur = DIRS[p.dir];
        if (!(d.x === -cur.x && d.y === -cur.y)) p.dir = p.wish;
        const dd = DIRS[p.dir];
        const nx = p.body[0].x + dd.x, ny = p.body[0].y + dd.y;
        intent.push({ p: p, x: nx, y: ny });
        const k = key(nx, ny);
        if (!heads.has(k)) heads.set(k, []);
        heads.get(k).push(p);
    }

    const doomed = new Set();
    const intents = new Map(intent.map(it => [it.p.id, it]));
    const strength = p => now < p.shieldUntil ? Infinity : levelOf(p.body.length);
    const eliminate = (loser, winner, cause) => {
        doomed.add(loser.id);
        loser.deathCause = cause;
        // A victim grants one reward, even when several snakes hit it together.
        const prior = players.get(loser.killedBy);
        if (winner && (!prior || strength(winner) > strength(prior) ||
            (strength(winner) === strength(prior) && winner.id < prior.id))) loser.killedBy = winner.id;
    };
    const fight = (a, b) => {
        const sa = strength(a), sb = strength(b);
        if (sa > sb) eliminate(b, a, 'outsized in a collision');
        else if (sa < sb) eliminate(a, b, 'outsized in a collision');
        else {
            const cause = sa === Infinity ? 'two shields cancelled each other' : 'a mutual kill';
            eliminate(a, null, cause); eliminate(b, null, cause);
        }
    };

    // Resolve every contested destination using the same rules as body hits.
    for (const contenders of heads.values()) {
        if (contenders.length < 2) continue;
        const top = Math.max(...contenders.map(strength));
        const leaders = contenders.filter(p => strength(p) === top);
        for (const p of contenders) {
            if (leaders.length === 1 && p === leaders[0]) continue;
            eliminate(p, leaders.length === 1 ? leaders[0] : null,
                      top === Infinity && leaders.length > 1 ? 'two shields cancelled each other' : 'lost a head-on');
        }
    }

    for (const it of intent) {
        const p = it.p;
        if (it.x < 1 || it.y < 1 || it.x >= W - 1 || it.y >= H - 1) {
            eliminate(p, null, 'stopped by the wall');
            continue;
        }
        const other = players.get(occupied.get(key(it.x, it.y)));
        if (!other || !other.alive) continue;
        const tail = other.body[other.body.length - 1];
        const move = intents.get(other.id);
        // Eating on this step keeps the tail in place, even with no queued growth.
        const vacating = tail.x === it.x && tail.y === it.y && move &&
                         other.grow <= 0 && !food.has(key(move.x, move.y));
        if (vacating) continue;
        if (other === p) eliminate(p, null, 'coiled into yourself');
        else fight(p, other);
    }

    // advance the survivors
    for (const it of intent) {
        const p = it.p;
        if (doomed.has(p.id) || !p.alive) continue;
        p.body.unshift({ x: it.x, y: it.y });

        const fk = key(it.x, it.y);
        const f = food.get(fk);
        if (f) {
            removeFood(fk);
            const mult = now < p.frenzyUntil ? 2 : 1;
            const gained = PREY_GROWTH[f.kind] * mult;
            p.grow += gained;
            p.score += PREY_POINTS[f.kind] * mult;
            p.lastAte = now;
            if (RARE[f.kind] && p.ws) send(p.ws, { t: 'feast', kind: f.kind, grow: gained });
        }
        const pw = powers.get(fk);
        if (pw) {
            powers.delete(fk);
            if (pw.kind === 'shield') p.shieldUntil = now + SHIELD_MS;
            else p.frenzyUntil = now + FRENZY_MS;
            if (p.ws) send(p.ws, { t: 'pickup', kind: pw.kind });
        }
        if (p.grow > 0) p.grow--; else p.body.pop();
        p.best = Math.max(p.best || 0, p.body.length);
    }

    doomed.forEach(id => {
        const p = players.get(id);
        if (!p) return;
        const killer = p.killedBy && players.get(p.killedBy);
        if (killer && killer.id !== p.id) { killer.kills++; killer.score += 120; }
        p.killedBy = null;
        const cause = killer ? ('eaten by ' + killer.name) : (p.deathCause || 'lost in the arena');
        p.deathCause = null;
        killPlayer(p, cause);
    });
}

/* ==================== bots ==================== */
function botThink(p) {
    const head = p.body[0];
    const myLevel = levelOf(p.body.length);
    let bestDir = p.dir, bestScore = -Infinity;
    for (let d = 0; d < 4; d++) {
        const cur = DIRS[p.dir];
        if (DIRS[d].x === -cur.x && DIRS[d].y === -cur.y) continue;
        const nx = head.x + DIRS[d].x, ny = head.y + DIRS[d].y;
        if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
        const hit = occupied.get(key(nx, ny));
        if (hit !== undefined) {
            const other = players.get(hit);
            // only barge into someone smaller
            if (!other || levelOf(other.body.length) >= myLevel) continue;
        }
        let s = Math.random() * 0.6;
        s += lookAhead(nx, ny, DIRS[d], 7) * 0.9;        // room to keep going
        const near = nearestFood(nx, ny, 22);
        if (near) s += (22 - near.dist) * 0.55;
        if (bestScore < s) { bestScore = s; bestDir = d; }
    }
    p.wish = bestDir;
}

function lookAhead(x, y, d, n) {
    let free = 0;
    for (let i = 1; i <= n; i++) {
        const cx = x + d.x * i, cy = y + d.y * i;
        if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) break;
        if (occupied.has(key(cx, cy))) break;
        free++;
    }
    return free;
}

function nearestFood(x, y, radius) {
    let best = null;
    forEachFoodNear(x, y, radius, f => {
        const d = Math.abs(f.x - x) + Math.abs(f.y - y);
        if (d <= radius && (!best || d < best.dist)) best = { f: f, dist: d };
    });
    return best;
}

const BOT_NAMES = ['Rustle', 'Coil', 'Fang', 'Sidewind', 'Nettle', 'Bramble',
                   'Ash', 'Quill', 'Slate', 'Hazel', 'Ember', 'Vane'];
const WILD = ['grassSnake', 'emeraldBoa', 'sidewinder', 'cornSnake', 'leucisticPython',
              'cottonmouth', 'blackMamba', 'milkSnake', 'blueCoral', 'rainbowBoa'];

function maintainBots() {
    let bots = 0, humans = 0;
    players.forEach(p => { if (p.bot) bots++; else humans++; });
    const want = Math.max(3, BOT_TARGET - humans);
    if (bots < want) {
        addPlayer({ bot: true,
                    name: BOT_NAMES[rnd(BOT_NAMES.length)],
                    species: WILD[rnd(WILD.length)] });
    }
    // dead bots come straight back so the arena stays busy
    players.forEach(p => {
        if (p.bot && !p.alive && Date.now() - p.deadAt > 2500) {
            p.score = Math.floor(p.score * 0.4);
            makeSnake(p);
        }
        if (p.bot && bots > want + 2 && !p.alive) players.delete(p.id);
    });
}

/* ==================== what each client is told ====================
   Only what a player could see is sent. The world is 200x200 but a client
   shows about 25 cells across, so shipping the whole arena every tick would be
   wasteful and would also hand players a wallhack. */
const VIEW = 26;

function nearView(hx, hy, x, y) {
    return Math.abs(x - hx) <= VIEW && Math.abs(y - hy) <= VIEW;
}

function leaderboard() {
    const rows = [];
    players.forEach(p => rows.push({
        id: p.id, name: p.name, lv: levelOf(p.alive ? p.body.length : p.best || START_LEN),
        sc: p.score, k: p.kills, alive: p.alive
    }));
    rows.sort((a, b) => b.sc - a.sc);
    return rows.slice(0, 6);
}

function viewFor(p) {
    const now = Date.now();
    const head = p.alive ? p.body[0] : { x: W >> 1, y: H >> 1 };
    const snakes = [];
    players.forEach(q => {
        if (!q.alive) return;
        let visible = q.id === p.id;
        if (!visible)
            for (let i = 0; i < q.body.length; i += 2)
                if (nearView(head.x, head.y, q.body[i].x, q.body[i].y)) { visible = true; break; }
        if (!visible) return;
        const seg = [];
        for (let i = 0; i < q.body.length; i++) seg.push(q.body[i].x, q.body[i].y);
        snakes.push({
            id: q.id, n: q.name, sp: q.species, sk: q.skin,
            lv: levelOf(q.body.length), b: seg,
            sh: now < q.shieldUntil ? q.shieldUntil - now : 0,
            fr: now < q.frenzyUntil ? q.frenzyUntil - now : 0,
            me: q.id === p.id ? 1 : 0
        });
    });

    const fd = [];
    forEachFoodNear(head.x, head.y, VIEW, f => fd.push(f.x, f.y, PREY_KINDS.indexOf(f.kind)));
    const pw = [];
    powers.forEach(q => { if (nearView(head.x, head.y, q.x, q.y)) pw.push(q.x, q.y, q.kind === 'shield' ? 0 : 1); });

    // every snake's head, for the minimap
    const blips = [];
    players.forEach(q => { if (q.alive) blips.push(q.body[0].x, q.body[0].y, q.id === p.id ? 1 : 0); });

    // Rare quarry within a wider radius than you can see, so big game is
    // findable at all. Without this a fawn in a 200x200 world is a rumour.
    const PRIZE_RANGE = 70;
    const prizes = [];
    forEachFoodNear(head.x, head.y, PRIZE_RANGE, f => {
        if (RARE[f.kind]) prizes.push(f.x, f.y);
    });

    return {
        t: 'state', tick: Date.now(),
        you: { id: p.id, alive: p.alive, lv: p.alive ? levelOf(p.body.length) : 0,
               len: p.alive ? p.body.length : 0, score: p.score, kills: p.kills,
               sh: now < p.shieldUntil ? p.shieldUntil - now : 0,
               fr: now < p.frenzyUntil ? p.frenzyUntil - now : 0 },
        s: snakes, f: fd, p: pw, m: blips, big: prizes,
        alive: aliveCount(), lb: leaderboard()
    };
}

function broadcast() {
    players.forEach(p => {
        if (!p.ws || p.ws.dead) return;
        send(p.ws, viewFor(p));
    });
}

/* ==================== WebSocket (RFC 6455, by hand) ====================
   Only what this game needs: a text channel with ping/pong and close. Server
   frames go out unmasked; client frames arrive masked and are unmasked here. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4096;
const MAX_BUFFERED = 512 * 1024;
const sockets = new Set();

function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function send(ws, obj) {
    if (ws.dead || ws.socket.destroyed) return;
    if (ws.socket.writableLength > MAX_BUFFERED) { ws.socket.destroy(); return; }
    const payload = Buffer.from(JSON.stringify(obj));
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(len, 6);
    }
    header[0] = 0x81;                      // FIN + text
    try { ws.socket.write(Buffer.concat([header, payload])); }
    catch (e) { ws.dead = true; }
}

function sendControl(ws, opcode, payload) {
    payload = payload || Buffer.alloc(0);
    const h = Buffer.alloc(2);
    h[0] = 0x80 | opcode;
    h[1] = payload.length;
    try { ws.socket.write(Buffer.concat([h, payload])); } catch (e) { ws.dead = true; }
}

function attachSocket(socket, onMessage, onClose) {
    const ws = { socket, dead: false, lastPong: Date.now() };
    sockets.add(ws);
    let buf = Buffer.alloc(0), fragments = [], fragmentBytes = 0;
    let inMessage = false, closed = false, rateStart = Date.now(), frames = 0;
    const finish = () => {
        if (closed) return;
        closed = true; ws.dead = true; sockets.delete(ws); onClose();
    };
    const reject = code => {
        if (ws.dead) return;
        const data = Buffer.alloc(2); data.writeUInt16BE(code);
        sendControl(ws, 0x8, data);
        finish(); socket.end();
        // A peer that never finishes closing must not retain a socket forever.
        socket.setTimeout(1000, () => socket.destroy());
    };
    ws.receive = chunk => {
        if (ws.dead) return;
        // Bound pending input as well as the size of each complete message.
        if (buf.length + chunk.length > MAX_MESSAGE * 4) { reject(1009); return; }
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            if (Date.now() - rateStart >= 1000) { frames = 0; rateStart = Date.now(); }
            const b0 = buf[0], b1 = buf[1], opcode = b0 & 15, fin = !!(b0 & 128);
            if ((b0 & 112) || !(b1 & 128) || ![0, 1, 8, 9, 10].includes(opcode)) { reject(1002); return; }
            let len = b1 & 127, off = 2;
            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2); off = 4;
                if (len < 126) { reject(1002); return; }
            } else if (len === 127) {
                if (buf.length < 10) return;
                // Every 64-bit payload exceeds this game's 4 KiB message limit.
                reject(1009); return;
            }
            const control = opcode >= 8;
            if (control && (!fin || len > 125 || (opcode === 8 && len === 1))) { reject(1002); return; }
            if (len + (control ? 0 : fragmentBytes) > MAX_MESSAGE) { reject(1009); return; }
            if (buf.length < off + 4 + len) return;
            if (++frames > 120) { reject(1008); return; }
            const mask = buf.subarray(off, off + 4); off += 4;
            const data = Buffer.from(buf.subarray(off, off + len));
            buf = buf.subarray(off + len);
            for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
            if (opcode === 8) { sendControl(ws, 8); finish(); socket.end(); return; }
            if (opcode === 9) { sendControl(ws, 10, data); continue; }
            if (opcode === 10) { ws.lastPong = Date.now(); continue; }
            if ((opcode === 0 && !inMessage) || (opcode === 1 && inMessage)) { reject(1002); return; }
            fragments.push(data); fragmentBytes += data.length; inMessage = !fin;
            if (!fin) continue;
            let msg;
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(fragments));
                msg = JSON.parse(text);
            } catch (e) { reject(1007); return; }
            fragments = []; fragmentBytes = 0;
            if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') { reject(1008); return; }
            onMessage(msg);
            if (ws.dead) return;
        }
    };
    socket.on('data', ws.receive);
    socket.on('error', finish);
    socket.on('close', finish);
    socket.setNoDelay(true);
    return ws;
}

/* ==================== HTTP + upgrade ==================== */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); }
    catch (e) { res.writeHead(400).end('Invalid URL'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('Method not allowed'); return; }
    if (rel === '/' ) rel = '/index.html';
    if (rel === '/favicon.ico') { res.writeHead(204).end(); return; }
    // Serve game assets only; source, tests and repository metadata stay private.
    if (!['/index.html', '/battle.html'].includes(rel)) { res.writeHead(404).end('Not found'); return; }
    const file = path.join(ROOT, rel);
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                             'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
    });
});

server.on('upgrade', (req, socket, head) => {
    const wsKey = req.headers['sec-websocket-key'];
    let originOK = !req.headers.origin || req.headers.origin === 'null';
    try { if (req.headers.origin && req.headers.origin !== 'null') originOK = new URL(req.headers.origin).host === req.headers.host; } catch (e) { }
    if (req.method !== 'GET' || !['/', '/arena'].includes(req.url) ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
        typeof wsKey !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(wsKey) || !originOK || sockets.size >= 128) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + acceptKey(wsKey) + '\r\n\r\n');

    let player = null;
    const ws = attachSocket(socket,
        msg => {
            if (msg.t === 'join') {
                if (player) return;
                player = addPlayer({ ws: ws, name: msg.name, species: msg.species, skin: msg.skin });
                if (!player) { send(ws, { t: 'error', message: 'Arena full. Try again shortly.' }); return; }
                send(ws, { t: 'welcome', id: player.id, w: W, h: H, view: VIEW,
                           tick: TICK_MS, shieldMs: SHIELD_MS, frenzyMs: FRENZY_MS });
            } else if (msg.t === 'dir' && player && player.alive) {
                queueTurn(player, msg.d);
            } else if (msg.t === 'respawn' && player && !player.alive) {
                if (makeSnake(player)) { player.score = 0; player.kills = 0; }
                else send(ws, { t: 'error', message: 'No safe spawn available. Try again shortly.' });
            }
        },
        () => { if (player) { players.delete(player.id); player = null; } });
    if (head && head.length) ws.receive(head);
});

server.listen(PORT, () => {
    const port = server.address().port;
    let nets = {};
    try { nets = os.networkInterfaces(); }
    catch (e) { console.warn('LAN address discovery unavailable; use this computer\'s IP address.'); }
    const lan = [];
    Object.keys(nets).forEach(n => (nets[n] || []).forEach(a => {
        if (a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }));
    console.log('');
    console.log('  Serpent — Battle Royale');
    console.log('  arena ' + W + ' x ' + H + ' cells, ' + (1000 / TICK_MS).toFixed(1) + ' ticks/s');
    console.log('');
    console.log('  play here     http://localhost:' + port);
    lan.forEach(a => console.log('  same network  http://' + a + ':' + port));
    console.log('');
    console.log('  Open the page, choose Battle Royale, and share the address.');
    console.log('  Ctrl-C to stop.');
    console.log('');
});

spawnFood();
spawnPowers();
maintainBots();
setInterval(tick, TICK_MS);
setInterval(() => {
    const now = Date.now();
    for (const ws of sockets) {
        if (now - ws.lastPong > 45000) ws.socket.destroy();
        else sendControl(ws, 9);
    }
}, 15000);
