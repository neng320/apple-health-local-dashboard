/* _file-protocol-test.js — 验证 file:// 双击打开 + 导入 XML 即可用（无服务器场景）
 * 流程：headless Edge 打开 file://index.html → 注入 sample/export.xml → 等待 READY → 断言渲染
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const FILE_URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const XML = path.join(ROOT, 'sample', 'export.xml');
const PORT = 9333;

let ws = null, msgId = 0;
const pending = new Map();

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws-connect-fail: ' + url));
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
  if (r.exceptionDetails) throw new Error('page-exception: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result ? r.result.value : undefined;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitTitle(timeoutMs) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    last = await evalJS('document.title');
    if (last.indexOf('READY') >= 0) return last;
    if (last.indexOf('ERR') >= 0 || last.indexOf('FAIL') >= 0) return last;
    await sleep(500);
  }
  return last;
}

(async () => {
  const results = [];
  const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log((pass ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : '')); };

  // 1. 启动 headless Edge，CDP 端口
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(ROOT, '.verify', 'edge-file-test'),
    'about:blank'
  ], { stdio: 'ignore' });
  await sleep(2500);

  // 2. 拿 ws 端点
  let target = null;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json');
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page) { target = page; break; }
    } catch (e) {}
    await sleep(500);
  }
  if (!target) { console.log('❌ CDP 端口无响应'); process.exit(1); }
  await connect(target.webSocketDebuggerUrl);
  await send('Page.enable');
  await send('Runtime.enable');
  console.log('CDP connected, opening file:// …');

  // 3. 导航到 file:// 页面
  await send('Page.navigate', { url: FILE_URL });
  await sleep(2500);

  // 4. 断言：engine.js / app.js 在 file:// 下加载成功
  const loaded = await evalJS('typeof HealthEngine !== "undefined"');
  ok('file:// 下 engine.js 加载', loaded, 'window.HealthEngine ' + (loaded ? '存在' : '缺失'));
  const hasApp = await evalJS('document.querySelector("#drop-zone") !== null');
  ok('file:// 下 app.js 渲染入口', hasApp, '#drop-zone ' + (hasApp ? '存在' : '缺失'));

  // 5. 注入 export.xml（等价于用户"点击选择文件"）
  const fi = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: fi.root.nodeId, selector: '#file-input' });
  if (!node.nodeId) { console.log('❌ 找不到 #file-input'); process.exit(1); }
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [XML] });
  console.log('export.xml 已注入 (' + (fs.statSync(XML).size / 1048576).toFixed(1) + ' MB)，等待解析渲染 …');

  // 6. 等待 READY
  const title = await waitTitle(120000);
  const okReady = title.indexOf('READY') >= 0;
  ok('XML → 看板渲染完成', okReady, title);

  // 7. 关键模块 DOM 断言
  if (okReady) {
    const dom = await evalJS(`(() => {
      const b = document.body.innerHTML;
      const has = (s) => b.indexOf(s) >= 0;
      return {
        errbar: has('error-bar') && /error-bar[^>]*style="[^"]*display:\s*none/.test(b) ? 'hidden' : (has('id="error-bar"') ? 'visible' : 'none'),
        navTabs: (b.match(/data-module="(overview|sleep|heart|others)"/g) || []).length,
        sleepPanel: has('sleep-cards'),
        heartPanel: has('id="heart-"') || has('heartCards'),
        quality: has('sleepQuality') || has('quality-card') || has('评分'),
        reqCount: (b.match(/外部请求/g) || []).length
      };
    })()`);
    ok('四模块导航渲染', dom.navTabs >= 4, '导航标签 ' + dom.navTabs + ' 个');
    ok('睡眠模块渲染', dom.sleepPanel, 'sleep-cards');
    ok('错误栏状态', dom.errbar === 'hidden' || dom.errbar === 'none', dom.errbar);
    ok('外部请求计数面板', dom.reqCount >= 1, '「外部请求」字样 ' + dom.reqCount + ' 处');
    const reqVal = await evalJS(`(() => { const els = document.querySelectorAll('.sum-item'); for (const el of els) { if (el.textContent.indexOf('外部请求') >= 0) { const m = el.textContent.match(/([0-9]+)\\s*次/); return m ? m[1] : el.textContent.trim(); } } return 'not-found'; })()`);
    ok('外部请求数 = 0', reqVal === '0', '实际值 ' + reqVal);
    // 截图
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify', 'file-protocol-check.png'), Buffer.from(shot.data, 'base64'));
    console.log('  截图已存 .verify/file-protocol-check.png');
  }

  // 8. 汇总
  const passed = results.filter(r => r.pass).length;
  console.log('\n[汇总] ' + passed + ' / ' + results.length + ' 项通过');
  await send('Browser.close').catch(() => {});
  edge.kill();
  process.exit(passed === results.length ? 0 : 1);
})().catch(err => { console.error('脚本异常:', err.message); process.exit(1); });
