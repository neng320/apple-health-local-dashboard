/* _cdp-test2.js — 模块化版本端到端验证（模拟数据全模块 + 真实数据 DOM 数值） */
const { spawn } = require('child_process');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9225;
const BASE = 'http://127.0.0.1:8123/index.html';
const OUT = '.verify';

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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    let srcInfo = '';
    try {
      const src = await send('Debugger.getScriptSource', { scriptId: r.exceptionDetails.scriptId });
      const lines = src.scriptSource.split('\n');
      srcInfo = ' SRC(lines=' + lines.length + '):' + JSON.stringify(lines[r.exceptionDetails.lineNumber] || '') + ' | ' + JSON.stringify(lines[r.exceptionDetails.lineNumber - 1] || '');
    } catch (e) { srcInfo = ' (no-src)'; }
    throw new Error('page-exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description) + ' @script' + r.exceptionDetails.scriptId + ':' + r.exceptionDetails.lineNumber + ':' + r.exceptionDetails.columnNumber + srcInfo);
  }
  return r.result ? r.result.value : undefined;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const t = await evalJS('document.title');
    if (t.indexOf('READY') >= 0) return t;
    if (t.indexOf('STEP-FAIL') >= 0 || t.indexOf('ERR:') >= 0 || t.indexOf('FAIL') >= 0) return t;
    await sleep(400);
  }
  return await evalJS('document.title');
}
async function navigate(url, timeoutMs) {
  await send('Page.navigate', { url });
  return waitReady(timeoutMs || 90000);
}
async function realClick(selector) {
  const r = await send('Runtime.evaluate', { expression: `(() => { const el = document.querySelector('${selector}'); if (!el) return 'not-found'; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`, returnByValue: true });
  if (r.result.value === 'not-found') throw new Error('selector not found: ' + selector);
  const p = r.result.value;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(300);
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '\\' + name + '.png', Buffer.from(r.data, 'base64'));
  console.log('  shot:', name + '.png');
}
function get(html, re) { const m = html.match(re); return m ? m[1].trim() : null; }
async function domInfo() {
  return evalJS(`(() => {
    const b = document.body.innerHTML;
    const g = (re) => { const m = b.match(re); return m ? m[1].trim() : null; };
    return {
      title: document.title,
      errbar: /id="error-bar"/.test(b),
      sleepCards: (b.match(/id="sleep-cards"/g) || []).length,
      heartCards: (b.match(/id="hr-cards"/g) || []).length,
      summary: g(/总记录<\\/span><span class="v">([^<]+)/),
      ext: g(/外部请求<\\/span><span class="v cyan">([^<]+)/),
      parseMs: g(/解析耗时<\\/span><span class="v">([^<]+)/),
      curLabel: g(/id="sleep-cur-label">([^<]+)/),
      hrCurLabel: g(/id="hr-cur-label">([^<]+)/),
      sleepCardVals: [...b.matchAll(/id="sleep-cards"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/section>/g)].length
    };
  })()`);
}

