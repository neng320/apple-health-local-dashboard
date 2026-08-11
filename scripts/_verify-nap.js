const { spawn, execFileSync } = require('child_process');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9244;
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
  if (r.exceptionDetails) return { err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) };
  return r.result ? r.result.value : undefined;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  try { execFileSync('taskkill', ['/IM', 'msedge.exe', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
  await sleep(1200);
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.cwd() + '\\.verify\\edge-nap-' + Date.now(), 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); targets = await r.json(); if (targets.length) break; } catch (e) {}
    await sleep(300);
  }
  await connect(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8123/index.html?sample=sample/export-real.xml' });
  for (let i = 0; i < 400; i++) {
    const t = await evalJS('document.title');
    if (t && t.indexOf('READY') >= 0) break;
    await sleep(400);
  }
  await evalJS(`document.querySelector('.mnav[data-module="sleep"]').click()`);
  await sleep(900);
  /* 切午睡口径 */
  await evalJS(`document.querySelector('#sleep-mode-tabs .tab[data-mode="nap"]').click()`);
  await sleep(800);
  const nap = await evalJS(`(() => ({
    score: document.getElementById('sleep-score-body').textContent.slice(0, 80),
    history: document.getElementById('sleep-history-meta').textContent.slice(0, 60),
    cards: [...document.querySelectorAll('#sleep-cards .card-value')].map(e => e.textContent),
    cardSubs: [...document.querySelectorAll('#sleep-cards .card-sub')].map(e => e.textContent),
    trendMeta: document.getElementById('sleep-chart-meta').textContent.slice(0, 80),
    err: !!document.getElementById('error-bar')
  }))()`);
  console.log('NAP MODE:', JSON.stringify(nap, null, 1));
  /* 切回晚间验证评分恢复 */
  await evalJS(`document.querySelector('#sleep-mode-tabs .tab[data-mode="night"]').click()`);
  await sleep(700);
  const night = await evalJS(`(() => ({
    score: document.getElementById('sleep-score-body').textContent.slice(0, 40),
    history: document.getElementById('sleep-history-meta').textContent.slice(0, 40)
  }))()`);
  console.log('NIGHT MODE:', JSON.stringify(night));
  try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
  console.log('done');
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
