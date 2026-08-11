/* ============================================================
 * engine.js — Apple Health export.xml 本地解析引擎
 * 纯本地运行 · 零依赖 · 不发起任何网络请求
 * 浏览器: <script src="engine.js"></script> → window.HealthEngine
 * Node:   const HealthEngine = require('./engine.js')
 *
 * 设计要点：
 *  - 流式逐行扫描（Apple 导出的每个 <Record> 自闭合占一行），
 *    避免把数百 MB XML 整读进 DOM，内存占用低、速度快
 *  - 按记录自身时区偏移聚合到「当地日」，跨时区数据不乱
 *  - 异常行（缺字段/坏值/坏日期/负值/单位异常）跳过并计数，绝不崩溃
 *  - 原始数据只读，不修改、不删除
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HealthEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 指标定义 ---------------- */
  var KNOWN = {
    'HKQuantityTypeIdentifierStepCount': { key: 'steps', kind: 'sum', unit: '步', label: '步数' },
    'HKQuantityTypeIdentifierActiveEnergyBurned': { key: 'energy', kind: 'sum', unit: 'kcal', label: '活动能量' },
    'HKQuantityTypeIdentifierDistanceWalkingRunning': { key: 'distance', kind: 'sum', unit: 'km', label: '步行+跑步距离' },
    'HKQuantityTypeIdentifierHeartRate': { key: 'heartRate', kind: 'range', unit: 'bpm', label: '心率' },
    'HKQuantityTypeIdentifierRestingHeartRate': { key: 'restingHR', kind: 'avg', unit: 'bpm', label: '静息心率' },
    'HKQuantityTypeIdentifierWalkingHeartRateAverage': { key: 'walkingHR', kind: 'avg', unit: 'bpm', label: '步行平均心率' },
    'HKQuantityTypeIdentifierBodyMass': { key: 'bodyMass', kind: 'last', unit: 'kg', label: '体重' },
    'HKQuantityTypeIdentifierVO2Max': { key: 'vo2max', kind: 'avg', unit: 'ml/kg·min', label: '有氧适能' },
    'HKQuantityTypeIdentifierOxygenSaturation': { key: 'oxygen', kind: 'avg', unit: '%', label: '血氧' },
    'HKQuantityTypeIdentifierBodyTemperature': { key: 'temperature', kind: 'avg', unit: '°C', label: '体温' },
    'HKQuantityTypeIdentifierRespiratoryRate': { key: 'respiratory', kind: 'avg', unit: 'count/min', label: '呼吸频率' },
    'HKQuantityTypeIdentifierBasalEnergyBurned': { key: 'basalEnergy', kind: 'sum', unit: 'kcal', label: '基础能量' },
    'HKQuantityTypeIdentifierAppleStandTime': { key: 'standTime', kind: 'sum', unit: 'min', label: '站立时间' },
    'HKQuantityTypeIdentifierAppleExerciseTime': { key: 'exerciseTime', kind: 'sum', unit: 'min', label: '锻炼时间' },
    'HKQuantityTypeIdentifierFlightsClimbed': { key: 'flights', kind: 'sum', unit: '层', label: '爬楼层数' },
    'HKQuantityTypeIdentifierDistanceCycling': { key: 'cycling', kind: 'sum', unit: 'km', label: '骑行距离' },
    'HKQuantityTypeIdentifierHeight': { key: 'height', kind: 'last', unit: 'cm', label: '身高' },
    'HKDataTypeSleepDurationGoal': { key: 'sleepGoal', kind: 'last', unit: 'hr', label: '睡眠目标' },
    'HKQuantityTypeIdentifierWalkingSpeed': { key: 'walkingSpeed', kind: 'avg', unit: 'km/hr', label: '步行速度' },
    'HKQuantityTypeIdentifierWalkingStepLength': { key: 'stepLength', kind: 'avg', unit: 'cm', label: '步长' },
    'HKQuantityTypeIdentifierWalkingDoubleSupportPercentage': { key: 'doubleSupport', kind: 'avg', unit: '%', label: '双足支撑占比' },
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': { key: 'hrv', kind: 'avg', unit: 'ms', label: '心率变异性 HRV' },
    'HKQuantityTypeIdentifierAppleSleepingWristTemperature': { key: 'wristTemp', kind: 'avg', unit: '°C', label: '睡眠腕温' },
    'HKCategoryTypeIdentifierSleepAnalysis': { key: 'sleep', kind: 'sleep', unit: 'min', label: '睡眠' }
  };
  var KEY_TO_TYPE = {};
  for (var t in KNOWN) KEY_TO_TYPE[KNOWN[t].key] = t;

  /* 已知指标 → 期望的导出单位（命中即通过；否则视为单位异常跳过） */
  var EXPECT_UNIT = {
    steps: ['count'],
    energy: ['kcal', 'Cal', 'kCal'],
    distance: ['km', 'mi', 'm'],
    heartRate: ['count/min'],
    restingHR: ['count/min'],
    walkingHR: ['count/min'],
    bodyMass: ['kg', 'lb'],
    vo2max: ['ml/kg·min', 'ml/kg/min'],
    oxygen: ['%'],
    temperature: ['degC', 'degF'],
    respiratory: ['count/min'],
    basalEnergy: ['kcal', 'Cal', 'kCal'],
    standTime: ['min'],
    exerciseTime: ['min'],
    flights: ['count'],
    cycling: ['km', 'mi', 'm'],
    height: ['cm'],
    sleepGoal: ['hr'],
    walkingSpeed: ['km/hr', 'km/h'],
    stepLength: ['cm'],
    doubleSupport: ['%'],
    hrv: ['ms'],
    wristTemp: ['degC', 'degF'],
    sleep: []
  };

  /* 单位归一化（导出写法 → 标准单位与换算系数） */
  var UNIT_NORM = {
    'count': { u: 'count', f: 1 },
    'kcal': { u: 'kcal', f: 1 }, 'Cal': { u: 'kcal', f: 1 }, 'kCal': { u: 'kcal', f: 1 },
    'count/min': { u: 'bpm', f: 1 },
    'kg': { u: 'kg', f: 1 }, 'lb': { u: 'kg', f: 0.45359237 },
    'km': { u: 'km', f: 1 }, 'mi': { u: 'km', f: 1.609344 }, 'm': { u: 'km', f: 0.001 },
    'min': { u: 'min', f: 1 },
    '%': { u: '%', f: 1 },
    'degC': { u: '°C', f: 1 }, 'degF': { u: '°C', f: function (v) { return (v - 32) * 5 / 9; } },
    'ml/kg·min': { u: 'ml/kg·min', f: 1 }, 'ml/kg/min': { u: 'ml/kg·min', f: 1 },
    'cm': { u: 'cm', f: 1 },
    'mg': { u: 'mg', f: 1 }, 'g': { u: 'g', f: 1 },
    'mmHg': { u: 'mmHg', f: 1 },
    'm/s': { u: 'm/s', f: 1 },
    'km/hr': { u: 'km/hr', f: 1 }, 'km/h': { u: 'km/hr', f: 1 },
    'hr': { u: 'hr', f: 1 }, 'h': { u: 'hr', f: 1 },
    'ms': { u: 'ms', f: 1 }
  };

  /* 睡眠阶段值 → 阶段键 */
  var SLEEP_V = {
    'HKCategoryValueSleepAnalysisInBed': 'inBed',
    'HKCategoryValueSleepAnalysisAsleep': 'asleep',
    'HKCategoryValueSleepAnalysisAsleepUnspecified': 'asleep',
    'HKCategoryValueSleepAnalysisAsleepCore': 'core',
    'HKCategoryValueSleepAnalysisAsleepDeep': 'deep',
    'HKCategoryValueSleepAnalysisAsleepREM': 'rem',
    'HKCategoryValueSleepAnalysisAwake': 'awake'
  };

  var KIND_LABEL = { sum: '累计', avg: '平均', range: '范围', last: '最新', sleep: '时长' };
  var HEART_RAW_LIMIT = 2000000; // 心率原始序列上限（分布图用，超出降采样）

  /* ---------------- 工具 ---------------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* Apple 日期: "2024-01-01 12:00:00 +0800" → {ts, offMin}（ts 为 UTC 毫秒） */
  function parseAppleDate(str) {
    if (typeof str !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\s*([+-]\d{4}))?/.exec(str.trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    var offMin = 0;
    if (m[7]) {
      var sign = m[7][0] === '-' ? -1 : 1;
      offMin = sign * (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(3, 5), 10));
    }
    var ts = Date.UTC(y, mo - 1, d, h, mi, s) - offMin * 60000;
    if (isNaN(ts)) return null;
    return { ts: ts, offMin: offMin };
  }

  /* 按记录自身时区偏移聚合到「当地日」键 YYYY-MM-DD */
  function dayKeyOf(ts, offMin) {
    var d = new Date(ts + offMin * 60000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function dkToTs(dk) {
    var p = dk.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function extractAttrs(line) {
    var a = {};
    var re = /([A-Za-z]+)="([^"]*)"/g, m;
    while ((m = re.exec(line)) !== null) a[m[1]] = m[2];
    return a;
  }

  /* ---------------- 累加器 ---------------- */
  function createAcc() {
    return {
      daily: {},      // known key -> Map<dayKey, daySlot>
      other: {},      // 未知 HK type -> {label, unit, map: Map<dayKey,{sum,n}>}
      typeStats: {},  // HK type -> {count, first, last, unit}
      heartRawTs: [], heartRawV: [], // 心率原始序列（分布图）
      hrvRawTs: [], hrvRawV: [],    // HRV 原始序列（睡眠期聚合用）
      sleepSegs: [],                 // 睡眠原始段（单日时间轴）{d, stage, startMin, durMin}
      skipped: { rows: 0, badValue: 0, badDate: 0, negative: 0, badUnit: 0, unknownType: 0, unknownUnit: 0 },
      unitWarned: {},
      recordCount: 0,
      spanFirst: Infinity, spanLast: -Infinity
    };
  }

  function daySlot(acc, key, dk) {
    var m = acc.daily[key];
    if (!m) { m = new Map(); acc.daily[key] = m; }
    var slot = m.get(dk);
    if (!slot) {
      slot = { sum: 0, n: 0, min: Infinity, max: -Infinity, last: 0, lastTs: -1,
               sleep: {}, sleepFirst: Infinity, sleepLast: -Infinity, hasLegacyAsleep: false };
      m.set(dk, slot);
    }
    return slot;
  }

  /* 单条 Record 处理 */
  function processRecord(acc, a) {
    var type = a.type;
    var conf = KNOWN[type];
    var isSleep = conf && conf.key === 'sleep';

    /* 值校验 */
    if (isSleep) {
      if (!SLEEP_V[a.value]) { acc.skipped.badValue++; return; }
    } else {
      if (a.value === undefined || a.value === '' || !isFinite(Number(a.value))) { acc.skipped.badValue++; return; }
      if (Number(a.value) < 0) { acc.skipped.negative++; return; }
    }
    /* 日期校验（睡眠优先 startDate，其余同 Apple 口径用 startDate） */
    var d = parseAppleDate(a.startDate || a.creationDate);
    if (!d) { acc.skipped.badDate++; return; }
    var dk = dayKeyOf(d.ts, d.offMin);

    /* ---- 已知指标：单位校验（睡眠无单位） ---- */
    if (conf && conf.key !== 'sleep') {
      var rawUnit = a.unit || '';
      var exp = EXPECT_UNIT[conf.key];
      if (exp && exp.length && exp.indexOf(rawUnit) === -1) {
        var norm = UNIT_NORM[rawUnit];
        var ok = norm && exp.indexOf(norm.u) !== -1;
        if (!ok) { acc.skipped.badUnit++; return; }
      }
    }

    /* 通过校验：计入统计 */
    acc.recordCount++;
    acc.spanFirst = Math.min(acc.spanFirst, d.ts);
    acc.spanLast = Math.max(acc.spanLast, d.ts);
    var st = acc.typeStats[type];
    if (!st) { st = { count: 0, first: Infinity, last: -Infinity, unit: a.unit || '' }; acc.typeStats[type] = st; }
    st.count++;
    st.first = Math.min(st.first, d.ts);
    st.last = Math.max(st.last, d.ts);

    /* ---- 未知类型：通用指标（每日均值），不丢弃 ---- */
    if (!conf) {      var val = Number(a.value);
      var un = a.unit || '';
      var ui = UNIT_NORM[un];
      if (!ui) { ui = { u: un || '(无)', f: 1 }; if (!acc.unitWarned[un]) { acc.unitWarned[un] = 1; acc.skipped.unknownUnit++; } }
      var o = acc.other[type];
      if (!o) { o = { label: type.replace(/^HK(?:Quantity|Category)TypeIdentifier/, ''), unit: ui.u, map: new Map() }; acc.other[type] = o; }
      var os = o.map.get(dk);
      if (!os) { os = { sum: 0, n: 0 }; o.map.set(dk, os); }
      os.sum += val * (typeof ui.f === 'function' ? ui.f(val) : ui.f); os.n++;
      acc.skipped.unknownType++;
      return;
    }

    /* ---- 已知指标：睡眠按阶段累加分钟 ---- */
    if (conf.key === 'sleep') {
      var stage = SLEEP_V[a.value];
      var e = parseAppleDate(a.endDate || a.startDate);
      if (!e) { acc.skipped.badDate++; return; }
      var durMin = (e.ts - d.ts) / 60000;
      if (durMin < 0) durMin = 0;
      if (durMin > 24 * 60) durMin = 24 * 60; // 单段上限保护
      if (durMin === 0) { acc.skipped.badValue++; return; }
      /* 当地分钟与日分类：18:00–次日 10:30 开始的段 = 晚间睡眠（可延续到 10:30 甚至更晚）；
         10:30–18:00 开始 = 午睡/白天段 */
      var ld = new Date(d.ts + d.offMin * 60000);
      var startMin = ld.getUTCHours() * 60 + ld.getUTCMinutes();
      var isNight = startMin >= 18 * 60 || startMin < 630; // 630 = 10:30
      /* 总睡眠 slot（入睡/醒来时间只用晚间段，避免午睡污染） */
      var slot = daySlot(acc, 'sleep', dk);
      slot.sleep[stage] = (slot.sleep[stage] || 0) + durMin;
      if (stage === 'asleep') slot.hasLegacyAsleep = true;
      if (stage !== 'inBed' && stage !== 'awake' && isNight) {
        slot.sleepFirst = Math.min(slot.sleepFirst, d.ts);
        slot.sleepLast = Math.max(slot.sleepLast, e.ts);
      }
      /* 分口径 slot：晚间 / 午睡 */
      var subKey = isNight ? 'sleepNight' : 'sleepNap';
      var subSlot = daySlot(acc, subKey, dk);
      subSlot.sleep[stage] = (subSlot.sleep[stage] || 0) + durMin;
      if (stage === 'asleep') subSlot.hasLegacyAsleep = true;
      if (stage !== 'inBed' && stage !== 'awake') {
        subSlot.sleepFirst = Math.min(subSlot.sleepFirst, d.ts);
        subSlot.sleepLast = Math.max(subSlot.sleepLast, e.ts);
      }
      /* 原始段（单日时间轴用） */
      if (acc.sleepSegs.length < 200000) acc.sleepSegs.push({ d: dk, stage: stage, startMin: startMin, durMin: durMin, night: isNight ? 1 : 0 });
      return;
    }

    /* ---- 数值指标 ---- */
    var v = Number(a.value);
    var ui2 = UNIT_NORM[rawUnit];
    var f = ui2 ? ui2.f : 1;
    var val2 = typeof f === 'function' ? f(v) : v * f;
    /* Apple 血氧以 0–1 比例 + % 单位导出（如 0.97 = 97%），自动换算 */
    if (conf.key === 'oxygen' && val2 < 2) val2 *= 100;

    var s2 = daySlot(acc, conf.key, dk);
    switch (conf.kind) {
      case 'sum': s2.sum += val2; s2.n++; break;
      case 'avg':
        s2.sum += val2; s2.n++;
        if (conf.key === 'hrv' && acc.hrvRawTs.length < 500000) { acc.hrvRawTs.push(d.ts); acc.hrvRawV.push(val2); }
        break;
      case 'range':
        s2.min = Math.min(s2.min, val2);
        s2.max = Math.max(s2.max, val2);
        s2.sum += val2; s2.n++;
        if (acc.heartRawTs.length < HEART_RAW_LIMIT) { acc.heartRawTs.push(d.ts); acc.heartRawV.push(val2); }
        break;
      case 'last':
        if (d.ts >= s2.lastTs) { s2.last = val2; s2.lastTs = d.ts; }
        s2.n++;
        break;
    }
  }

  /* 行级解析 → 块级解析（兼容单行自闭合 / 长行折行 / 非自闭合 + MetadataEntry）
   * block: 从 '<Record' 到 '/>' 或 '</Record>' 的完整片段 */
  function processBlock(block, acc) {
    var gt = block.indexOf('>');
    if (gt === -1 || block.indexOf('<Record') !== 0) { acc.skipped.rows++; return; }
    var tag = block.slice(0, gt + 1); // 只取 Record 标签自身，排除 MetadataEntry 等子元素
    var a = extractAttrs(tag);
    if (!a.type) { acc.skipped.rows++; return; }
    try { processRecord(acc, a); } catch (e) { acc.skipped.rows++; }
  }

  /* 兼容旧接口：单行自闭合快速路径 */
  function processLine(line, acc) {
    var idx = line.indexOf('<Record');
    if (idx === -1) return;
    var trimmed = line.trim();
    if (trimmed.slice(-2) !== '/>') { acc.skipped.rows++; return; }
    processBlock(line.slice(idx), acc);
  }

  /* 流式块扫描器：兼容折行/跨 chunk */
  function createScanner(acc) {
    var buffer = '';
    return {
      push: function (chunk) {
        buffer += chunk;
        var processed = 0;
        for (;;) {
          var s = buffer.indexOf('<Record', processed);
          if (s === -1) { processed = Math.max(0, buffer.length - 16); break; }
          /* 优先找 '/>'（自闭合或 MetadataEntry 结尾，均能正确截断）；
             找不到才找 '</Record>'（避免对长 buffer 做二次全量扫描） */
          var e1 = buffer.indexOf('/>', s);
          var e;
          if (e1 === -1) {
            var e2 = buffer.indexOf('</Record>', s);
            if (e2 === -1) { processed = s; break; } /* 块未完成，等待更多数据 */
            e = e2;
            processBlock(buffer.slice(s, e + 9), acc);
            processed = e + 2;
          } else {
            processBlock(buffer.slice(s, e1 + 2), acc);
            processed = e1 + 2;
          }
        }
        if (processed > 0) buffer = buffer.slice(processed);
      },
      flush: function () { /* 尾部不完整块忽略 */ }
    };
  }

  /* 文本块扫描（同步，Node/小文件） */
  function scanText(text, acc, opts) {
    var scanner = createScanner(acc);
    var CHUNK = 4 * 1024 * 1024;
    for (var i = 0; i < text.length; i += CHUNK) {
      scanner.push(text.slice(i, i + CHUNK));
      if (opts && opts.onProgress && (i / CHUNK) % 25 === 0) {
        opts.onProgress({ chars: Math.min(i + CHUNK, text.length), total: text.length, phase: 'scan' });
      }
    }
    scanner.flush();
  }

  /* ---------------- 收尾：Map → 排序数组 + 统计 ---------------- */
  function finalize(acc, opts) {
    opts = opts || {};
    var daily = {};
    Object.keys(acc.daily).forEach(function (key) {
      var map = acc.daily[key];
      var isSleepKind = key === 'sleep' || key === 'sleepNight' || key === 'sleepNap';
      var meta = isSleepKind
        ? { kind: 'sleep', unit: 'min', label: key === 'sleep' ? '睡眠' : key === 'sleepNight' ? '晚间睡眠' : '午睡' }
        : (KNOWN[KEY_TO_TYPE[key]] || {});
      var kind = meta.kind || 'avg';
      var days = [];
      map.forEach(function (slot, dk) {
        var item = { d: dk, ts: dkToTs(dk) };
        switch (kind) {
          case 'sum':
            item.v = Math.round(slot.sum); item.n = slot.n; break;
          case 'avg':
            item.v = slot.n ? Math.round(slot.sum / slot.n * 10) / 10 : null;
            item.n = slot.n;
            break;
          case 'range':
            item.v = slot.n ? Math.round(slot.sum / slot.n * 10) / 10 : null;
            item.min = slot.n ? Math.round(slot.min) : null;
            item.max = slot.n ? Math.round(slot.max) : null;
            item.n = slot.n;
            break;
          case 'last':
            item.v = slot.n ? Math.round(slot.last * 100) / 100 : null;
            item.n = slot.n;
            break;
          case 'sleep':
            var s = slot.sleep;
            /* Apple 可能同时导出细分阶段（Core/Deep/REM）与粗粒度 Asleep/Unspecified，
               二者覆盖同一时段（重叠）。细分存在时优先用细分和，否则用粗粒度。 */
            var hasSub = (s.core || 0) + (s.deep || 0) + (s.rem || 0) > 0;
            var asleep = hasSub ? (s.core || 0) + (s.deep || 0) + (s.rem || 0) : (s.asleep || 0);
            item.v = Math.round(asleep);
            /* 在床时长上限保护：单日累计 > 16h 视为异常叠加（如多段重叠记录），截断至 16h */
            item.inBed = Math.min(Math.round(s.inBed || 0), 16 * 60);
            item.core = Math.round(s.core || 0);
            item.deep = Math.round(s.deep || 0);
            item.rem = Math.round(s.rem || 0);
            item.awake = Math.round(s.awake || 0);
            item.asleepRaw = Math.round(s.asleep || 0);
            item.fallAsleepTs = slot.sleepFirst === Infinity ? null : slot.sleepFirst;
            item.wakeTs = slot.sleepLast === -Infinity ? null : slot.sleepLast;
            break;
        }
        days.push(item);
      });
      days.sort(function (x, y) { return x.ts - y.ts; });
      daily[key] = {
        label: meta.label || key,
        kind: kind,
        unit: meta.unit || '',
        days: days
      };
    });

    /* 其他指标（通用展示） */
    var other = [];
    Object.keys(acc.other).forEach(function (type) {
      var o = acc.other[type];
      var days = [];
      o.map.forEach(function (s, dk) {
        days.push({ d: dk, ts: dkToTs(dk), v: Math.round(s.sum / s.n * 100) / 100, n: s.n });
      });
      days.sort(function (x, y) { return x.ts - y.ts; });
      other.push({ type: type, label: o.label, unit: o.unit, days: days });
    });
    other.sort(function (a, b) { return b.days.length - a.days.length; });

    /* 指标清单（摘要用） */
    var types = [];
    Object.keys(acc.typeStats).forEach(function (type) {
      var st = acc.typeStats[type];
      var conf = KNOWN[type];
      types.push({
        type: type,
        label: conf ? conf.label : type.replace(/^HK(?:Quantity|Category)TypeIdentifier/, ''),
        key: conf ? conf.key : null,
        count: st.count,
        first: st.first, last: st.last,
        unit: conf ? conf.unit : (acc.other[type] ? acc.other[type].unit : st.unit)
      });
    });
    types.sort(function (a, b) { return b.count - a.count; });

    var skippedTotal = 0;
    for (var k in acc.skipped) if (k !== 'unknownType' && k !== 'unknownUnit') skippedTotal += acc.skipped[k];

    /* 睡眠期 HRV：只统计落入每晚「入睡→醒来」区间内的 HRV 记录（跨日由绝对时间戳自然处理） */
    if (acc.hrvRawTs.length && daily.sleep) {
      var sleepByDay = {};
      daily.sleep.days.forEach(function (d) { sleepByDay[d.d] = d; });
      var hrvSum = {}, hrvN = {}, hrvFirst = {}, hrvLast = {};
      for (var hi = 0; hi < acc.hrvRawTs.length; hi++) {
        var hts = acc.hrvRawTs[hi];
        var hd = new Date(hts);
        var hdk = hd.getFullYear() + '-' + pad2(hd.getMonth() + 1) + '-' + pad2(hd.getDate());
        var seg = sleepByDay[hdk];
        /* 若当天无睡眠段，尝试前一天（入睡在前一晚的情况） */
        if (!seg) {
          var p = hdk.split('-');
          var pt = Date.UTC(+p[0], +p[1] - 1, +p[2]) - 86400000;
          var pd = new Date(pt);
          var pdk = pd.getFullYear() + '-' + pad2(pd.getMonth() + 1) + '-' + pad2(pd.getDate());
          seg = sleepByDay[pdk];
        }
        if (seg && seg.fallAsleepTs && seg.wakeTs && hts >= seg.fallAsleepTs && hts <= seg.wakeTs) {
          if (!hrvSum[hdk]) { hrvSum[hdk] = 0; hrvN[hdk] = 0; hrvFirst[hdk] = hts; hrvLast[hdk] = hts; }
          hrvSum[hdk] += acc.hrvRawV[hi];
          hrvN[hdk]++;
          hrvFirst[hdk] = Math.min(hrvFirst[hdk], hts);
          hrvLast[hdk] = Math.max(hrvLast[hdk], hts);
        }
      }
      var hrvSleepDays = [];
      Object.keys(hrvSum).forEach(function (dk) {
        hrvSleepDays.push({
          d: dk, ts: dkToTs(dk),
          v: Math.round(hrvSum[dk] / hrvN[dk] * 10) / 10,
          n: hrvN[dk],
          firstTs: hrvFirst[dk], lastTs: hrvLast[dk]
        });
      });
      hrvSleepDays.sort(function (x, y) { return x.ts - y.ts; });
      daily.hrvSleep = { label: '睡眠期 HRV', kind: 'avg', unit: 'ms', days: hrvSleepDays };
    }

    var heartRaw = null;
    if (acc.heartRawTs.length) {
      heartRaw = {
        ts: Float64Array.from(acc.heartRawTs),
        v: Float32Array.from(acc.heartRawV)
      };
    }

    var sleepSegs = acc.sleepSegs.sort(function (x, y) { return x.d < y.d ? -1 : x.d > y.d ? 1 : x.startMin - y.startMin; });

    return {
      version: '1.0.0',
      daily: daily,
      other: other,
      heartRaw: heartRaw,
      sleepSegs: sleepSegs,
      types: types,
      stats: {
        recordCount: acc.recordCount,
        validCount: acc.recordCount - skippedTotal,
        skipped: acc.skipped,
        typeCount: types.length,
        spanFirst: acc.spanFirst === Infinity ? null : acc.spanFirst,
        spanLast: acc.spanLast === -Infinity ? null : acc.spanLast,
        fileSize: opts.fileSize || 0,
        fileName: opts.fileName || '',
        parseMs: opts.parseMs || 0
      }
    };
  }

  /* ---------------- 文本解析（Node 测试 / 小文件） ---------------- */
  function parseText(text, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var acc = createAcc();
    scanText(text, acc, opts);
    var res = finalize(acc, { fileSize: opts.fileSize || text.length, fileName: opts.fileName || '', parseMs: Date.now() - t0 });
    if (res.stats.recordCount === 0) {
      var err = new Error('未在文件中找到任何健康记录（<Record> 条目为 0）。请确认选择的是 Apple 健康导出的 export.xml。');
      err.code = 'NO_RECORDS';
      throw err;
    }
    return res;
  }

  /* ---------------- 浏览器流式解析（大文件友好） ---------------- */
  async function parseFile(file, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var acc = createAcc();
    var scanner = createScanner(acc);
    var totalBytes = file.size;
    var decoder = new TextDecoder('utf-8');
    var bytesRead = 0;
    var headerOk = false;
    var reader = file.stream().getReader();
    try {
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        bytesRead += r.value.byteLength;
        var text = decoder.decode(r.value, { stream: true });
        if (!headerOk) {
          headerOk = text.indexOf('<HealthData') !== -1 || text.indexOf('<Record') !== -1;
          if (!headerOk && bytesRead >= 1024 * 1024) {
            throw new Error('该文件不是 Apple 健康导出的 XML（前 1MB 未找到 <HealthData> 或 <Record>）。请选择 export.zip 解压后的 export.xml。');
          }
        }
        scanner.push(text);
        if (opts.onProgress) opts.onProgress({ bytesRead: bytesRead, totalBytes: totalBytes, phase: 'scan' });
      }
      scanner.flush();
      if (acc.recordCount === 0) {
        throw new Error('解析完成，但文件中没有任何健康记录。请确认选择的是 Apple 健康导出的 export.xml（可先解压 export.zip 查看内容）。');
      }
      var res = finalize(acc, { fileSize: file.size, fileName: file.name, parseMs: Date.now() - t0 });
      if (opts.onProgress) opts.onProgress({ bytesRead: bytesRead, totalBytes: totalBytes, phase: 'done', res: res });
      return res;
    } finally {
      try { reader.releaseLock(); } catch (e) {}
    }
  }

  /* ---------------- 展示辅助 ---------------- */
  function fmtDate(ts, withTime) {
    if (!ts) return '—';
    var d = new Date(ts);
    var s = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    if (withTime) s += ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return s;
  }

  return {
    VERSION: '1.0.0',
    KNOWN: KNOWN,
    KEY_TO_TYPE: KEY_TO_TYPE,
    KIND_LABEL: KIND_LABEL,
    parseAppleDate: parseAppleDate,
    dayKeyOf: dayKeyOf,
    dkToTs: dkToTs,
    createAcc: createAcc,
    processLine: processLine,
    processBlock: processBlock,
    createScanner: createScanner,
    scanText: scanText,
    processRecord: processRecord,
    finalize: finalize,
    parseText: parseText,
    parseFile: parseFile,
    fmtDate: fmtDate
  };
});
