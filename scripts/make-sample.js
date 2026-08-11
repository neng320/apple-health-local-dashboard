/* make-sample.js — 生成 1.5 年模拟 Apple Health 导出样例（含异常注入）
 * 输出: sample/export.xml + sample/export-answers.json（每日真实聚合值，供核对）
 * 运行: node scripts/make-sample.js
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'sample');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---- 可复现随机 ---- */
let seed = 20240811;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function randInt(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function randFloat(a, b) { return a + rnd() * (b - a); }

const TZ = '+0800';
const DAY_MS = 86400000;
const START = Date.UTC(2024, 0, 1);      // 2024-01-01
const DAYS = 578;                          // 至 2025-07-31

const p = n => (n < 10 ? '0' + n : '' + n);

/* 记录行：startMin 为「当天 00:00 起」的分钟偏移（可 >1440 跨天），durMin 为持续分钟 */
function recAbs(type, unit, value, dayTs, startMin, durMin, extra) {
  const startTs = dayTs + startMin * 60000;
  const endTs = startTs + (durMin || 0) * 60000;
  const s = new Date(startTs), e = new Date(endTs);
  const sd = s.getUTCFullYear() + '-' + p(s.getUTCMonth() + 1) + '-' + p(s.getUTCDate()) +
    ' ' + p(s.getUTCHours()) + ':' + p(s.getUTCMinutes()) + ':00 ' + TZ;
  const ed = e.getUTCFullYear() + '-' + p(e.getUTCMonth() + 1) + '-' + p(e.getUTCDate()) +
    ' ' + p(e.getUTCHours()) + ':' + p(e.getUTCMinutes()) + ':00 ' + TZ;
  const src = (extra && extra.src) || '测试数据生成器';
  const ver = (extra && extra.ver) || '1.0';
  return '    <Record type="' + type + '" sourceName="' + src + '" sourceVersion="' + ver +
    '" unit="' + unit + '" creationDate="' + sd + '" startDate="' + sd + '"' +
    (ed !== sd ? ' endDate="' + ed + '"' : '') + ' value="' + value + '"/>';
}

const lines = [];
lines.push('<?xml version="1.0" encoding="UTF-8"?>');
lines.push('<!DOCTYPE HealthData SYSTEM "export.dtd">');
lines.push('<HealthData locale="zh_CN" exportDate="2025-08-01 10:00:00 +0800">');
lines.push('  <Me HKCharacteristicTypeIdentifierDateOfBirth="1995-06-15" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexFemale" HKCharacteristicTypeIdentifierBloodType="HKBiologicalSexFemale" />');

/* 答案表 */
const answers = {};
function dayAns(dk) {
  if (!answers[dk]) answers[dk] = { steps: 0, energy: 0, distance: 0, hrMin: null, hrMax: null, hrSum: 0, hrN: 0, resting: [], weight: null, sleepAsleep: 0, sleepInBed: 0, sleepDeep: 0, sleepCore: 0, sleepREM: 0, vo2: null, oxy: [], temp: null, resp: [] };
  return answers[dk];
}

let recordCount = 0;
let stepsRecs = 0, hrRecs = 0, energyRecs = 0, sleepRecs = 0;

for (let i = 0; i < DAYS; i++) {
  const dayTs = START + i * DAY_MS;
  const dk = new Date(dayTs).toISOString().slice(0, 10);
  const dow = new Date(dayTs).getUTCDay();
  const weekend = dow === 0 || dow === 6;

  /* 空数据日（验证无数据容错） */
  if (dk === '2024-04-08') continue;

  const ans = dayAns(dk);

  /* 睡眠（前一天 22:30 开始；各阶段按自身 startDate 的实际日期归属——跨午夜段归次日） */
  if (i > 0 && dk !== '2025-01-01') {
    const prevTs = START + (i - 1) * DAY_MS;
    const total = randInt(380, 470);       // 总睡眠 6.3-7.8h
    const deep = Math.round(total * randFloat(0.14, 0.24));
    const rem = Math.round(total * randFloat(0.18, 0.26));
    const core = total - deep - rem;
    const inBed = total + randInt(20, 45);
    const awake = randInt(3, 18);
    const b = 22 * 60 + 30, sl = 22 * 60 + 45; // 22:30 / 22:45

    const segs = [
      ['InBed', b, inBed], ['AsleepCore', sl, core], ['AsleepDeep', sl + core, deep],
      ['AsleepREM', sl + core + deep, rem], ['Awake', sl + core + deep + rem, awake]
    ];
    for (const [stage, startMin, dur] of segs) {
      const startTs = prevTs + startMin * 60000;
      // 记录的字符串形如 "YYYY-MM-DD HH:mm:00 +0800"（真实 UTC = startTs - 8h），
      // 引擎按「真实 UTC + 时区偏移」归当地日 → 即 startTs 的 UTC 日期
      const segDk = new Date(startTs).toISOString().slice(0, 10);
      const pa = dayAns(segDk);
      if (stage === 'InBed') pa.sleepInBed += dur;
      else if (stage === 'Awake') { /* 不算睡眠时长 */ }
      else { pa.sleepAsleep += dur; if (stage === 'AsleepDeep') pa.sleepDeep += dur; if (stage === 'AsleepCore') pa.sleepCore += dur; if (stage === 'AsleepREM') pa.sleepREM += dur; }
      lines.push(recAbs('HKCategoryTypeIdentifierSleepAnalysis', 'min', 'HKCategoryValueSleepAnalysis' + stage, prevTs, startMin, dur, { src: 'iPhone' }));
    }
    sleepRecs += 5;
    recordCount += 5;
  }

  /* 步数（一天 4-9 条） */
  const base = weekend ? randInt(7000, 17000) : randInt(4000, 13000);
  const nSteps = randInt(4, 9);
  let stepsSum = 0;
  for (let s = 0; s < nSteps; s++) {
    const m = randInt(8 * 60, 21 * 60 + 59);
    const v = Math.max(50, Math.round(base / nSteps * randFloat(0.5, 1.6)));
    stepsSum += v;
    lines.push(recAbs('HKQuantityTypeIdentifierStepCount', 'count', v, dayTs, m, 0, { src: 'iPhone' }));
    stepsRecs++; recordCount++;
  }
  ans.steps = stepsSum;

  /* 活动能量（一天 4-6 条，傍晚运动多） */
  let energySum = 0;
  const nEn = randInt(4, 6);
  for (let e = 0; e < nEn; e++) {
    const m = e === nEn - 1 ? randInt(17 * 60, 19 * 60 + 59) : randInt(8 * 60, 21 * 60 + 59);
    const v = Math.round(randFloat(20, 160));
    energySum += v;
    lines.push(recAbs('HKQuantityTypeIdentifierActiveEnergyBurned', 'kcal', v, dayTs, m, 0, { src: '测试数据生成器' }));
    energyRecs++; recordCount++;
  }
  ans.energy = energySum;

  /* 距离（1-2 条，约 = 步数 × 0.00072 km） */
  const dist = Math.round(stepsSum * 0.00072 * 1000) / 1000;
  lines.push(recAbs('HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', dist, dayTs, 21 * 60 + 30, 0, { src: 'iPhone' }));
  recordCount++;
  ans.distance = dist;

  /* 心率（07:00-23:55 每 15 分钟 1 条 + 傍晚运动峰值段，整数分钟循环） */
  const hrs = [];
  for (let m = 7 * 60; m <= 23 * 60 + 55; m += 15) {
    let v = Math.round(randFloat(62, 96));
    if (m >= 17 * 60 && m <= 18 * 60 + 30) v = Math.round(randFloat(128, 172));
    if (m >= 22 * 60) v = Math.round(randFloat(58, 78));
    hrs.push(v);
    lines.push(recAbs('HKQuantityTypeIdentifierHeartRate', 'count/min', v, dayTs, m, 0, { src: 'Apple Watch' }));
    hrRecs++; recordCount++;
  }
  ans.hrMin = Math.min(...hrs); ans.hrMax = Math.max(...hrs);
  ans.hrSum = hrs.reduce((a, b) => a + b, 0); ans.hrN = hrs.length;

  /* 静息心率（每天 1 条 06:30） */
  const rhr = randInt(50, 64);
  lines.push(recAbs('HKQuantityTypeIdentifierRestingHeartRate', 'count/min', rhr, dayTs, 6 * 60 + 30, 0, { src: 'Apple Watch' }));
  recordCount++;
  ans.resting.push(rhr);

  /* 血氧（睡前 1 条） */
  const oxy = randInt(95, 99);
  lines.push(recAbs('HKQuantityTypeIdentifierOxygenSaturation', '%', oxy, dayTs, 22 * 60 + 55, 0, { src: 'Apple Watch' }));
  recordCount++;
  ans.oxy.push(oxy);

  /* 体温（每天 1 条 07:10） */
  const temp = Math.round((36.6 + randFloat(-0.2, 0.3)) * 10) / 10;
  lines.push(recAbs('HKQuantityTypeIdentifierBodyTemperature', 'degC', temp, dayTs, 7 * 60 + 10, 0, { src: 'Apple Watch' }));
  recordCount++;
  ans.temp = temp;

  /* 呼吸频率（每天 1 条 23:00） */
  const resp = randInt(12, 18);
  lines.push(recAbs('HKQuantityTypeIdentifierRespiratoryRate', 'count/min', resp, dayTs, 23 * 60, 0, { src: 'Apple Watch' }));
  recordCount++;
  ans.resp.push(resp);

  /* 体重（每 6 天 1 条，缓慢趋势） */
  if (i % 6 === 0) {
    const w = Math.round((62.4 + Math.sin(i / 40) * 1.6 + randFloat(-0.3, 0.3)) * 100) / 100;
    lines.push(recAbs('HKQuantityTypeIdentifierBodyMass', 'kg', w, dayTs, 7 * 60 + 5, 0, { src: 'Apple Watch' }));
    recordCount++;
    ans.weight = w;
  }

  /* 有氧适能（每月 1 条） */
  if (i % 30 === 0) {
    const vo2 = Math.round((40 + Math.sin(i / 90) * 2.5 + randFloat(-0.5, 0.5)) * 10) / 10;
    lines.push(recAbs('HKQuantityTypeIdentifierVO2Max', 'ml/kg·min', vo2, dayTs, 9 * 60, 0, { src: 'Apple Watch' }));
    recordCount++;
    ans.vo2 = vo2;
  }
}

/* ---- 异常注入 ---- */
const badLines = [];
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="count" creationDate="2024-04-09 10:00:00 +0800" startDate="2024-04-09 10:00:00 +0800" endDate="2024-04-09 10:00:00 +0800"/>');                                        /* 1 缺 value → badValue */
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="count" creationDate="2024-04-09 11:00:00 +0800" startDate="2024-04-09 11:00:00 +0800" endDate="2024-04-09 11:00:00 +0800" value="abc"/>');                                      /* 2 value 非数字 → badValue */
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="count" creationDate="2024-04-09 12:00:00 +0800" startDate="2024-04-09 12:00:00 +0800" endDate="2024-04-09 12:00:00 +0800" value="-500"/>');                                     /* 3 负值 → negative */
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="count" creationDate="2024-13-99 25:99:00 +0800" startDate="2024-13-99 25:99:00 +0800" endDate="2024-13-99 25:99:00 +0800" value="1000"/>');                                 /* 4 坏日期 → badDate */
badLines.push('    <Record type="HKQuantityTypeIdentifierDietaryCaffeine" sourceName="第三方饮食App" sourceVersion="2.1" unit="mg" creationDate="2024-04-09 13:00:00 +0800" startDate="2024-04-09 13:00:00 +0800" endDate="2024-04-09 13:00:00 +0800" value="95"/>');       /* 5 未知类型 → 其他指标 */
badLines.push('    <Record type="HKQuantityTypeIdentifierDietaryCaffeine" sourceName="第三方饮食App" sourceVersion="2.1" unit="mg" creationDate="2024-04-10 13:00:00 +0800" startDate="2024-04-10 13:00:00 +0800" endDate="2024-04-10 13:00:00 +0800" value="120"/>');      /* 6 未知类型 → 其他指标 */
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="furlong" creationDate="2024-04-09 14:00:00 +0800" startDate="2024-04-09 14:00:00 +0800" endDate="2024-04-09 14:00:00 +0800" value="42"/>');                                  /* 7 未知单位 → badUnit */
badLines.push('    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" sourceVersion="1.0" unit="count/min" creationDate="2023-12-31 23:59:00 +0800" startDate="2023-12-31 23:59:00 +0800" endDate="2023-12-31 23:59:00 +0800" value="70"/>');  /* 8 乱序（时间早于文件头）→ 保留 */
badLines.push('    <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone" sourceVersion="1.0" unit="min" creationDate="2024-04-09 15:00:00 +0800" startDate="2024-04-09 15:00:00 +0800" endDate="2024-04-09 15:30:00 +0800" value="HKCategoryValueSleepAnalysisNapping"/>'); /* 9 未知睡眠阶段 → badValue */
badLines.push('    <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" sourceVersion="1.0" unit="count" creationDate="2024-04-09 16:00:00 +0800" startDate="2024-04-09 16:00:00 +0800" endDate="2024-04-09 16:00:00 +0800" value="777"');                                           /* 10 未闭合行 → rows */
badLines.push('    <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone" sourceVersion="1.0" unit="min" creationDate="2024-04-09 23:40:00 +0800" startDate="2024-04-09 23:40:00 +0800" endDate="2024-04-10 00:40:00 +0800" value="HKCategoryValueSleepAnalysisAsleepCore"/>'); /* 11 跨午夜睡眠 → 归开始日 */

lines.push('  <!-- 异常注入区（用于验证健壮性） -->');
for (const b of badLines) lines.push(b);

lines.push('</HealthData>');
const xml = lines.join('\n') + '\n';

fs.writeFileSync(path.join(OUT_DIR, 'export.xml'), xml, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'export-answers.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  days: DAYS,
  recordCount: recordCount,            // 仅正常行
  injectedKept: 4,                     // caffeine×2 + 乱序心率 + 跨午夜睡眠（会被引擎保留）
  injectedDropped: 7,                  // 缺value / abc / 负值 / 坏日期 / furlong / Napping / 未闭合
  daily: answers
}, null, 1), 'utf8');

console.log('sample 生成完成:');
console.log('  文件: sample/export.xml  (' + (xml.length / 1024 / 1024).toFixed(2) + ' MB)');
console.log('  正常记录: ' + recordCount + '  + 异常注入 ' + badLines.length + ' 行');
console.log('  其中: 步数 ' + stepsRecs + ' / 心率 ' + hrRecs + ' / 能量 ' + energyRecs + ' / 睡眠 ' + sleepRecs);
console.log('  答案: sample/export-answers.json');
