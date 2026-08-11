const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9237;
let ws = null, msgId = 0;
const pending = new Map();
function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws'));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    };
  });
}
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result ? r.result.value : undefined;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  try { execFileSync('taskkill', ['/IM', 'msedge.exe', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
  await sleep(1200);
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.cwd() + '\\.verify\\edge-mob-' + Date.now(), 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); targets = await r.json(); if (targets.length) break; } catch (e) {}
    await sleep(300);
  }
  await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8123/index.html?sample=sample/export.xml' });
  for (let i = 0; i < 120; i++) {
    const t = await evalJS('document.title');
    if (t && t.indexOf('READY') >= 0) break;
    await sleep(400);
  }
  console.log('overview ready');
  const overflowOv = await evalJS(`(() => { const b = document.body; return { scrollW: b.scrollWidth, clientW: b.clientWidth, overflow: b.scrollWidth > b.clientWidth }; })()`);
  console.log('overview overflow:', JSON.stringify(overflowOv));
  let r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('.verify\\mb1-overview.png', Buffer.from(r.data, 'base64'));
  /* sleep 模块 */
  await evalJS(`document.querySelector('.mnav[data-module="sleep"]').click()`);
  await sleep(700);
  const overflowSl = await evalJS(`(() => { const b = document.body; return { scrollW: b.scrollWidth, clientW: b.clientWidth, overflow: b.scrollWidth > b.clientWidth }; })()`);
  console.log('sleep overflow:', JSON.stringify(overflowSl));
  r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('.verify\\mb2-sleep.png', Buffer.from(r.data, 'base64'));
  await evalJS('window.scrollTo(0, 2000)');
  await sleep(400);
  r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('.verify\\mb3-sleep-mid.png', Buffer.from(r.data, 'base64'));
  /* heart 模块 */
  await evalJS(`document.querySelector('.mnav[data-module="heart"]').click()`);
  await sleep(600);
  const overflowHr = await evalJS(`(() => { const b = document.body; return { scrollW: b.scrollWidth, clientW: b.clientWidth, overflow: b.scrollWidth > b.clientWidth }; })()`);
  console.log('heart overflow:', JSON.stringify(overflowHr));
  r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('.verify\\mb4-heart.png', Buffer.from(r.data, 'base64'));
  try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
  console.log('done');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
