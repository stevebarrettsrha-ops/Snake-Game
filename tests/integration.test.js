const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('real server accepts two players and survives malformed HTTP and player data', { timeout: 10000 }, async t => {
    const child = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0' }, stdio: ['ignore','pipe','pipe']
    });
    const clients = [];
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { clients.forEach(ws => ws.close()); child.kill(); await exited; });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const port = await new Promise((resolve, reject) => {
        let output = '';
        child.once('error', reject);
        child.once('exit', code => reject(new Error('Server exited: ' + code + '\n' + stderr)));
        child.stdout.on('data', data => {
            output += data;
            const match = output.match(/play here\s+http:\/\/localhost:(\d+)/);
            if (match) resolve(Number(match[1]));
        });
    });
    const get = url => new Promise((resolve,reject) => {
        http.get({hostname:'127.0.0.1',port,path:url}, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
        }).on('error',reject);
    });
    const join = name => new Promise((resolve,reject) => {
        const ws = new WebSocket('ws://127.0.0.1:' + port);
        clients.push(ws);
        ws.onopen = () => ws.send(JSON.stringify({t:'join',name,species:'custom',skin:{base:'ivory'}}));
        ws.onerror = e => reject(e.error || new Error('WebSocket connection failed'));
        ws.onmessage = e => { const m = JSON.parse(e.data); if(m.t === 'state') resolve(m); };
    });
    const first = await join('First player'), second = await join('Second player');
    assert.notEqual(first.you.id,second.you.id); assert.ok(first.you.alive && second.you.alive);
    const invalid = await join(123); assert.ok(invalid.you.alive);
    assert.equal(await get('/%E0%A4%A'),400);
    assert.equal(await get('/.git/config'),404);
    assert.equal(await get('/'),200);
    assert.equal(await get('/battle.html'),200);
});
