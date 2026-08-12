/* verify.js — Node 端验证：解析正确性（与生成器答案逐日核对）+ 异常处理 + 压力性能
 * 运行: node scripts/verify.js
 */
const fs = require('fs');
const path = require('path');
const HE = require('../engine.js');

const SAMPLE = path.join(__dirname, '..', 'sample', 'export.xml');
const STRESS = path.join(__dirname, '..', 'sample', 'export-stress.xml');
const ANSWERS = require(path.join(__dirname, '..', 'sample', 'export-answers.json'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''));
}

/* 确定性随机（与 make-sample 同 LCG，保证每次运行抽查一致） */
let seed = 20260812;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

/* ============ 1. 样例解析 ============ */
console.log('\n[1] 样例数据解析与逐日核对');
const t0 = Date.now();
const text = fs.readFileSync(SAMPLE, 'utf8');
const res = HE.parseText(text, { fileName: 'export.xml', fileSize: text.length });
const parseMs = Date.now() - t0;
console.log('  解析耗时: ' + parseMs + ' ms');

check('总记录数一致', res.stats.recordCount === ANSWERS.recordCount + ANSWERS.injectedKept,
  res.stats.recordCount + ' vs 期望 ' + (ANSWERS.recordCount + ANSWERS.injectedKept));
check('指标种类 ≥ 12', res.stats.typeCount >= 12, '实际 ' + res.stats.typeCount + ' 种');
check('时间范围正确', res.stats.spanFirst === Date.UTC(2023, 11, 31, 15, 59) && res.stats.spanLast >= Date.UTC(2025, 6, 31, 10),
  HE.fmtDate(res.stats.spanFirst) + ' → ' + HE.fmtDate(res.stats.spanLast));
check('跳过计数与注入一致', res.stats.skipped.badValue === 3 &&
  res.stats.skipped.badDate === 1 &&
  res.stats.skipped.negative === 1 &&
  res.stats.skipped.badUnit === 1 &&
  res.stats.skipped.rows === 0,
  JSON.stringify(res.stats.skipped));
check('未闭合行被块扫描容错合并（不产生结构错误）', res.stats.skipped.rows === 0, '');
check('未知类型进入通用指标', res.other.some(o => o.label === 'DietaryCaffeine' && o.days.length === 2),
  '其他指标数 ' + res.other.length);

/* 逐日核对 */
const daily = res.daily;
const stepDays = new Map(daily.steps.days.map(d => [d.d, d.v]));
const hrDays = new Map(daily.heartRate.days.map(d => [d.d, d]));
const sleepDays = new Map(daily.sleep.days.map(d => [d.d, d]));
const wtDays = new Map(daily.bodyMass.days.map(d => [d.d, d.v]));
const distDays = new Map(daily.distance.days.map(d => [d.d, d.v]));

let checked = 0, mismatches = [];
const sampleKeys = Object.keys(ANSWERS.daily);
/* 抽样：均匀抽 20 天 + 首尾 + 注入日前后（确定性种子） */
const idxs = new Set([0, 1, 2, Math.floor(sampleKeys.length / 2), sampleKeys.length - 1, sampleKeys.length - 2, 100, 200, 300, 400, 500]);
for (let i = 0; i < 10; i++) idxs.add(Math.floor(rnd() * sampleKeys.length));

for (const idx of idxs) {
  const dk = sampleKeys[idx];
  const a = ANSWERS.daily[dk];
  if (a.steps === 0) continue; // 无数据日跳过（2024-04-08 注入空日）
  const s = stepDays.get(dk);
  const h = hrDays.get(dk);
  if (s === undefined || s !== a.steps) mismatches.push(dk + ' steps ' + s + ' vs ' + a.steps);
  if (h === undefined) mismatches.push(dk + ' 无心率');
  else {
    if (h.min !== a.hrMin) mismatches.push(dk + ' hrMin ' + h.min + ' vs ' + a.hrMin);
    if (h.max !== a.hrMax) mismatches.push(dk + ' hrMax ' + h.max + ' vs ' + a.hrMax);
    if (h.v !== Math.round(a.hrSum / a.hrN * 10) / 10) mismatches.push(dk + ' hrAvg ' + h.v + ' vs ' + Math.round(a.hrSum / a.hrN * 10) / 10);
  }
  /* 距离保留 0.01 km 精度（引擎按 round:100 归一；真值 3 位小数，最大舍入差 0.005） */
  const ds = distDays.get(dk);
  if (ds === undefined || Math.abs(ds - a.distance) > 0.006) mismatches.push(dk + ' distance ' + ds + ' vs ' + a.distance);
  checked++;
}
check('抽样 ' + checked + ' 天步数/心率逐项一致（0 偏差）', mismatches.length === 0,
  mismatches.length ? mismatches.slice(0, 3).join('; ') : '');

