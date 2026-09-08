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

const PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOT = __dirname;

/* ==================== arena rules ==================== */
const W = 400, H = 400;              // cells — 160,000 of them, 256x the campaign board
const TICK_MS = 90;
const START_LEN = 6;
const FOOD_TARGET = 16000;           // ~1 animal per 10 cells; below this a 400x400 world reads as empty
const POWER_TARGET = 240;            // ~1 per 667 cells; deliberately not scaled with the last food raise
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
   genuinely uncommon: with 16,000 animals in the world you can expect roughly
   twenty-one fawns and thirty-five goats out there at any moment, which is
   what makes crossing the map for one worth doing. */
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
/* Which of those are worth a minimap beacon, as opposed to just a gold halo
   once you can see them. */
const BEACON = { GOAT: 1, FAWN: 1 };
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
   every prize scan and every bot's search would otherwise walk the whole food
   collection. At 3,600 animals that was survivable either way — both versions
   ran a tick in about 4 ms. At 16,000 it is not: the flat scan costs 26 ms a
   tick idle and 29 ms with eight viewers, against 3.2 and 9.5 bucketed, on a
   90 ms budget. Density is what makes this worth having, not world size. */
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
    return { x: rnd(W), y: rnd(H) };
}

function spawnFood() {
    while (food.size < FOOD_TARGET) {
        const c = freeCell();
        // rarer animals are worth more and grow you a great deal faster
        addFood(c.x, c.y, rollFood());
    }
}

function spawnPowers() {
    while (powers.size < POWER_TARGET) {
        const c = freeCell(6);
        powers.set(key(c.x, c.y), {
            x: c.x, y: c.y, kind: Math.random() < 0.5 ? 'shield' : 'frenzy'
        });
    }
}

/* A spawn point with elbow room, so nobody materialises inside a big snake. */
function safeSpawn() {
    for (let tries = 0; tries < 500; tries++) {
        const x = 8 + rnd(W - 16), y = 8 + rnd(H - 16);
        let clear = true;
        for (let dy = -RESPAWN_CLEAR; dy <= RESPAWN_CLEAR && clear; dy++)
            for (let dx = -RESPAWN_CLEAR; dx <= RESPAWN_CLEAR; dx++)
                if (occupied.has(key(x + dx, y + dy))) { clear = false; break; }
        if (clear) return { x: x, y: y };
    }
    return { x: 10 + rnd(W - 20), y: 10 + rnd(H - 20) };
}

