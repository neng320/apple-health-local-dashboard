/* make-stress.js — 生成约 30 万条记录的压力测试数据（2 年）
 * 输出: sample/export-stress.xml
 * 运行: node scripts/make-stress.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'sample', 'export-stress.xml');

let seed = 99123;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function randInt(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function randFloat(a, b) { return a + rnd() * (b - a); }

const TZ = '+0800';
const DAY_MS = 86400000;
const START = Date.UTC(2023, 0, 1);
const DAYS = 730; // 2 年

const p = n => (n < 10 ? '0' + n : '' + n);
function stamp(ts) {
  const t = new Date(ts);
  return t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) +
    ' ' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) + ' ' + TZ;
}
function rec(type, unit, value, ts) {
  const s = stamp(ts);
  return '    <Record type="' + type + '" sourceName="Apple Watch" sourceVersion="9.0" unit="' + unit +
    '" creationDate="' + s + '" startDate="' + s + '" endDate="' + s + '" value="' + value + '"/>';
}

const lines = [];
lines.push('<?xml version="1.0" encoding="UTF-8"?>');
lines.push('<HealthData locale="zh_CN" exportDate="2025-01-01 00:00:00 +0800">');

let total = 0;
for (let i = 0; i < DAYS; i++) {
  const dayTs = START + i * DAY_MS;

  /* 心率：05:30-23:58 每 4 分钟 1 条 ≈ 279 条/天 */
  for (let m = 330; m <= 1438; m += 4) {
    const ts = dayTs + m * 60000;
    const h = m / 60;
    let v = Math.round(randFloat(58, 100));
    if (h >= 17 && h <= 18.6) v = Math.round(randFloat(120, 175));
    lines.push(rec('HKQuantityTypeIdentifierHeartRate', 'count/min', v, ts));
    total++;
  }
  /* 步数：07:00-23:50 每 10 分钟 1 条 ≈ 102 条/天 */
  for (let m = 420; m <= 1430; m += 10) {
    const ts = dayTs + m * 60000;
    lines.push(rec('HKQuantityTypeIdentifierStepCount', 'count', randInt(0, 220), ts));
    total++;
  }
  /* 活动能量：07:00-23:00 每 15 分钟 1 条 ≈ 65 条/天 */
  for (let m = 420; m <= 1380; m += 15) {
    const ts = dayTs + m * 60000;
    lines.push(rec('HKQuantityTypeIdentifierActiveEnergyBurned', 'kcal', Math.round(randFloat(0, 14)), ts));
    total++;
  }
  /* 少量静息/血氧/体重 */
  if (i % 2 === 0) { lines.push(rec('HKQuantityTypeIdentifierRestingHeartRate', 'count/min', randInt(48, 66), dayTs + 390 * 60000)); total++; }
  if (i % 1 === 0) { lines.push(rec('HKQuantityTypeIdentifierOxygenSaturation', '%', randInt(95, 99), dayTs + 1380 * 60000)); total++; }
  if (i % 7 === 0) { lines.push(rec('HKQuantityTypeIdentifierBodyMass', 'kg', (61 + randFloat(0, 3)).toFixed(2), dayTs + 420 * 60000)); total++; }
}
lines.push('</HealthData>');
const xml = lines.join('\n') + '\n';
fs.writeFileSync(OUT, xml, 'utf8');

console.log('stress 生成完成:');
console.log('  文件: sample/export-stress.xml  (' + (xml.length / 1024 / 1024).toFixed(1) + ' MB)');
console.log('  记录总数: ' + total);