/* 睡眠核对（抽样 5 天） */
let sleepOk = true, sleepChecked = 0, sleepDetail = [];
const sleepSample = Object.keys(ANSWERS.daily).filter(dk => ANSWERS.daily[dk].sleepAsleep > 0);
for (let i = 0; i < Math.min(5, sleepSample.length); i++) {
  const dk = sleepSample[Math.floor(rnd() * sleepSample.length)];
  const a = ANSWERS.daily[dk];
  const s = sleepDays.get(dk);
  if (!s) { sleepOk = false; sleepDetail.push(dk + ' 无睡眠'); continue; }
  if (s.v !== a.sleepAsleep) { sleepOk = false; sleepDetail.push(dk + ' asleep ' + s.v + ' vs ' + a.sleepAsleep); }
  if (s.deep !== a.sleepDeep) { sleepOk = false; sleepDetail.push(dk + ' deep ' + s.deep + ' vs ' + a.sleepDeep); }
  sleepChecked++;
}
check('睡眠抽样 ' + sleepChecked + ' 天核对一致', sleepOk, sleepDetail.join('; '));

/* 口径守恒：全部 = 晚间 + 午睡（防止细分/粗粒度混合时丢午睡回归；样例无午睡则跳过） */
if (daily.sleepNap && daily.sleepNap.days.length) {
  const allMap = new Map(daily.sleep.days.map(d => [d.d, d.v]));
  const nightMap = new Map(daily.sleepNight.days.map(d => [d.d, d.v]));
  const napMap = new Map(daily.sleepNap.days.map(d => [d.d, d.v]));
  let conserved = true, badDays = [];
  allMap.forEach((v, dk) => {
    if (v !== (nightMap.get(dk) || 0) + (napMap.get(dk) || 0)) { conserved = false; badDays.push(dk); }
  });
  check('睡眠口径守恒（全部 = 晚间 + 午睡）', conserved, badDays.length ? badDays.slice(0, 3).join(', ') : '');
} else {
  console.log('  SKIP: 样例无午睡段（口径守恒由真实数据探针覆盖）');
}

/* 体重核对 */
let wtOk = true, wtChecked = 0;
for (const dk of Object.keys(ANSWERS.daily)) {
  const a = ANSWERS.daily[dk];
  if (a.weight === null) continue;
  const w = wtDays.get(dk);
  if (w === undefined || w !== a.weight) { wtOk = false; }
  wtChecked++;
}
check('体重 ' + wtChecked + ' 天核对一致', wtOk, '');

/* 无数据日：2024-04-08 步数应为 0（该日无记录） */
check('无数据日显示为空（2024-04-08 步数缺省）', !stepDays.has('2024-04-08'), '');

/* 跨午夜睡眠归到开始日 */
const cross = sleepDays.get('2024-04-09');
check('跨午夜睡眠段归入开始日 2024-04-09', cross && cross.v >= 60, cross ? 'asleep=' + cross.v + ' min' : '无');

/* ============ 2. 压力性能 ============ */
console.log('\n[2] 压力性能（30 万条级）');
if (fs.existsSync(STRESS)) {
  const size = fs.statSync(STRESS).size;
  const t1 = Date.now();
  const stext = fs.readFileSync(STRESS, 'utf8');
  const res2 = HE.parseText(stext, {});
  const stressMs = Date.now() - t1;
  console.log('  文件: ' + (size / 1024 / 1024).toFixed(1) + ' MB, 记录: ' + res2.stats.recordCount + ' 条');
  console.log('  解析耗时: ' + stressMs + ' ms');
  check('30 万条级解析 < 5s（Node）', stressMs < 5000, stressMs + ' ms');
  check('压力数据摘要完整', res2.stats.typeCount >= 5 && res2.daily.steps.days.length === 730,
    res2.stats.typeCount + ' 种指标, ' + res2.daily.steps.days.length + ' 天');
  check('心率原始序列采样存在', !!res2.heartRaw && res2.heartRaw.ts.length > 100000,
    res2.heartRaw ? res2.heartRaw.ts.length + ' 条' : '无');
} else {
  console.log('  SKIP: 压力文件未包含（export-stress.xml 已在 .gitignore，可运行 node scripts/make-stress.js 生成后复验）');
}

/* ============ 3. 异常输入 ============ */
console.log('\n[3] 异常输入防御');
let threw = null;
try { HE.parseText('<html><body>不是健康数据</body></html>', {}); } catch (e) { threw = e; }
check('非健康 XML 明确报错', threw && threw.message.indexOf('健康') !== -1, threw ? threw.message.slice(0, 40) : '未报错');
let threw2 = null;
try { HE.parseText('<HealthData></HealthData>', {}); } catch (e) { threw2 = e; }
check('空 HealthData 明确报错', !!threw2, threw2 ? threw2.message.slice(0, 40) : '未报错');
check('空字符串不崩溃', (function () { try { HE.parseText('', {}); return false; } catch (e) { return true; } })(), '');

/* ============ 汇总 ============ */
console.log('\n[汇总]');
const fail = results.filter(r => !r.ok);
console.log((results.length - fail.length) + ' / ' + results.length + ' 项通过' + (fail.length ? '，失败: ' + fail.map(f => f.name).join('; ') : ''));
process.exit(fail.length ? 1 : 0);
