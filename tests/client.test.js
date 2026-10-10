// Run the shipped client scripts with controlled time and a minimal DOM/canvas.
// This checks client behavior, not browser layout or pixel rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client(file, reduced = false) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const ids = new Map(), events = new Map(), raf = new Map(), timers = new Map();
    let serial = 0, now = 100;
    const document = { activeElement: null, hidden: false };
    class Element {
        constructor(tag, attrs = {}) {
            this.tag = tag; this.attrs = attrs; this.id = attrs.id; this.children = []; this.style = {};
            this.value = attrs.value || ''; this.width = +(attrs.width || 700); this.height = +(attrs.height || 700);
            this.hidden = 'hidden' in attrs; this.inert = false; this.listeners = new Map();
            const classes = new Set((attrs.class || '').split(' '));
            this.classList = {contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c),
                toggle(c, on) { on ? classes.add(c) : classes.delete(c); }};
            if (this.id) ids.set(this.id, this);
        }
        appendChild(el) { el.parent = this; this.children.push(el); }
        set innerHTML(value) { this.children = []; }
        setAttribute(k,v) { this.attrs[k] = String(v); }
        getAttribute(k) { return this.attrs[k] ?? null; }
        focus() { if (this.getClientRects().length) document.activeElement = this; }
        contains(el) { for (; el; el = el.parent) if (el === this) return true; return false; }
        getClientRects() { for (let el=this;el;el=el.parent) if(el.hidden||el.inert)return []; return [1]; }
        matches(selector) {
            return selector.split(',').some(s => {s=s.trim();
                if(s.startsWith('.'))return s.slice(1).split('.').every(c=>this.classList.contains(c));
                if(s.startsWith('[')){const a=s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return !!a && (a[2] === undefined ? a[1] in this.attrs : this.attrs[a[1]] === a[2]);}
                return this.tag === s.split('[')[0];
            });
        }
        closest(selector) { for(let el=this;el;el=el.parent)if(el.matches(selector))return el;return null; }
        querySelectorAll(selector) { return this.children.flatMap(el => [...(el.matches(selector)?[el]:[]),...el.querySelectorAll(selector)]); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        addEventListener(name,fn) { if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn); }
        emit(name, extra={}) { const e={target:this,preventDefault(){this.prevented=true;},...extra};for(const fn of this.listeners.get(name)||[])fn(e);return e; }
        getContext() {
            if (!this.context) this.context = new Proxy({canvas:this,measureText:t=>({width:String(t).length*8}),
                createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}}),
                getImageData:(x,y,w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
                createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)})},
                {get:(target,key)=>key in target?target[key]:(()=>{})});
            return this.context;
        }
    }
    const root = new Element('root'), stack = [root];
    const voidTags = new Set(['meta','link','input','br','hr','img']);
    for (const m of html.split('<script>')[0].matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
        const tag = m[2].toLowerCase();
        if(m[1]) { if(stack.at(-1).tag===tag)stack.pop();continue; }
        const attrs = {};
        for(const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=a[2]||'';
        const el = new Element(tag,attrs); stack.at(-1).appendChild(el);
        if(!voidTags.has(tag))stack.push(el);
    }
    document.body=root.querySelector('body'); document.activeElement=document.body;
    document.getElementById=id=>ids.get(id);
    document.createElement=tag=>new Element(tag);
    document.querySelectorAll=selector=>root.querySelectorAll(selector);
    document.querySelector=selector=>root.querySelector(selector);
    document.addEventListener=(name,fn)=>{if(!events.has(name))events.set(name,[]);events.get(name).push(fn);};
    const media={matches:reduced,addEventListener(name,fn){this.change=fn;}};
    const sockets=[];
    class WebSocket {
        constructor(url){this.url=url;this.sent=[];this.readyState=1;sockets.push(this);}
        send(data){this.sent.push(JSON.parse(data));}
        close(){this.readyState=3;}
        message(data){this.onmessage({data:JSON.stringify(data)});}
    }
    const context={document,console,Uint8ClampedArray,WebSocket,
        location:{host:'192.168.1.50:8080',protocol:'http:'},
        performance:{now:()=>now},localStorage:{getItem(){return null;},setItem(){}},
        requestAnimationFrame(fn){const id=++serial;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id),
        setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)};
    context.window=context;context.matchMedia=()=>media;vm.createContext(context);
    let script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    if(file==='index.html') {
        const end=script.lastIndexOf('})();');
        script=script.slice(0,end)+`window.inspect = () => ({gameState,frame,steps,score,levelNo,
            body:JSON.stringify(snake),particles:JSON.stringify(particles),pending:pending.length});\n`+script.slice(end);
    }
    vm.runInContext(script,context,{filename:file});
    return {context,ids,media,sockets,document,
        key(target,key,code=key,repeat=false){const e={target,key,code,repeat,preventDefault(){this.prevented=true;}};for(const fn of events.get('keydown')||[])fn(e);return e;},
        advance(ms, hz=60){const end=now+ms;while(now<end){now=Math.min(end,now+1000/hz);const callbacks=[...raf.values()];raf.clear();for(const fn of callbacks)fn(now);for(const [id,t] of timers)if(t.at<=now){timers.delete(id);t.fn();}}}
    };
}

