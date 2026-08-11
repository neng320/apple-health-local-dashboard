/* _health-check.js — 真实数据健康度检查（数据层面，非医疗建议） */
const fs = require('fs');
const HE = require('../engine.js');
const file = process.argv[2] || 'sample/export-real.xml';
const r = HE.parseText(fs.readFileSync(file, 'utf8'), {});
const D = r.daily;

const checks = [];
function chk(name, ok, detail) { checks.push({ name, ok, detail }); }

/* 值域规则（宽松，仅识别明显异常） */
const RULES = [
  { key: 'steps', label: '步数', min: 0, max: 60000, unit: '步' },
  { key: 'energy', label: '活动能量', min: 0, max: 4000, unit: 'kcal' },
  { key: 'basalEnergy', label: '基础能量', min: 0, max: 4000, unit: 'kcal' },
  { key: 'heartRate', label: '心率', min: 20, max: 250, unit: 'bpm' },
  { key: 'restingHR', label: '静息心率', min: 30, max: 120, unit: 'bpm' },
  { key: 'walkingHR', label: '步行心率', min: 40, max: 180, unit: 'bpm' },
  { key: 'hrv', label: 'HRV', min: 10, max: 600, unit: 'ms' },
  { key: 'oxygen', label: '血氧', min: 85, max: 100, unit: '%' },
  { key: 'temperature', label: '体温', min: 35, max: 42, unit: '°C' },
  { key: 'wristTemp', label: '腕温', min: 30, max: 42, unit: '°C' },
  { key: 'respiratory', label: '呼吸频率', min: 5, max: 40, unit: '次/分' },
  { key: 'bodyMass', label: '体重', min: 30, max: 200, unit: 'kg' },
  { key: 'vo2max', label: '有氧适能', min: 10, max: 70, unit: 'ml/kg·min' },
  { key: 'distance', label: '距离', min: 0, max: 80, unit: 'km' },
  { key: 'flights', label: '爬楼层数', min: 0, max: 200, unit: '层' }
];

console.log('===== 真实数据健康度检查 =====');
console.log('数据: ' + r.stats.recordCount.toLocaleString() + ' 条, ' + HE.fmtDate(r.stats.spanFirst) + ' → ' + HE.fmtDate(r.stats.spanLast));
console.log('跳过: ' + JSON.stringify(r.stats.skipped));
console.log('');

RULES.forEach(function (rule) {
  const d = D[rule.key];
  if (!d || !d.days.length) { console.log('[' + rule.label + '] 无数据'); return; }
  let bad = 0, badDays = [], maxV = -Infinity, minV = Infinity, sum = 0, n = 0;
  d.days.forEach(function (x) {
    const v = x.v;
    if (v == null) return;
    sum += v; n++;
    if (v > maxV) maxV = v;
    if (v < minV) minV = v;
    if (rule.key === 'heartRate') {
      if (x.max > rule.max || x.min < rule.min) { bad++; if (badDays.length < 4) badDays.push(x.d + ' min' + x.min + '/max' + x.max); }
    } else if (v < rule.min || v > rule.max) { bad++; if (badDays.length < 4) badDays.push(x.d + '=' + v); }
  });
  const avg = sum / n;
  const ok = bad === 0;
  console.log('[' + rule.label + '] ' + (ok ? '正常' : '⚠ ' + bad + ' 天异常') +
    '  均值 ' + (avg > 100 ? Math.round(avg) : Math.round(avg * 10) / 10) + rule.unit +
    '  范围 ' + (Math.round(minV * 10) / 10) + '–' + (Math.round(maxV * 10) / 10) + rule.unit +
    '  覆盖 ' + d.days.length + ' 天' + (badDays.length ? '  ' + badDays.join('; ') : ''));
  chk(rule.label, ok, bad + ' 天异常');
});

/* 睡眠三口径 */
console.log('');
['sleep', 'sleepNight', 'sleepNap'].forEach(function (k) {
  const d = D[k];
  if (!d) { console.log('[' + k + '] 无数据'); return; }
  const days = d.days;
  const sum = days.reduce(function (a, x) { return a + (x.v || 0); }, 0);
  const withData = days.filter(function (x) { return x.v > 0; });
  const avg = withData.length ? sum / withData.length : 0;
  const maxD = withData.reduce(function (a, x) { return x.v > a.v ? x : a; }, { v: 0 });
  console.log('[' + (k === 'sleep' ? '总睡眠' : k === 'sleepNight' ? '晚间睡眠' : '午睡') + '] ' + withData.length + ' 天有数据, 日均 ' + (avg / 60).toFixed(1) + 'h, 单日最长 ' + (maxD.v / 60).toFixed(1) + 'h (' + maxD.d + ')');
});

/* 特殊检查：07-16 的拆分（用户提到的日期） */
console.log('');
['2026-07-16', '2026-07-15'].forEach(function (dk) {
  const line = [];
  ['sleep', 'sleepNight', 'sleepNap'].forEach(function (k) {
    const d = D[k];
    const hit = d ? d.days.find(function (x) { return x.d === dk; }) : null;
    line.push(k + '=' + (hit ? (hit.v / 60).toFixed(2) + 'h' : '无'));
  });
  console.log(dk + ': ' + line.join('  '));
});

console.log('');
const fail = checks.filter(function (c) { return !c.ok; });
console.log(fail.length ? '发现异常项: ' + fail.map(function (f) { return f.name; }).join('、') : '所有检查项均正常');