function makeSnake(p) {
    const s = safeSpawn();
    const d = rnd(4);
    p.dir = d;
    p.wish = d;
    p.body = [];
    for (let i = 0; i < START_LEN; i++)
        p.body.push({ x: clamp(s.x - DIRS[d].x * i, 1, W - 2),
                      y: clamp(s.y - DIRS[d].y * i, 1, H - 2) });
    p.alive = true;
    p.grow = 0;
    p.shieldUntil = 0;
    p.frenzyUntil = 0;
    p.moveAcc = 0;
    p.spawnedAt = Date.now();
}
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function addPlayer(opts) {
    const p = {
        id: nextId++,
        name: (opts.name || 'Snake').slice(0, 14),
        species: opts.species || 'grassSnake',
        skin: opts.skin || null,
        bot: !!opts.bot,
        ws: opts.ws || null,
        score: 0, kills: 0, best: 0,
        alive: false, deadAt: 0
    };
    players.set(p.id, p);
    makeSnake(p);
    return p;
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

    for (const it of intent) {
        const p = it.p;
        // hard world edge — the arena does not wrap
        if (it.x < 1 || it.y < 1 || it.x >= W - 1 || it.y >= H - 1) {
            p.deathCause = 'stopped by the wall';
            doomed.add(p.id);
            continue;
        }
        const contenders = heads.get(key(it.x, it.y));
        if (contenders && contenders.length > 1) {
            // head-on: the bigger level survives, a tie kills both
            let top = -1, tied = false;
            for (const q of contenders) {
                const lv = levelOf(q.body.length);
                if (lv > top) { top = lv; tied = false; }
                else if (lv === top) tied = true;
            }
            const mine = levelOf(p.body.length);
            const shielded = now < p.shieldUntil;
            if (!shielded && (mine < top || (mine === top && tied))) {
                p.deathCause = mine === top ? 'lost a head-on to an equal' : 'outsized head-on';
                doomed.add(p.id);
            }
            continue;
        }
        const hitId = occupied.get(key(it.x, it.y));
        if (hitId !== undefined) {
            const other = players.get(hitId);
            const tailOf = other && other.alive ? other.body[other.body.length - 1] : null;
            const isVacatingTail = tailOf && tailOf.x === it.x && tailOf.y === it.y &&
                                   list.indexOf(other) !== -1 && other.grow <= 0;
            if (isVacatingTail) continue;          // that cell empties this step
            if (now < p.shieldUntil) {             // shield ploughs through
                if (other && other.id !== p.id) { doomed.add(other.id); other.killedBy = p.id; }
                continue;
            }
            if (other && other.id === p.id) {                                  // ate itself
                p.deathCause = 'coiled into yourself';
                doomed.add(p.id);
                continue;
            }
            const mine = levelOf(p.body.length), theirs = levelOf(other.body.length);
            if (now < other.shieldUntil) {
                p.deathCause = 'broken on ' + other.name + "'s shield";
                doomed.add(p.id);
                continue;
            }
            if (mine > theirs) { doomed.add(other.id); other.killedBy = p.id; }
            else if (mine < theirs) { doomed.add(p.id); p.killedBy = other.id; }
            else {
                p.deathCause = other.deathCause = 'a mutual kill';
                doomed.add(p.id); doomed.add(other.id);
            }
        }
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

    /* Top-tier quarry within a wider radius than you can see, so big game is
       findable at all — without this a fawn out in 160,000 cells is a rumour.
       Only the two best animals get a beacon, and only the nearest few: at
       12,000 animals the whole RARE set inside this radius is ~30 of them, and
       thirty overlapping rings is a gold smear that points at nothing. Cats,
       piglets and dogs still wear their gold halo in the world, so they are
       spotted by looking rather than by map. */
    const PRIZE_RANGE = 70;
    const PRIZE_MAX = 5;
    const found = [];
    forEachFoodNear(head.x, head.y, PRIZE_RANGE, f => {
        if (!BEACON[f.kind]) return;
        const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
        found.push({ x: f.x, y: f.y, d: d });
    });
    found.sort((a, b) => a.d - b.d);
    const prizes = [];
    for (let i = 0; i < found.length && i < PRIZE_MAX; i++) prizes.push(found[i].x, found[i].y);

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

function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function send(ws, obj) {
    if (ws.dead || ws.socket.destroyed) return;
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
    const ws = { socket: socket, dead: false };
    let buf = Buffer.alloc(0);

    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const b0 = buf[0], b1 = buf[1];
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) {
                if (buf.length < off + 2) return;
                len = buf.readUInt16BE(off); off += 2;
            } else if (len === 127) {
                if (buf.length < off + 8) return;
                // payloads that need the high word are not something this game sends
                len = buf.readUInt32BE(off + 4); off += 8;
            }
            let mask = null;
            if (masked) {
                if (buf.length < off + 4) return;
                mask = buf.slice(off, off + 4); off += 4;
            }
            if (buf.length < off + len) return;
            const data = Buffer.from(buf.slice(off, off + len));
            buf = buf.slice(off + len);
            if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];

            if (opcode === 0x8) { ws.dead = true; sendControl(ws, 0x8); socket.end(); onClose(); return; }
            else if (opcode === 0x9) sendControl(ws, 0xA, data);      // ping -> pong
            else if (opcode === 0x1) {
                let msg = null;
                try { msg = JSON.parse(data.toString('utf8')); } catch (e) { /* ignore junk */ }
                if (msg) onMessage(msg);
            }
        }
    });

    socket.on('error', () => { ws.dead = true; onClose(); });
    socket.on('close', () => { ws.dead = true; onClose(); });
    socket.setNoDelay(true);
    return ws;
}

/* ==================== HTTP + upgrade ==================== */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' ) rel = '/index.html';
    if (rel === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                             'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

server.on('upgrade', (req, socket) => {
    const wsKey = req.headers['sec-websocket-key'];
    if (!wsKey) { socket.destroy(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                 'Sec-WebSocket-Accept: ' + acceptKey(wsKey) + '\r\n\r\n');

    let player = null;
    const ws = attachSocket(socket,
        msg => {
            if (msg.t === 'join') {
                if (player) players.delete(player.id);
                player = addPlayer({ ws: ws, name: msg.name, species: msg.species, skin: msg.skin });
                send(ws, { t: 'welcome', id: player.id, w: W, h: H, view: VIEW,
                           tick: TICK_MS, shieldMs: SHIELD_MS, frenzyMs: FRENZY_MS });
            } else if (msg.t === 'dir' && player && player.alive) {
                const d = msg.d | 0;
                if (d >= 0 && d < 4) player.wish = d;
            } else if (msg.t === 'respawn' && player && !player.alive) {
                player.score = 0; player.kills = 0;
                makeSnake(player);
            }
        },
        () => { if (player) { players.delete(player.id); player = null; } });
});

server.listen(PORT, () => {
    const nets = os.networkInterfaces();
    const lan = [];
    Object.keys(nets).forEach(n => (nets[n] || []).forEach(a => {
        if (a.family === 'IPv4' && !a.internal) lan.push(a.address);
    }));
    console.log('');
    console.log('  Serpent — Battle Royale');
    console.log('  arena ' + W + ' x ' + H + ' cells, ' + (1000 / TICK_MS).toFixed(1) + ' ticks/s');
    console.log('');
    console.log('  play here     http://localhost:' + PORT);
    lan.forEach(a => console.log('  same network  http://' + a + ':' + PORT));
    console.log('');
    console.log('  Open the page, choose Battle Royale, and share the address.');
    console.log('  Ctrl-C to stop.');
    console.log('');
});

spawnFood();
spawnPowers();
maintainBots();
setInterval(tick, TICK_MS);
