// Minimal Chrome DevTools Protocol driver for smoke-testing the game.
// usage: (with `npm run dev` running) node scripts/smoke-cdp.mjs <race|fall|misc> <outdir>
// Drives headless Google Chrome (macOS path below) over the DevTools protocol and
// writes screenshots + state logs to <outdir>. See docs/SPEC.md §6.
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
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

if (scenario === 'race') {
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    console.log(`t+${(i + 1) * 2.5}s`, await evaluate(STATE));
    if (i === 1) await shot('02-racing');
  }
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