(async () => {
  console.log('[start]');
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + process.cwd() + '\\' + 'edge-cdp2-' + Date.now(), '--window-size=1600,1050', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let targets = null;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); targets = await r.json(); if (targets.length) break; } catch (e) {}
    await sleep(300);
  }
  const pageT = targets.find(t => t.type === 'page');
  await connect(pageT.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Debugger.enable');

  /* ===== 模拟数据 ===== */
  console.log('\n[1] overview (sample)');
  let t = await navigate(BASE + '?sample=sample/export.xml');
  console.log('  title:', t);
  await shot('m1-overview');

  console.log('\n[2] sleep module (day)');
  console.log('  pre-state:', JSON.stringify(await evalJS('document.title + \' | \' + document.getElementById(\'module-sleep\').hidden')));
  await realClick('.mnav[data-module="sleep"]');
  await sleep(600);
  const sleepVals = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#sleep-cards .card')];
    return cards.map(c => (c.querySelector('.card-value')||{}).textContent);
  })()`);
  console.log('  sleep cards:', JSON.stringify(sleepVals));
  const score = await evalJS(`document.getElementById('sleep-score-body').textContent.slice(0, 200)`);
  console.log('  score:', JSON.stringify(score));
  await shot('m2-sleep-day');

  console.log('\n[3] sleep week + month');
  await realClick('#sleep-gran-tabs .tab[data-gran="week"]');
  await sleep(500);
  console.log('  week label:', await evalJS(`document.getElementById('sleep-cur-label').textContent`));
  await shot('m3-sleep-week');
  await realClick('#sleep-gran-tabs .tab[data-gran="month"]');
  await sleep(500);
  console.log('  month label:', await evalJS(`document.getElementById('sleep-cur-label').textContent`));
  await shot('m4-sleep-month');

  console.log('\n[4] heart module');
  await realClick('.mnav[data-module="heart"]');
  await sleep(600);
  const hrVals = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#hr-cards .card')];
    return cards.map(c => (c.querySelector('.card-value')||{}).textContent);
  })()`);
  console.log('  hr cards:', JSON.stringify(hrVals));
  await shot('m5-heart-day');
  await realClick('#hr-gran-tabs .tab[data-gran="week"]');
  await sleep(500);
  console.log('  week label:', await evalJS(`document.getElementById('hr-cur-label').textContent`));
  await shot('m6-heart-week');
  await realClick('#hr-gran-tabs .tab[data-gran="month"]');
  await sleep(500);
  await shot('m7-heart-month');

  console.log('\n[5] others module');
  await realClick('.mnav[data-module="others"]');
  await sleep(500);
  const othersRows = await evalJS(`document.querySelectorAll('#others-table tbody tr').length`);
  console.log('  others rows:', othersRows);
  if (othersRows > 0) {
    await realClick('#others-table tbody tr');
    await sleep(500);
  }
  await shot('m8-others');

  /* ===== 真实数据（只读 DOM 数值，不截图上传） ===== */
  console.log('\n[6] REAL DATA (200MB)');
  t = await navigate(BASE + '?sample=sample/export-real.xml', 240000);
  console.log('  title:', t);
  const real = await evalJS(`(() => {
    const b = document.body.innerHTML;
    const g = (re) => { const m = b.match(re); return m ? m[1].trim() : null; };
    return {
      summary: g(/总记录<\\/span><span class="v">([^<]+)/),
      span: g(/覆盖范围<\\/span><span class="v">([^<]+)/),
      parseMs: g(/解析耗时<\\/span><span class="v">([^<]+)/),
      ext: g(/外部请求<\\/span><span class="v cyan">([^<]+)/),
      sleepBadge: document.getElementById('badge-sleep').textContent,
      heartBadge: document.getElementById('badge-heart').textContent,
      othersBadge: document.getElementById('badge-others').textContent
    };
  })()`);
  console.log('  real summary:', JSON.stringify(real));

  /* 睡眠模块（真实数据） */
  await realClick('.mnav[data-module="sleep"]');
  await sleep(500);
  const realSleep = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#sleep-cards .card')];
    const vals = cards.map(c => (c.querySelector('.card-value')||{}).textContent);
    const subs = cards.map(c => (c.querySelector('.card-sub')||{}).textContent);
    return { label: document.getElementById('sleep-cur-label').textContent, vals, subs, stages: (document.getElementById('sleep-stages').textContent || '').slice(0, 120) };
  })()`);
  console.log('  real sleep:', JSON.stringify(realSleep));

  /* 心率模块（真实数据） */
  await realClick('.mnav[data-module="heart"]');
  await sleep(500);
  const realHr = await evalJS(`(() => {
    const cards = [...document.querySelectorAll('#hr-cards .card')];
    return { label: document.getElementById('hr-cur-label').textContent, vals: cards.map(c => (c.querySelector('.card-value')||{}).textContent), zones: (document.getElementById('hr-zones').textContent || '').slice(0, 100) };
  })()`);
  console.log('  real heart:', JSON.stringify(realHr));

  console.log('\n[done]');
  try { require('child_process').execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
  process.exit(0);
})().catch(async (e) => {
  console.error('TEST-FAIL:', e.message);
  try { require('child_process').execFileSync('taskkill', ['/PID', String(edge && edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e2) {}
  process.exit(1);
});
