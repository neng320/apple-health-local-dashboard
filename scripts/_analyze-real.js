/* _analyze-real.js — 流式分析真实 Apple 导出数据（内存友好）
 * 用法: node scripts/_analyze-real.js <xml路径>
 */
const fs = require('fs');
const HE = require('../engine.js');

const file = process.argv[2];
if (!file) { console.error('用法: node scripts/_analyze-real.js <export.xml>'); process.exit(1); }

(async () => {
  const size = fs.statSync(file).size;
  const t0 = Date.now();
  const acc = HE.createAcc();
  const scanner = HE.createScanner(acc);
  const sleepValues = {};
  let chunks = 0;

  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 8 * 1024 * 1024 });
    rs.on('data', (chunk) => {
      chunks++;
      /* 睡眠 value 分布（粗扫，从 chunk 里找 SleepAnalysis 行） */
      let idx = 0;
      while ((idx = chunk.indexOf('SleepAnalysis', idx)) >= 0) {
        const seg = chunk.slice(Math.max(0, idx - 200), idx + 120);
        const vm = /value="([^"]+)"/.exec(seg);
        if (vm) sleepValues[vm[1]] = (sleepValues[vm[1]] || 0) + 1;
        idx += 15;
      }
      scanner.push(chunk);
    });
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  scanner.flush();
  const parseMs = Date.now() - t0;
  const res = HE.finalize(acc, { fileSize: size, fileName: file.split(/[\\/]/).pop(), parseMs });

  console.log('\n===== 真实数据解析报告 =====');
  console.log('文件:', file, '(' + (size / 1048576).toFixed(1) + ' MB)');
  console.log('解析耗时:', (parseMs / 1000).toFixed(2) + ' s  (chunks: ' + chunks + ')');
  console.log('有效记录:', res.stats.recordCount.toLocaleString(), '| 跳过:', JSON.stringify(res.stats.skipped));
  console.log('时间范围:', HE.fmtDate(res.stats.spanFirst), '→', HE.fmtDate(res.stats.spanLast));
  console.log('指标种类:', res.stats.typeCount);
  console.log('\n--- 指标清单（按条数排序，前 25） ---');
  res.types.slice(0, 25).forEach(t => console.log('  ' + String(t.count).padStart(9) + '  ' + (t.label || t.type) + '  [' + t.type + ']'));
  console.log('\n--- 睡眠 value 分布 ---');
  Object.keys(sleepValues).forEach(v => console.log('  ' + String(sleepValues[v]).padStart(8) + '  ' + v));
  console.log('\n--- 每日聚合天数 ---');
  Object.keys(res.daily).forEach(k => {
    const d = res.daily[k];
    console.log('  ' + k.padEnd(12) + ' ' + String(d.days.length).padStart(5) + ' 天  单位=' + d.unit);
  });
  console.log('\n--- 睡眠最近 10 天 ---');
  if (res.daily.sleep) {
    res.daily.sleep.days.slice(-10).forEach(d => {
      console.log('  ' + d.d + '  asleep=' + d.v + 'm  core=' + d.core + ' deep=' + d.deep + ' rem=' + d.rem + ' awake=' + d.awake + ' inBed=' + d.inBed);
    });
    const total = res.daily.sleep.days.reduce((a, d) => a + d.v, 0);
    console.log('  睡眠总天数:', res.daily.sleep.days.length, '总时长:', Math.round(total / 60) + 'h');
  }
  console.log('\n--- 心率最近 5 天 ---');
  if (res.daily.heartRate) {
    res.daily.heartRate.days.slice(-5).forEach(d => console.log('  ' + d.d + '  avg=' + d.v + ' min=' + d.min + ' max=' + d.max + ' n=' + d.n));
    console.log('  心率原始序列:', res.heartRaw ? res.heartRaw.ts.length.toLocaleString() + ' 条' : '无');
  }
  console.log('\n--- 静息/步行心率最近 5 天 ---');
  ['restingHR', 'walkingHR'].forEach(k => {
    if (res.daily[k]) res.daily[k].days.slice(-5).forEach(d => console.log('  ' + k + ' ' + d.d + ' = ' + d.v));
  });
  console.log('\n--- 睡眠目标 ---');
  if (res.daily.sleepGoal) console.log('  ' + JSON.stringify(res.daily.sleepGoal.days.slice(-3)));
  console.log('\n--- 其他指标（前 12） ---');
  res.other.slice(0, 12).forEach(o => console.log('  ' + o.label.padEnd(30) + ' ' + String(o.days.length).padStart(5) + ' 天  unit=' + o.unit));
})();
