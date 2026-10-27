// Minimal Chrome DevTools Protocol driver for smoke-testing the game.
// usage: (with `npm run dev` running) node scripts/smoke-cdp.mjs <race|fall|misc|items|laser|gallery|editor|remap|og> <outdir>
// Drives headless Google Chrome (macOS path below) over the DevTools protocol and
// writes screenshots + state logs to <outdir>. `og` stages and saves the social preview
// image (<outdir>/og-image.jpg → copy to public/). See docs/SPEC.md §6.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [scenario = 'race', out = '.'] = process.argv.slice(2);
const PORT = 9333;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${out}/chrome-cdp`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', () => chrome.kill());

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { await sleep(200); }
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR ' + JSON.stringify(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const key = (type, k, code, keyCode) => send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: keyCode });

await send('Runtime.enable');
await send('Page.enable');
const VIEW = scenario === 'og' ? [1200, 630] : [1280, 720];
await send('Emulation.setDeviceMetricsOverride', { width: VIEW[0], height: VIEW[1], deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:5173/' });
await sleep(2500);

const STATE = `(() => { const g = __rainbowRoad.game; const k = (x) => ({ st: x.state, s: +x.s.toFixed(1), lat: +x.lateral.toFixed(2), v: +x.speed.toFixed(1) });
  return JSON.stringify({ state: g.state, fps: g._fps, place: g.race && g.rivals.placeOf(g.race.progress, g.race.finishTime), prog: g.race && +g.race.progress.toFixed(0),
    player: k(g.kart), rivals: g.rivals.active.map((r) => ({ n: r.name, ...k(r.kart), p: +r.progress.toFixed(0), god: r.kart.rescuer.phase })), god: g.kart.rescuer.phase }); })()`;

console.log('loaded rivals:', await evaluate('__rainbowRoad.game.rivals.ready'));
console.log('settings rails:', await evaluate('__rainbowRoad.game.settings.get("rails")'));
await evaluate('__rainbowRoad.game.startRace()');
await sleep(800);
await shot('01-grid');
console.log('grid', await evaluate(STATE));
await sleep(3500);
await key('keyDown', 'ArrowUp', 'ArrowUp', 38);

if (scenario === 'og') {
  // Staged social preview: karts heading into a row of item boxes, a laser shot, a shield, the title on top.
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await sleep(2500);
  await E('stage', `(() => {
    const g = __rainbowRoad.game; const p = g.path; g.pause();
    for (const id of ['pause', 'hud', 'settings-toggle']) document.getElementById(id).classList.add('hidden');
    document.getElementById('settings-toggle').style.display = 'none';
    const boxes = g.items.entries.filter((e) => e.type === 'itembox').sort((a, b) => a.s - b.s);
    const row = boxes[0].s;
    const put = (k, ds, lat) => { k.s = p.wrap(row + ds); k.lateral = lat; k.heading = 0; k.speed = 30; k.syncModel(); k.model.visible = true; };
    const [princess, gorilla, mushroom] = g.rivals.active.map((r) => r.kart);
    put(g.kart, -24, -1.6);
    put(mushroom, -13.5, 2.2);
    put(princess, -16.5, -4.4);
    put(gorilla, -19, 4.3);
    princess.giveShield(5); princess.gear.update(0.016, { shield: 5, laser: false, hue: 0 });
    g.kart.held = { type: 'laser', charges: 3 }; g.kart.rolling = 0; g.kart.gear.update(0.016, { shield: 0, laser: true, hue: 0 });
    for (const k of [g.kart, mushroom, princess, gorilla]) k.model.updateMatrixWorld(true);
    g.items.useItem(g.kart, [g.kart]); // a shot down the road (no target, so nobody spins)
    const cam = g.camera; p.pointAt(row - 31.5, -0.2, 3.4, cam.position); cam.up.copy(p.frameAt(row - 31.5).normal);
    cam.lookAt(p.pointAt(row - 6, 0, 1.6)); cam.fov = 58; cam.updateProjectionMatrix();
    const o = document.createElement('div');
    o.innerHTML = '<h1 class="title" style="font-size:78px;margin:0"><span>Rainbow</span><span>Video</span><span>Road</span></h1>' +
      '<p style="margin:10px 0 0;font-size:24px;font-weight:600;color:#f3f0ff;letter-spacing:0.02em;text-shadow:0 2px 12px rgba(0,0,0,0.8)">A kart racer on a road made of your own videos</p>';
    o.style.cssText = 'position:fixed;inset:0 0 auto 0;padding:34px 0 80px;text-align:center;z-index:50;pointer-events:none;background:linear-gradient(rgba(7,5,15,0.82),rgba(7,5,15,0.45) 60%,rgba(7,5,15,0))';
    document.body.appendChild(o);
    return 'row at ' + row.toFixed(0); })()`);
  await sleep(1500);
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(`${out}/og-image.jpg`, Buffer.from(r.result.data, 'base64'));
} else if (scenario === 'race') {
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    console.log(`t+${(i + 1) * 2.5}s`, await evaluate(STATE));
    if (i === 1) await shot('02-racing');
  }
} else if (scenario === 'remap') {
  const r = await evaluate(`(async () => {
    const TP = await import('/src/track/TrackPath.js'); const TI = await import('/src/track/trackItems.js');
    const base = TP.TrackPath.generate(4242); const data = base.toJSON();
    const worldOf = (path, items) => items.map((it) => { const { s, lateral } = TI.itemTrackPos(path, it); return path.pointAt(s, lateral, 0); });
    const maxMove = (a, b) => Math.max(...a.map((p, i) => p.distanceTo(b[i])));
    const out = {};
    // insert: split segment 5 at its midpoint sample (point placed exactly on the curve)
    { const d = JSON.parse(JSON.stringify(data)); const p0 = TP.TrackPath.fromJSON(d); const before = worldOf(p0, d.items);
      const seg = 5; const sMid = (p0.pointArcLengths[5] + p0.pointArcLengths[6]) / 2; const pt = p0.pointAt(sMid);
      TI.remapItemsForInsert(d.items, p0, seg, sMid); d.points.splice(seg + 1, 0, [pt.x, pt.y, pt.z]);
      const p1 = TP.TrackPath.fromJSON(d); out.insert = maxMove(before, worldOf(p1, d.items)).toFixed(2); }
    // rotate start to point 7
    { const d = JSON.parse(JSON.stringify(data)); const p0 = TP.TrackPath.fromJSON(d); const before = worldOf(p0, d.items);
      TI.remapItemsForRotate(d.items, d.points.length, 7); d.points = d.points.slice(7).concat(d.points.slice(0, 7));
      const p1 = TP.TrackPath.fromJSON(d); out.rotate = maxMove(before, worldOf(p1, d.items)).toFixed(2); }
    // delete point 9 (the road changes shape there, so items in the two merged segments move with it; others must not move)
    { const d = JSON.parse(JSON.stringify(data)); const p0 = TP.TrackPath.fromJSON(d); const before = worldOf(p0, d.items);
      const n = d.points.length; const far = d.items.map((it) => it.seg < 6 || it.seg > 12);
      TI.remapItemsForDelete(d.items, p0, 9); d.points.splice(9, 1);
      const p1 = TP.TrackPath.fromJSON(d); const after = worldOf(p1, d.items);
      out.deleteFar = Math.max(...before.map((p, i) => far[i] ? p.distanceTo(after[i]) : 0)).toFixed(2); out.count = d.items.length; }
    return JSON.stringify(out); })()`);
  console.log('remap', r);
} else if (scenario === 'editor') {
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await E('open', `(() => { const g = __rainbowRoad.game; g.toMenu(); g.openEditor(); return g.state + ' items=' + g.editor.state.items.length; })()`);
  await sleep(1500);
  const mouse = async (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : button === 'left' ? 1 : 2, clickCount: 1 });
  // find a road pixel on the map: the map position of the centreline at s = 200
  const at = JSON.parse(await evaluate(`(() => { const ed = __rainbowRoad.game.editor; const c = document.getElementById('ed-map').getBoundingClientRect();
    const g = __rainbowRoad.game; const L = ed.path.length; let best = 0, bestD = -1;
    for (let s = 40; s < L; s += 10) { let d = Infinity; for (const e of g.items.entries) { let x = Math.abs(e.s - s); d = Math.min(d, Math.min(x, L - x)); } for (const a of ed.path.pointArcLengths) { let x = Math.abs(a - s); d = Math.min(d, Math.min(x, L - x)); } if (d > bestD) { bestD = d; best = s; } }
    window.__placeS = best; const p = ed.path.pointAt(best, 0, 0);
    const v = ed.view; const W = c.width, H = c.height; return JSON.stringify({ x: c.left + (p.x - v.cx) * v.scale + W / 2, y: c.top + (p.z - v.cz) * v.scale + H / 2 }); })()`));
  console.log('road px', at);
  await E('tool', `(() => { document.querySelector('[data-tool=block]').click(); return __rainbowRoad.game.editor.tool; })()`);
  await mouse('mousePressed', at.x, at.y); await mouse('mouseReleased', at.x, at.y);
  await sleep(300);
  await E('after place', `(() => { const ed = __rainbowRoad.game.editor; const it = ed.state.items[ed.state.items.length - 1]; return ed.state.items.length + ' last=' + JSON.stringify(it) + ' status=' + document.getElementById('ed-status').textContent; })()`);
  // drag it a little
  await E('select tool', `(() => { document.querySelector('[data-tool=select]').click(); return 'ok'; })()`);
  await mouse('mousePressed', at.x, at.y);
  for (let i = 1; i <= 6; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + i, y: at.y + i * 0.5, button: 'left', buttons: 1 }); await sleep(50); }
  await mouse('mouseReleased', at.x + 6, at.y + 3);
  await sleep(300);
  await E('after drag', `(() => { const ed = __rainbowRoad.game.editor; const it = ed.state.items[ed.state.items.length - 1]; return JSON.stringify(it) + ' undo=' + ed.history.length; })()`);
  // world has a block there?
  await E('world', `(() => { const g = __rainbowRoad.game; return 'blocks in world=' + g.items.entries.filter(e => e.type === 'block').length; })()`);
  // point banking: select point 3, turn on, set 30
  await E('bank', `(() => { const ed = __rainbowRoad.game.editor; const g = __rainbowRoad.game; ed.selected = 3; ed.needsDraw = true; return 'ok'; })()`);
  await sleep(300);
  await E('bank on', `(() => { const el = document.getElementById('ed-pb-on'); el.checked = true; el.dispatchEvent(new Event('change')); const r = document.getElementById('ed-pb'); r.value = 30; r.dispatchEvent(new Event('input')); return 'pt3=' + JSON.stringify(__rainbowRoad.game.editor.state.points[3]); })()`);
  await sleep(600);
  await E('bank applied', `(() => { const g = __rainbowRoad.game; const s = g.path.pointArcLengths[3]; return 'bank at pt3 = ' + (g.path.frameAt(s).bank * 180 / Math.PI).toFixed(1) + '° ; label=' + document.querySelector('[data-ed-out=pb]').textContent; })()`);
  // insert a point before the block's segment and check the block stayed put (world position)
  await E('placeS', 'window.__placeS');
  await shot('editor');
  await E('share roundtrip', `(async () => { const ts = await import('/src/track/trackStore.js'); const ed = __rainbowRoad.game.editor; const h = await ts.encodeTrackToHash(ed.state); const back = await ts.decodeTrackFromHash(h); return 'items ' + ed.state.items.length + ' -> ' + back.items.length + ', pt3 ' + JSON.stringify(back.points[3]) + ', hash len ' + h.length; })()`);
} else if (scenario === 'gallery') {
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await sleep(1500);
  await E('pause', `(() => { const g = __rainbowRoad.game; g.pause(); document.getElementById('pause').classList.add('hidden'); return g.state; })()`);
  for (const type of ['itembox', 'boost', 'coin', 'shield', 'cone', 'mud', 'block']) {
    await E(type, `(() => { const g = __rainbowRoad.game; const e = g.items.entries.find(x => x.type === '${type}'); if (!e) return 'none';
      for (const x of g.items.entries) x.mesh.visible = true;
      const p = g.path; const cam = g.camera; p.pointAt(e.s - 9, e.lateral + 2, 3.2, cam.position); const t = p.pointAt(e.s, e.lateral, 0.8); cam.up.set(0, 1, 0); cam.lookAt(t); cam.fov = 50; cam.updateProjectionMatrix(); return 'ok'; })()`);
    await sleep(700);
    await shot('g-' + type);
  }
  // laser beam frozen mid-shot: kart with a rival ahead, fire while paused
  await E('laser', `(() => { const g = __rainbowRoad.game; const k = g.kart; const r = g.rivals.active[1].kart; r.s = g.path.wrap(k.s + 25); r.lateral = k.lateral + 0.5; r.syncModel(); k.held = { type: 'laser', charges: 3 }; k.rolling = 0; k.gear.update(0.016, { shield: 0, laser: true, hue: 0 });
    const cam = g.camera; g.path.pointAt(k.s - 7, k.lateral - 3, 3.5, cam.position); cam.lookAt(g.path.pointAt(k.s + 12, k.lateral, 0.8)); cam.fov = 60; cam.updateProjectionMatrix();
    k.model.updateMatrixWorld(true); g.items.useItem(k, [k, r]); return 'spin=' + r.spinTime; })()`);
  await sleep(600);
  await shot('g-laser');
  await E('shield', `(() => { const g = __rainbowRoad.game; const k = g.kart; k.giveShield(5); k.gear.update(0.016, { shield: 5, laser: true, hue: 0 }); return 'ok'; })()`);
  await sleep(500);
  await shot('g-shield-on');
} else if (scenario === 'laser') {
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await sleep(1500);
  await E('direct', `(() => { const g = __rainbowRoad.game; const r = g.rivals.active[0].kart; g.kart.held = { type: 'laser', charges: 3 }; g.kart.rolling = 0;
    r.s = g.path.wrap(g.kart.s + 20); r.lateral = g.kart.lateral; r.shield = 0; r.state = 'driving';
    const before = { ps: g.kart.s.toFixed(1), rs: r.s.toFixed(1), pl: g.kart.lateral.toFixed(2), rl: r.lateral.toFixed(2), head: g.kart.heading.toFixed(3) };
    const blockers = g.items.entries.filter(e => e.active && (e.type === 'cone' || e.type === 'block')).map(e => { let d = e.s - g.kart.s; return d.toFixed(0) + '@' + e.lateral.toFixed(1); });
    const t = g.items.useItem(g.kart, g.rivals.active.map(x => x.kart).concat([g.kart]));
    return JSON.stringify({ t, before, spin: r.spinTime, inKarts: g.rivals.active.length, blockers }); })()`);
} else if (scenario === 'items') {
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await E('items', '(() => { const g = __rainbowRoad.game; const c = {}; for (const e of g.items.entries) c[e.type] = (c[e.type] || 0) + 1; return JSON.stringify(c) + " rivals=" + g.rivals.active.map(r => r.name); })()');
  const KS = `(() => { const g = __rainbowRoad.game; const k = (x) => x.state[0] + ' s=' + x.s.toFixed(0) + ' lat=' + x.lateral.toFixed(1) + ' v=' + x.speed.toFixed(0) + ' held=' + (x.held ? x.held.type + 'x' + x.held.charges : '-') + ' coins=' + x.coins + (x.spinTime > 0 ? ' SPIN' : '') + (x.shield > 0 ? ' SHIELD' : '') + (x.inMud ? ' MUD' : '');
    return ['P: ' + k(g.kart), ...g.rivals.active.map(r => r.name[0] + ': ' + k(r.kart))].join(' | ') + ' inactive=' + g.items.entries.filter(e => !e.active).length; })()`;
  for (let i = 0; i < 8; i++) { await sleep(2500); await E(`t${i}`, KS); if (i === 2) await shot('items-a'); if (i === 5) await shot('items-b'); }
  // laser: give the player a laser, put a rival just ahead in line, fire
  await E('laser setup', `(() => { const g = __rainbowRoad.game; const r = g.rivals.active[0].kart; g.kart.held = { type: 'laser', charges: 3 }; g.kart.rolling = 0; r.s = g.path.wrap(g.kart.s + 20); r.lateral = g.kart.lateral; r.shield = 0; r.syncModel(); return 'ok'; })()`);
  await sleep(300);
  await key('keyDown', 'e', 'KeyE', 69); await sleep(60); await key('keyUp', 'e', 'KeyE', 69);
  await sleep(120);
  await shot('laser');
  await E('after laser', `(() => { const g = __rainbowRoad.game; const r = g.rivals.active[0].kart; return 'rival spin=' + r.spinTime.toFixed(2) + ' held=' + JSON.stringify(g.kart.held) + ' beams=' + g.items.beams.length; })()`);
  // block: drive the player into a block head-on
  await E('block setup', `(() => { const g = __rainbowRoad.game; const b = g.items.entries.find(e => e.type === 'block'); g.kart.s = g.path.wrap(b.s - 6); g.kart.lateral = b.lateral; g.kart.heading = 0; g.kart.speed = 28; g.kart.shield = 0; return 'block at ' + b.s.toFixed(0); })()`);
  await sleep(500);
  await E('after block', `(() => { const k = __rainbowRoad.game.kart; return 'spin=' + k.spinTime.toFixed(2) + ' v=' + k.speed.toFixed(1); })()`);
  await shot('block');
  // cone
  await E('cone setup', `(() => { const g = __rainbowRoad.game; const c = g.items.entries.find(e => e.type === 'cone' && e.active); g.kart.s = g.path.wrap(c.s - 5); g.kart.lateral = c.lateral; g.kart.heading = 0; g.kart.speed = 25; g.kart.spinTime = 0; return 'ok'; })()`);
  await sleep(350);
  await E('after cone', `(() => { const g = __rainbowRoad.game; return 'flying=' + g.items.flying.length + ' v=' + g.kart.speed.toFixed(1); })()`);
  await shot('cone');
  // mud
  await E('mud setup', `(() => { const g = __rainbowRoad.game; const m = g.items.entries.find(e => e.type === 'mud'); g.kart.s = g.path.wrap(m.s - 1); g.kart.lateral = m.lateral; g.kart.heading = 0; g.kart.speed = 30; g.kart.spinTime = 0; return 'ok'; })()`);
  await sleep(250);
  await E('in mud', `(() => { const k = __rainbowRoad.game.kart; return 'inMud=' + k.inMud + ' v=' + k.speed.toFixed(1); })()`);
  await shot('mud');
  // drop items
  await E('drop', `(() => { const g = __rainbowRoad.game; g.kart.held = { type: 'cone', charges: 1 }; g.kart.rolling = 0; g.items.useItem(g.kart, [g.kart]); g.kart.held = { type: 'mud', charges: 1 }; g.items.useItem(g.kart, [g.kart]); return g.items.entries.filter(e => e.dropped).map(e => e.type).join(','); })()`);
} else if (scenario === 'misc') {
  await sleep(1500);
  const E = (label, js) => evaluate(js).then((v) => console.log(label, v));
  await E('rival push', '(() => { const r = __rainbowRoad.game.rivals.active[1]; r.kart.lateral = __rainbowRoad.game.path.halfWidth + 1.5; return "ok"; })()');
  await sleep(700);
  await E('rival after 0.7s', `(() => { const r = __rainbowRoad.game.rivals.active[1]; return r.kart.state + ' god=' + r.kart.rescuer.phase + ' vis=' + r.kart.rescuer.visible; })()`);
  await shot('rival-rescue');
  await sleep(4000);
  await E('rival after 4.7s', `(() => { const r = __rainbowRoad.game.rivals.active[1]; return r.kart.state + ' lat=' + r.kart.lateral.toFixed(2) + ' v=' + r.kart.speed.toFixed(1) + ' god=' + r.kart.rescuer.phase; })()`);
  // player: fall, then press R mid-rescue
  await E('player push', '(() => { const g = __rainbowRoad.game; g.kart.lateral = g.path.halfWidth + 1.5; return "ok"; })()');
  await sleep(1200);
  await E('player mid', '(() => { const k = __rainbowRoad.game.kart; return k.state + " god=" + k.rescuer.phase; })()');
  await key('keyDown', 'r', 'KeyR', 82); await sleep(150); await key('keyUp', 'r', 'KeyR', 82);
  await sleep(400);
  await E('after R', '(() => { const k = __rainbowRoad.game.kart; return k.state + " god=" + k.rescuer.phase + " vis=" + k.rescuer.visible + " lat=" + k.lateral; })()');
  // editor during a rescue
  await E('push again', '(() => { const g = __rainbowRoad.game; g.kart.lateral = g.path.halfWidth + 1.5; return "ok"; })()');
  await sleep(1200);
  await E('open editor', '(() => { const g = __rainbowRoad.game; g.openEditor(); return g.state + " godVis=" + g.kart.rescuer.visible + " rivalsVis=" + g.rivals.racers.map(r => r.kart.model.visible); })()');
  await sleep(800);
  await E('editor -> race', '(() => { const g = __rainbowRoad.game; g.editor.close(); g.startRace(); return g.state + " kart=" + g.kart.state + " god=" + g.kart.rescuer.phase + " rivals=" + g.rivals.active.map(r => r.kart.state + "@" + r.kart.s.toFixed(0)); })()');
  // switch rivals off and on
  await E('rivals off', '(() => { const g = __rainbowRoad.game; g.settings.set("rivals", false); return g.rivals.active.length + " vis=" + g.rivals.racers.map(r => r.kart.model.visible) + " kartS=" + g.kart.s.toFixed(0) + " place=" + g.rivals.placeOf(g.race.progress, null) + " placeHidden=" + document.querySelector(".place").hidden; })()');
  await sleep(500);
  await E('placeHidden', 'document.querySelector(".place").hidden');
  await E('rivals on', '(() => { const g = __rainbowRoad.game; g.settings.set("rivals", true); return g.rivals.active.length + " vis=" + g.rivals.racers.map(r => r.kart.model.visible); })()');
  await E('pace', '(() => { const g = __rainbowRoad.game; g.settings.set("rivalPace", 0.8); return g.rivals.racers.map(r => r.driver.pace); })()');
  await E('reset settings', '(() => { const g = __rainbowRoad.game; g.settings.set("rivalPace", 0.95); return "ok"; })()');
} else if (scenario === 'fall') {
  await sleep(2500);
  console.log('before fall', await evaluate(STATE));
  await evaluate('(() => { const g = __rainbowRoad.game; g.kart.lateral = g.path.halfWidth + 1.5; g.kart.heading = 0.4; })()');
  for (let i = 0; i < 10; i++) {
    await sleep(450);
    console.log(`fall+${((i + 1) * 0.45).toFixed(2)}`, await evaluate(STATE));
    await shot(`fall-${String(i).padStart(2, '0')}`);
  }
}
await key('keyUp', 'ArrowUp', 'ArrowUp', 38);
console.log('LOGS:\n' + logs.join('\n'));
ws.close();
chrome.kill();
process.exit(0);