test('campaign boots, starts, pauses, resumes and buffers turns', () => {
    const c=client('index.html');assert.equal(c.context.inspect().gameState,'start');
    c.ids.get('menuStartBtn').emit('click');c.advance(200);
    assert.equal(c.context.inspect().gameState,'playing');assert.ok(c.context.inspect().steps>=1);
    c.key(c.ids.get('gameCanvas'),' ','Space');assert.equal(c.context.inspect().gameState,'paused');
    c.key(c.ids.get('gameCanvas'),' ','Space',true);assert.equal(c.context.inspect().gameState,'paused');
    c.key(c.ids.get('gameCanvas'),' ','Space');assert.equal(c.context.inspect().gameState,'playing');
    c.key(c.ids.get('gameCanvas'),'ArrowUp');c.key(c.ids.get('gameCanvas'),'ArrowRight');
    assert.ok(c.context.inspect().pending >= 1);
});
test('display restoration preserves the run and pauses for explicit resume', () => {
    const c=client('index.html');c.ids.get('menuStartBtn').emit('click');c.advance(350);
    const before=c.context.inspect();c.ids.get('gameCanvas').emit('contextlost');c.ids.get('gameCanvas').emit('contextrestored');
    const after=c.context.inspect();assert.equal(after.body,before.body);assert.equal(after.steps,before.steps);assert.equal(after.gameState,'paused');
    c.key(c.ids.get('gameCanvas'),' ','Space');c.advance(200);assert.equal(c.context.inspect().gameState,'playing');
});
test('reduced motion freezes decorative animation while gameplay continues', () => {
    const c=client('index.html',true);c.ids.get('menuStartBtn').emit('click');const before=c.context.inspect();c.advance(500);
    const after=c.context.inspect();assert.equal(after.frame,0);assert.equal(after.particles,before.particles);assert.ok(after.steps>before.steps);
});
test('animation time is independent of 60 Hz versus 144 Hz redraws', () => {
    const a=client('index.html'),b=client('index.html');a.advance(1000,60);b.advance(1000,144);
    assert.ok(Math.abs(a.context.inspect().frame-b.context.inspect().frame)<4);
});
test('arena uses the served LAN host and leaves typing shortcuts alone', () => {
    const c=client('battle.html');assert.equal(c.ids.get('brUrl').value,'192.168.1.50:8080');
    assert.equal(c.key(c.ids.get('brName'),' ','Space').prevented,undefined);assert.equal(c.sockets.length,0);
    c.ids.get('brJoin').emit('click');assert.equal(c.sockets[0].url,'ws://192.168.1.50:8080');c.sockets[0].onopen();
    assert.equal(c.sockets[0].sent[0].t,'join');
    c.sockets[0].message({t:'welcome',id:1,w:400,h:400,tick:90});assert.equal(c.context.__battle.joined,true);
    assert.equal(c.document.activeElement,c.ids.get('gameCanvas'));
    c.key(c.ids.get('gameCanvas'),'ArrowUp');assert.equal(c.sockets[0].sent.at(-1).d,3);
});
test('hidden dialogs are inert and keyboard focus stays in the active dialog', () => {
    const c=client('battle.html');assert.equal(c.ids.get('battleDeath').inert,true);
    assert.equal(c.document.activeElement,c.ids.get('brName'));
    const dialog=c.ids.get('battleScreen'),last=dialog.querySelectorAll('button, input, select, a[href]').at(-1);
    last.focus();const e=c.key(last,'Tab');assert.equal(e.prevented,true);assert.equal(c.document.activeElement,c.ids.get('brName'));
});
