'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ROOT = path.join(__dirname, '..');

class Socket extends EventEmitter {
    constructor() { super(); this.writes = []; this.writableLength = 0; this.destroyed = false; }
    write(data) { this.writes.push(Buffer.from(data)); return true; }
    end(data) { if (data) this.write(data); this.ended = true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    setNoDelay() {}
    setTimeout() {}
}
function server() {
    let httpHandler;
    const httpServer = new EventEmitter(); httpServer.listen = () => {};
    const context = {
        Buffer, TextDecoder, URL, __dirname: ROOT, process: { env: {} },
        setInterval() {}, console: { log() {} },
        require: name => name === 'http' ? { createServer(fn) { httpHandler = fn; return httpServer; } } : require(name)
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8') + `
        globalThis.api = {players,food,foodBuckets,powers,occupied,addFood,addPlayer,makeSnake,
            safeSpawn,freeCell,queueTurn,stepOnce,attachSocket,send,DIRS,viewFor,rebuildOccupancy};
    `, context);
    const a = context.api;
    for (const name of ['players','food','foodBuckets','powers','occupied']) a[name].clear();
    a.httpHandler = httpHandler; a.httpServer = httpServer;
    a.player = (x, y, dir, len = 6, shield = false) => {
        const p = a.addPlayer({ name: 'Test' });
        p.body = Array.from({length: len}, (_, i) => ({ x: x - a.DIRS[dir].x * i, y: y - a.DIRS[dir].y * i }));
        p.dir = p.wish = dir; p.shieldUntil = shield ? Date.now() + 8000 : 0;
        return p;
    };
    return a;
}
function frame(value, {opcode = 1, fin = true, masked = true} = {}) {
    const data = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const extended = data.length >= 126;
    const header = Buffer.alloc(extended ? 4 : 2);
    header[0] = (fin ? 128 : 0) | opcode;
    header[1] = (masked ? 128 : 0) | (extended ? 126 : data.length);
    if (extended) header.writeUInt16BE(data.length, 2);
    // A zero mask is valid, and keeps fixtures readable.
    return Buffer.concat([header, ...(masked ? [Buffer.alloc(4)] : []), data]);
}

test('a shield wins a head-on against a larger snake and earns one reward', () => {
    const a = server(), small = a.player(40,40,0,6,true), big = a.player(42,40,2,16);
    a.stepOnce([small,big], Date.now());
    assert.equal(small.alive,true); assert.equal(big.alive,false);
    assert.equal(small.kills,1); assert.equal(small.score,120);
});
test('larger head-on winner earns kill and score', () => {
    const a = server(), big = a.player(40,40,0,16), small = a.player(42,40,2);
    a.stepOnce([big,small],Date.now());
    assert.equal(big.kills,1); assert.equal(big.score,120); assert.equal(small.alive,false);
});
for (const shield of [false,true]) test(`equal head-on contenders both die (shield=${shield})`, () => {
    const a = server(), x = a.player(40,40,0,6,shield), y = a.player(42,40,2,6,shield);
    a.stepOnce([x,y],Date.now()); assert.equal(x.alive,false); assert.equal(y.alive,false);
    assert.equal(x.kills+y.kills,0);
});
test('a three-way head-on awards each defeated snake only once', () => {
    const a=server(), winner=a.player(40,40,0,16), x=a.player(42,40,2), y=a.player(41,39,1);
    a.stepOnce([winner,x,y],Date.now()); assert.equal(winner.alive,true); assert.equal(winner.kills,2);
});
test('swapping head positions resolves a collision', () => {
    const a=server(), x=a.player(40,40,0,16), y=a.player(41,40,2);
    a.stepOnce([x,y],Date.now()); assert.equal(x.alive,true); assert.equal(y.alive,false); assert.equal(x.kills,1);
});
for (const eating of [false,true]) test(`tail occupancy accounts for eating=${eating}`, () => {
    const a=server(), owner=a.player(40,40,0), follower=a.player(34,40,0);
    if(eating) a.addFood(41,40,'APPLE');
    a.stepOnce([owner,follower],Date.now());
    assert.equal(owner.alive,!eating); assert.equal(follower.alive,!eating);
    if(!eating) assert.equal(owner.body.some(c=>follower.body.some(d=>c.x===d.x&&c.y===d.y)),false);
});
test('shield does not protect against walls or self collision', () => {
    const a=server(), wall=a.player(1,40,2,6,true);
    a.stepOnce([wall],Date.now()); assert.equal(wall.alive,false);
    const self=a.player(40,40,0,6,true); self.body[3]={x:41,y:40};
    a.stepOnce([self],Date.now()); assert.equal(self.alive,false);
});
test('two buffered turns retain order and reject reversals', () => {
    const a=server(), p=a.player(40,40,0);
    a.queueTurn(p,2); a.queueTurn(p,3); a.queueTurn(p,2); a.queueTurn(p,1);
    assert.deepEqual(Array.from(p.turns),[3,2]);
    a.stepOnce([p],Date.now()); assert.equal(p.dir,3);
    a.stepOnce([p],Date.now()); assert.equal(p.dir,2);
});
test('spawn footprint and runway are clear across consecutive joins', () => {
    const a=server();
    for(let i=0;i<100;i++) {
        const before=new Set(a.occupied.keys()), p=a.addPlayer({name:'Player'});
        assert.ok(p); assert.equal(new Set(p.body.map(c=>c.x+','+c.y)).size,6);
        for(const c of p.body) assert.equal(before.has(c.x+','+c.y),false);
        for(let n=1;n<=4;n++) assert.equal(before.has((p.body[0].x+a.DIRS[p.dir].x*n)+','+(p.body[0].y+a.DIRS[p.dir].y*n)),false);
    }
});
test('full arena returns no spawn or food cell instead of overlapping', () => {
    const a=server();
    for(let y=0;y<400;y++) for(let x=0;x<400;x++) a.occupied.set(x+','+y,1);
    assert.equal(a.safeSpawn(),null); assert.equal(a.freeCell(),null);
});
test('invalid names, species and skin fields are safely normalized', () => {
    const a=server(), p=a.addPlayer({name:123,species:'__proto__',skin:{base:'emerald',mark:{bad:true},junk:'discard'}});
    assert.equal(p.name,'Snake'); assert.equal(p.species,'grassSnake');
    assert.deepEqual(JSON.parse(JSON.stringify(p.skin)),{base:'emerald'});
});
test('respawn resets best length and does not inherit old kill attribution', () => {
    const a=server(), p=a.player(40,40,0,30); p.alive=false;p.best=30;p.killedBy=123;
    assert.equal(a.makeSnake(p),true);assert.equal(p.best,6);assert.equal(p.killedBy,null);
});
test('malformed HTTP URLs return 400 without throwing', () => {
    const a=server(); let code;
    a.httpHandler({url:'/%E0%A4%A',method:'GET'},{writeHead(c){code=c;return this;},end(){}});
    assert.equal(code,400);
});
test('HTTP cannot expose source or repository metadata', () => {
    const a=server();
    for(const url of ['/server.js','/.git/config','/../server.js','/tests/regression.test.js']) {
        let code;a.httpHandler({url,method:'GET'},{writeHead(c){code=c;return this;},end(){}});assert.equal(code,404);
    }
});
test('fragmented and split TCP messages decode once, with interleaved ping', () => {
    const a=server(), socket=new Socket(), messages=[];
    a.attachSocket(socket,m=>messages.push(m),()=>{});
    const one=frame('{"t":',{fin:false});socket.emit('data',one.subarray(0,3));socket.emit('data',one.subarray(3));
    socket.emit('data',frame('ping',{opcode:9}));socket.emit('data',frame('"join"}',{opcode:0}));
    assert.equal(messages.length,1);assert.equal(messages[0].t,'join');assert.equal(socket.writes[0][0],138);
});
for(const [label,data] of [
    ['unmasked',frame({t:'join'},{masked:false})],
    ['oversized',Buffer.from([129,254,32,0])],
    ['bad JSON',frame('{')],
    ['array message',frame('[]')],
    ['unexpected continuation',frame('{}',{opcode:0})],
    ['fragmented ping',frame('p',{opcode:9,fin:false})]
]) test(`invalid WebSocket input closes only that connection: ${label}`, () => {
    const a=server(), socket=new Socket();let closed=0,messages=0;
    const ws=a.attachSocket(socket,()=>messages++,()=>closed++);
    socket.emit('data',data);socket.emit('close');socket.emit('error',new Error('closed'));
    assert.equal(ws.dead,true);assert.equal(messages,0);assert.equal(closed,1);
});
test('slow consumers are disconnected before queues grow without bound', () => {
    const a=server(), socket=new Socket();socket.writableLength=600000;
    a.send({socket,dead:false},{t:'state'});assert.equal(socket.destroyed,true);
});
test('invalid WebSocket upgrade is rejected', () => {
    const a=server(), socket=new Socket();
    a.httpServer.emit('upgrade',{method:'GET',url:'/',headers:{'sec-websocket-key':'bad'}},socket,Buffer.alloc(0));
    assert.ok(socket.writes[0].toString().startsWith('HTTP/1.1 400'));
});

function renderer(file, marker) {
    const html=fs.readFileSync(path.join(ROOT,file),'utf8');
    const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const context={document:{addEventListener(){}},console};vm.createContext(context);
    vm.runInContext(script.slice(0,script.indexOf(marker)),context);
    return context;
}
test('different remote designs retain separate species and texture keys', () => {
    const ctx=renderer('battle.html','/* ==========================================================================\n   BATTLE ROYALE — client');
    const result=vm.runInContext(`(() => {
        const a=arenaSkinKey({id:1,sp:'custom',sk:{base:'emerald'}});
        const b=arenaSkinKey({id:2,sp:'custom',sk:{base:'ivory'}});
        const different=SPECIES[a].dorsal!==SPECIES[b].dorsal;
        const first=SPECIES[a];arenaSkinKey({id:1,sp:'custom',sk:{base:'emerald'}});
        const cached=first===SPECIES[a];pruneArenaSkins([{id:2,sp:'custom'}]);
        return {different,cached,removed:!SPECIES[a],retained:!!SPECIES[b]};
    })()`,ctx);
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{different:true,cached:true,removed:true,retained:true});
});
test('all 150 campaign levels have clear starts, runway and connected ground', () => {
    const ctx=renderer('index.html','/* ==========================================================================\n   GAME\n');
    const result=vm.runInContext(`Array.from({length:LEVEL_COUNT},(_,i)=> {
        const l=buildLevel(i+1),seen=new Set(),queue=[l.start[0]];
        for(let k=0;k<queue.length;k++) {
            const c=queue[k],id=c.y*N+c.x;if(seen.has(id)||l.blocked[id])continue;seen.add(id);
            for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
                let x=c.x+dx,y=c.y+dy;if(l.meta.wrap){x=(x+N)%N;y=(y+N)%N;}
                if(x>=0&&x<N&&y>=0&&y<N&&!seen.has(y*N+x))queue.push({x,y});
            }
        }
        return l.runway>=4&&l.open>=100&&l.start.every(c=>!l.blocked[c.y*N+c.x])&&seen.size===l.open;
    })`,ctx);
    assert.equal(result.length,150);assert.ok(result.every(Boolean));
});
