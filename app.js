/* ============================================================
 * app.js — Apple Health 本地看板 看板逻辑（概览 / 睡眠 / 心率 / 其他指标）
 * 依赖: engine.js（window.HealthEngine）
 * ============================================================ */
(function () {
  'use strict';
  if (typeof HealthEngine === 'undefined') {
    document.body.innerHTML = '<div style="max-width:640px;margin:80px auto;color:#F0A49C;font-family:monospace;line-height:2">' +
      '⚠ 加载失败：未找到 engine.js。<br>请将 index.html、engine.js、app.js 放在同一文件夹后再打开。</div>';
    return;
  }
  var HE = HealthEngine;

  /* ---------------- 状态 ---------------- */
  var state = {
    res: null,
    module: 'overview',
    metric: 'steps',
    range: '30d',
    sleepGran: 'day',
    sleepCur: null,          // 'YYYY-MM-DD'
    sleepMode: 'all',        // all | night | nap
    hrGran: 'day',
    hrCur: null,
    metricMod: { sel: null, gran: 'day', cur: null },
    othersSel: null,
    othersRange: '90d'
  };

  var METRIC_CONF = {
    steps: { label: '步数', unit: '步', color: '#E8A33D', kind: 'sum' },
    energy: { label: '活动能量', unit: 'kcal', color: '#F2B45C', kind: 'sum' },
    heartRate: { label: '心率', unit: 'bpm', color: '#4FC3B7', kind: 'range' },
    sleep: { label: '睡眠', unit: 'h', color: '#9B8AFB', kind: 'sleep' },
    bodyMass: { label: '体重', unit: 'kg', color: '#E8A33D', kind: 'last' },
    distance: { label: '步行+跑步距离', unit: 'km', color: '#F2B45C', kind: 'sum' },
    restingHR: { label: '静息心率', unit: 'bpm', color: '#4FC3B7', kind: 'avg' },
    walkingHR: { label: '步行平均心率', unit: 'bpm', color: '#4FC3B7', kind: 'avg' },
    vo2max: { label: '有氧适能', unit: 'ml/kg·min', color: '#E8A33D', kind: 'avg' },
    oxygen: { label: '血氧', unit: '%', color: '#4FC3B7', kind: 'avg' },
    temperature: { label: '体温', unit: '°C', color: '#F2B45C', kind: 'avg' },
    respiratory: { label: '呼吸频率', unit: '次/分', color: '#9B8AFB', kind: 'avg' }
  };
  var RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '1y': 365, 'all': Infinity };
  var SLEEP_COLORS = { core: '#4FC3B7', deep: '#7B6CF6', rem: '#9B8AFB', awake: '#E5655A', inBed: '#3A4048', asleep: '#4FC3B7' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtNum(n) { return Number(n).toLocaleString('zh-CN'); }
  function fmtDur(min) {
    if (min == null || !isFinite(min) || min <= 0) return '—';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return (h ? h + 'h ' : '') + m + 'm';
  }
  function fmtTime(min) {
    if (min == null || !isFinite(min)) return '—';
    var m = ((Math.round(min) % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function dayStr(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shortDay(ts, withYear) {
    var d = new Date(ts);
    return (withYear ? d.getFullYear() + '-' : '') + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayKeyAdd(key, days) {
    var d = new Date(HE.dkToTs(key) + days * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function monthKeyAdd(key, months) {
    var p = key.split('-');
    var y = +p[0], m = +p[1] + months;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function monthEndKey(key) {
    var next = monthKeyAdd(key.slice(0, 7) + '-01', 1);
    return dayKeyAdd(next, -1);
  }
  function weekStartKey(key) {
    var ts = HE.dkToTs(key);
    var d = new Date(ts);
    var dow = (d.getUTCDay() + 6) % 7;
    return dayKeyAdd(key, -dow);
  }
  function weekEndKey(key) { return dayKeyAdd(weekStartKey(key), 6); }
  function localMinOf(ts) { var d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }
  function fmtDelta(delta, suffix) {
    if (delta == null || !isFinite(delta)) return '';
    var cls = delta >= 0 ? 'up' : 'down';
    var arrow = delta >= 0 ? '▲ +' : '▼ ';
    return '<span class="' + cls + '">' + arrow + Math.abs(Math.round(delta)) + ' ' + suffix + '</span>';
  }
  /* 睡眠效率（严格按 Apple 口径）：asleep ⊆ inBed，正常范围 0–100%
   * - inBed 缺失 → 无效（—）
   * - asleep > inBed×1.05 → InBed 记录缺失/矛盾 → 数据异常（不参与评分）
   * - 微小超差（≤5%，Apple 段边界分钟对齐差异）→ clamp 100 */
  function effCalc(asleep, inBed) {
    if (!inBed || !asleep) return { v: null, abnormal: false };
    var eff = asleep / inBed * 100;
    if (eff > 105) return { v: null, abnormal: true };
    return { v: Math.min(100, eff), abnormal: false };
  }
  /* 睡眠时长状态分级（分钟）：<5h 严重不足 / 5–5.5h 不足 / 5.5–8h 正常 / >8h 偏高 */
  function sleepStatus(v) {
    if (v == null || v <= 0) return null;
    if (v < 300) return { label: '严重睡眠不足', color: '#E5655A' };
    if (v < 330) return { label: '睡眠不足', color: '#F59E6B' };
    if (v > 480) return { label: '高于日常', color: '#E8A33D' };
    return { label: '正常范围', color: '#63C77F' };
  }
  /* 午睡时长分级（分钟）：0.5–1h 正常 / 1–1.5h 偏长 / >1.5h 异常 */
  function napStatus(v) {
    if (v == null || v <= 0) return null;
    if (v > 90) return { label: '午睡过长（异常）', color: '#E5655A' };
    if (v > 60) return { label: '午睡偏长', color: '#E8A33D' };
    if (v < 30) return { label: '短午睡', color: '#4FC3B7' };
    return { label: '正常午睡', color: '#63C77F' };
  }
  /* 按当前口径取状态分级 */
  function statusOf(v) { return state.sleepMode === 'nap' ? napStatus(v) : sleepStatus(v); }
  function sleepStatusHtml(v) {
    var st = statusOf(v);
    return st ? '<span style="color:' + st.color + '">' + (st.label.indexOf('不足') >= 0 || st.label.indexOf('过长') >= 0 ? '⚠ ' : st.label.indexOf('高于') >= 0 ? '⚠ ' : '') + st.label + '</span>' : '';
  }
  function pctDelta(cur, prev) {
    if (!prev) return null;
    return Math.round((cur - prev) / prev * 100);
  }

  /* ---------------- 数据访问 ---------------- */
  function getMetricData(metric) {
    var res = state.res;
    if (metric.indexOf('other:') === 0) {
      var type = metric.slice(6);
      for (var i = 0; i < res.other.length; i++) {
        if (res.other[i].type === type) return { days: res.other[i].days, unit: res.other[i].unit, label: res.other[i].label, kind: 'avg' };
      }
      return null;
    }
    var d = res.daily[metric];
    if (!d) return null;
    var conf = METRIC_CONF[metric];
    return { days: d.days, unit: conf.unit, label: conf.label, kind: conf.kind };
  }
  function sliceRange(days, range) {
    if (!days || !days.length) return { list: [], start: null, end: null };
    var end = days[days.length - 1].ts;
    var rd = RANGE_DAYS[range];
    if (rd === undefined) rd = (range === 'all' || range === null) ? Infinity : Number(range);
    if (!isFinite(rd) || isNaN(rd)) rd = Infinity;
    var start = rd === Infinity ? days[0].ts : end - (rd - 1) * 86400000;
    var list = [];
    for (var i = 0; i < days.length; i++) if (days[i].ts >= start) list.push(days[i]);
    return { list: list, start: start, end: end };
  }
  function windowDays(allDays, startKey, endKey) {
    return allDays.filter(function (d) { return d.d >= startKey && d.d <= endKey; });
  }
  function externalRequests() {
    try {
      var entries = performance.getEntriesByType('resource') || [];
      var base = (location.origin === 'null' ? '' : (location.origin || '')) + location.pathname.replace(/[^/]*$/, '');
      var count = 0;
      for (var i = 0; i < entries.length; i++) {
        var n = entries[i].name;
        if (n.indexOf('file://') === 0 || (base && n.indexOf(base) === 0)) continue;
        count++;
      }
      return count;
    } catch (e) { return 0; }
  }

  /* ---------------- 图表基础 ---------------- */
  function setupCanvas(canvas, h) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.parentElement.getBoundingClientRect();
    var W = Math.max(60, Math.round(rect.width));
    var H = h || parseInt(canvas.style.height, 10) || 320;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, W: W, H: H };
  }
  function niceScale(min, max, ticks) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1, 1, 0];
    if (min === max) { min -= 1; max += 1; }
    var step0 = (max - min) / ticks;
    var mag = Math.pow(10, Math.floor(Math.log10(step0)));
    var norm = step0 / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    step *= mag;
    var frac = step < 1 ? String(step).split('.')[1].length : 0;
    return [Math.floor(min / step) * step, Math.ceil(max / step) * step, step, frac];
  }
  function drawGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, step, fmt) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    var n = Math.max(1, Math.round((yMax - yMin) / step));
    for (var i = 0; i <= n; i++) {
      var y = yMin + i * step;
      var py = padT + (1 - (y - yMin) / (yMax - yMin)) * (H - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
      ctx.fillText(fmt ? fmt(y) : (Math.round(y * 100) / 100), padL - 7, py);
    }
    ctx.restore();
  }
  function drawXAxis(ctx, W, H, padL, padR, padT, padB, tickIdxs, list, fmtLabel) {
    ctx.save();
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * (W - padL - padR); };
    var firstYear = new Date(list[0].ts).getFullYear();
    var lastYear = new Date(list[n - 1].ts).getFullYear();
    tickIdxs.forEach(function (idx) {
      var x = xOf(idx);
      var label = fmtLabel ? fmtLabel(list[idx]) : shortDay(list[idx].ts, firstYear !== lastYear);
      ctx.fillText(label, x, H - padB + 7);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.stroke();
    });
    ctx.restore();
    return xOf;
  }
  function xTicks(n, maxN) {
    var step = Math.max(1, Math.ceil(n / maxN));
    var out = [];
    for (var i = 0; i < n; i += step) out.push(i);
    if (out[out.length - 1] !== n - 1) out.push(n - 1);
    return out;
  }
  function attachTip(canvas, tipEl, xOf, yOf, items, tipHtml) {
    function move(ev) {
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var n = items.length;
      if (!n) { tipEl.hidden = true; return; }
      var idx = Math.round((x - xOf(0)) / ((xOf(n - 1) - xOf(0)) || 1) * (n - 1));
      idx = Math.max(0, Math.min(n - 1, idx));
      tipEl.innerHTML = tipHtml(items[idx]);
      tipEl.hidden = false;
      var tRect = tipEl.getBoundingClientRect();
      var left = Math.min(Math.max(6, x + 14), rect.width - tRect.width - 6);
      var top = Math.max(4, yOf(items[idx]) - tRect.height - 10);
      if (top < 4) top = yOf(items[idx]) + 12;
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
    }
    function leave() { tipEl.hidden = true; }
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
    canvas.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      move({ clientX: t.clientX, clientY: t.clientY });
    }, { passive: true });
  }
  function emptyState(canvas, msg) {
    var wrap = canvas.parentElement;
    var old = wrap.querySelector('.chart-empty');
    if (!old) {
      old = document.createElement('div');
      old.className = 'chart-empty';
      old.innerHTML = '<div>' + esc(msg) + '</div><div class="em-line"></div><div>NO DATA</div>';
      wrap.appendChild(old);
    }
    var c = setupCanvas(canvas);
    c.ctx.clearRect(0, 0, c.W, c.H);
  }
  function clearEmpty(wrap) {
    var old = wrap.querySelector('.chart-empty');
    if (old) old.remove();
  }

  /* 折线/面积图（支持多参考线 goals） */
  function drawLineChart(canvas, list, conf, opts) {
    opts = opts || {};
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 16, padT = 16, padB = 28;
    var vals = list.map(function (d) { return d.v; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var goals = opts.goals || (opts.goal != null ? [{ v: opts.goal, label: opts.goalLabel || '' }] : []);
    goals.forEach(function (g) { if (g.v > max) max = g.v; if (g.v < min) min = g.v; });
    var sc = niceScale(min, max, 4);
    var yMin = sc[0], yMax = sc[1], step = sc[2], frac = sc[3];
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var yOf = function (v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; };
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, step, function (v) { return frac ? v.toFixed(frac) : fmtNum(Math.round(v)); });

    goals.forEach(function (g, gi) {
      ctx.save();
      ctx.strokeStyle = g.color || 'rgba(232,163,61,0.55)';
      ctx.setLineDash([5, 4]);
      var gy = yOf(g.v);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = g.color || 'rgba(232,163,61,0.8)';
      ctx.font = '10.5px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(g.label, padL + 4, gy - 5 - gi * 14);
      ctx.restore();
    });

    var color = conf.color || '#E8A33D';
    if (n === 1) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(xOf(0), yOf(list[0].v), 3.2, 0, Math.PI * 2); ctx.fill();
      drawXAxis(ctx, W, H, padL, padR, padT, padB, [0], list);
      attachTip(canvas, opts.tipEl, xOf, yOf, list, function (d) {
        return '<div class="t-date">' + d.d + '</div><div class="t-row"><span>' + esc(conf.label) + '</span><b>' + d.v + ' ' + esc(conf.unit) + '</b></div>';
      });
      return;
    }
    var grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    grad.addColorStop(0, color + '26');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(list[0].v));
    for (var i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(list[i].v));
    ctx.lineTo(xOf(n - 1), yOf(list[n - 1].v));
    ctx.lineTo(xOf(n - 1), H - padB);
    ctx.lineTo(xOf(0), H - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(list[0].v));
    for (var j = 1; j < n; j++) ctx.lineTo(xOf(j), yOf(list[j].v));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(xOf(n - 1), yOf(list[n - 1].v), 2.8, 0, Math.PI * 2); ctx.fill();

    drawXAxis(ctx, W, H, padL, padR, padT, padB, xTicks(n, 7), list, opts.xLabel);
    attachTip(canvas, opts.tipEl, xOf, yOf, list, function (d) {
      var html = '<div class="t-date">' + d.d + '</div><div class="t-row"><span>' + esc(conf.label) + '</span><b>' + d.v + ' ' + esc(conf.unit) + '</b></div>';
      if (opts.tipExtra) html += opts.tipExtra(d);
      return html;
    });
  }

  /* 区间带图（心率：min-max 带 + 均值线） */
  function drawRangeChart(canvas, list, opts) {
    opts = opts || {};
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 16, padT = 16, padB = 28;
    var min = Infinity, max = -Infinity;
    list.forEach(function (d) {
      if (d.min < min) min = d.min; if (d.max > max) max = d.max; if (d.v < min) min = d.v; if (d.v > max) max = d.v;
    });
    if (!isFinite(min)) { emptyState(canvas, '该范围内没有心率数据'); return; }
    var sc = niceScale(min, max, 4);
    var yMin = sc[0], yMax = sc[1], step = sc[2];
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var yOf = function (v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; };
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, step);
    var color = opts.color || '#4FC3B7';
    if (n === 1) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(xOf(0), yOf(list[0].v), 3.2, 0, Math.PI * 2); ctx.fill();
      drawXAxis(ctx, W, H, padL, padR, padT, padB, [0], list);
      attachTip(canvas, opts.tipEl, xOf, yOf, list, function (d) {
        return '<div class="t-date">' + d.d + '</div><div class="t-row"><span>平均</span><b>' + d.v + ' bpm</b></div>' +
          '<div class="t-row"><span>最低/最高</span><b>' + d.min + ' / ' + d.max + '</b></div>';
      });
      return;
    }
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(list[0].max));
    for (var i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(list[i].max));
    for (var j = n - 1; j >= 0; j--) ctx.lineTo(xOf(j), yOf(list[j].min));
    ctx.closePath();
    ctx.fillStyle = color + '1F';
    ctx.fill();
    ctx.strokeStyle = color + '55';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var k = 0; k < n; k++) { if (k === 0) ctx.moveTo(xOf(k), yOf(list[k].max)); else ctx.lineTo(xOf(k), yOf(list[k].max)); }
    ctx.stroke();
    ctx.beginPath();
    for (var k2 = 0; k2 < n; k2++) { if (k2 === 0) ctx.moveTo(xOf(k2), yOf(list[k2].min)); else ctx.lineTo(xOf(k2), yOf(list[k2].min)); }
    ctx.stroke();
    ctx.beginPath();
    for (var k3 = 0; k3 < n; k3++) { if (k3 === 0) ctx.moveTo(xOf(k3), yOf(list[k3].v)); else ctx.lineTo(xOf(k3), yOf(list[k3].v)); }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(xOf(n - 1), yOf(list[n - 1].v), 2.8, 0, Math.PI * 2); ctx.fill();

    drawXAxis(ctx, W, H, padL, padR, padT, padB, xTicks(n, 7), list);
    attachTip(canvas, opts.tipEl, xOf, yOf, list, function (d) {
      return '<div class="t-date">' + d.d + '</div>' +
        '<div class="t-row"><span>平均</span><b>' + d.v + ' bpm</b></div>' +
        '<div class="t-row"><span>最低 / 最高</span><b>' + d.min + ' / ' + d.max + ' bpm</b></div>' +
        '<div class="t-row"><span>采样</span><b>' + fmtNum(d.n) + ' 条</b></div>';
    });
  }

  /* 睡眠堆叠柱（支持双期对比：prevList 淡色背景）
   * 状态标注：<5h 严重不足（红点）、5–5.5h 不足（橙红点）、>8h 偏高（琥珀点）
   * 在床时长以虚线框表示（y 轴 12h 封顶，异常叠加值不再撑高） */
  function drawSleepStack(canvas, list, opts) {
    opts = opts || {};
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 16, padT = 14, padB = 28;
    var maxV = 60;
    list.forEach(function (d) {
      var t = Math.min(d.inBed || 0, 720) + (d.awake || 0);
      if (t > maxV) maxV = t;
    });
    if (opts.prevList) opts.prevList.forEach(function (d) { var t = Math.min(d.inBed || 0, 720) + (d.awake || 0); if (t > maxV) maxV = t; });
    maxV = Math.ceil(maxV / 60) * 60;
    if (maxV <= 60) maxV = 480;
    if (maxV > 720) maxV = 720;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var yOf = function (v) { return padT + (1 - v / maxV) * plotH; };
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H, padL, padR, padT, padB, 0, maxV, maxV / 4, function (v) { return fmtDur(v); });

    var colors = { core: 'rgba(79,195,183,0.85)', deep: '#7B6CF6', rem: '#9B8AFB', awake: 'rgba(229,101,90,0.7)' };
    /* 状态标记 */
    function statusDot(d, x, isPrev) {
      if (isPrev || !d || !d.v) return;
      var st = statusOf(d.v);
      if (!st) return;
      if (st.label.indexOf('不足') >= 0 || st.label.indexOf('高于') >= 0 || st.label.indexOf('过长') >= 0) {
        ctx.fillStyle = st.color;
        ctx.beginPath(); ctx.arc(x, yOf(d.v) - 8, st.label.indexOf('严重') >= 0 ? 4 : 3.2, 0, Math.PI * 2); ctx.fill();
        if (st.label.indexOf('严重') >= 0) {
          ctx.strokeStyle = 'rgba(229,101,90,0.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, yOf(d.v) - 8, 6.5, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    function drawOne(d, i, x, w, isPrev) {
      var base = yOf(0);
      var segs = [['awake', d.awake || 0], ['rem', d.rem || 0], ['deep', d.deep || 0], ['core', d.core || 0]];
      var y = base;
      segs.forEach(function (s) {
        if (!s[1]) return;
        var h = yOf(0) - yOf(s[1]);
        ctx.fillStyle = isPrev ? 'rgba(255,255,255,0.16)' : colors[s[0]];
        ctx.fillRect(x, y - h, w, h);
        y -= h;
      });
      statusDot(d, x + w / 2, isPrev);
      /* 在床时长虚线框（当前期，坐标从底部到在床高度） */
      if (!isPrev && d.inBed > 0) {
        var ibTop = yOf(Math.min(d.inBed, maxV));
        var ibBot = yOf(0);
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, ibTop + 0.5, Math.max(1, w - 1), Math.max(1, ibBot - ibTop - 1));
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
    var bw = Math.max(3, Math.min(24, plotW / n * 0.42));
    var gap = 5;
    if (opts.prevList) {
      list.forEach(function (d, i) {
        var x = xOf(i) - bw - gap / 2;
        if (opts.prevList[i]) drawOne(opts.prevList[i], i, x, bw * 0.9, true);
        drawOne(d, i, xOf(i) + gap / 2, bw * 0.9, false);
      });
    } else {
      list.forEach(function (d, i) {
        var x = xOf(i) - bw / 2;
        drawOne(d, i, x, bw, false);
        if (opts.highlightKey && d.d === opts.highlightKey) {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(x - 3, padT, bw + 6, plotH);
        }
      });
    }
    drawXAxis(ctx, W, H, padL, padR, padT, padB, xTicks(n, 8), list, opts.xLabel);
    attachTip(canvas, opts.tipEl, xOf, function () { return padT + plotH / 2; }, list, function (d) {
      var html = '<div class="t-date">' + d.d + '</div>' +
        '<div class="t-row"><span>总睡眠</span><b>' + fmtDur(d.v) + '</b></div>' +
        '<div class="t-row"><span>状态</span>' + (sleepStatusHtml(d.v) || '<span style="color:#6B7480">—</span>') + '</div>' +
        '<div class="t-row"><span>深睡</span><b>' + fmtDur(d.deep) + '</b></div>' +
        '<div class="t-row"><span>REM</span><b>' + fmtDur(d.rem) + '</b></div>' +
        '<div class="t-row"><span>浅睡</span><b>' + fmtDur(d.core) + '</b></div>' +
        '<div class="t-row"><span>清醒</span><b>' + fmtDur(d.awake) + '</b></div>' +
        '<div class="t-row"><span>在床</span><b>' + fmtDur(d.inBed) + '（虚线框）</b></div>';
      return html;
    });
  }

  /* 单日睡眠时间轴（21:00 → 次日 12:00） */
  function drawSleepTimeline(canvas, segs, dayKey) {
    var c = setupCanvas(canvas, 130);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 16, padT = 10, padB = 24;
    var T0 = 21 * 60, T1 = 36 * 60; // 21:00 → 次日 12:00
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var xOf = function (m) { return padL + (m - T0) / (T1 - T0) * plotW; };
    ctx.clearRect(0, 0, W, H);
    /* 背景网格（每 1h） */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var h = 21; h <= 35; h++) {
      var x = xOf(h * 60);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.fillText(String(h % 24).padStart(2, '0') + ':00', x, H - padB + 5);
    }
    ctx.restore();
    /* 分段 */
    var stageColor = { inBed: '#3A4048', asleep: '#4FC3B7', core: '#4FC3B7', deep: '#7B6CF6', rem: '#9B8AFB', awake: '#E5655A' };
    var y = padT + 4, barH = plotH - 14;
    segs.forEach(function (s) {
      var start = s.startMin >= T0 ? s.startMin : s.startMin + 1440;
      var end = start + s.durMin;
      var x1 = Math.max(xOf(T0), xOf(Math.max(T0, start)));
      var x2 = Math.min(xOf(T1), xOf(Math.min(T1, end)));
      if (x2 <= x1) return;
      ctx.fillStyle = stageColor[s.stage] || '#4FC3B7';
      ctx.fillRect(x1, y, x2 - x1, barH);
    });
    /* 图例 */
    ctx.save();
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var lx = padL;
    Object.keys(stageColor).forEach(function (k) {
      ctx.fillStyle = stageColor[k];
      ctx.fillRect(lx, y + barH + 9, 9, 9);
      ctx.fillStyle = '#6B7480';
      ctx.fillText(k, lx + 13, y + barH + 13);
      lx += 13 + ctx.measureText(k).width + 16;
    });
    ctx.restore();
  }

  /* 双折线（入睡/醒来时间） */
  function drawDualLine(canvas, list, opts) {
    opts = opts || {};
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 16, padT = 16, padB = 28;
    var series = opts.series; /* [{key, color, label, map: fn(d)->min|null}] */
    var vals = [];
    list.forEach(function (d) {
      series.forEach(function (s) {
        var v = s.map(d);
        if (v != null) vals.push(v);
      });
    });
    if (!vals.length) { emptyState(canvas, '该范围内没有入睡/醒来数据'); return; }
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min >= 720) min -= 1440; /* 环形处理：全部为前半夜时 */
    var sc = niceScale(min, max, 5);
    var yMin = sc[0], yMax = sc[1], step = sc[2];
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var yOf = function (v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; };
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, step, function (v) { return fmtTime(v); });
    series.forEach(function (s) {
      ctx.beginPath();
      var started = false;
      list.forEach(function (d, i) {
        var v = s.map(d);
        if (v == null) return;
        var yv = v >= 720 ? v - 1440 : v;
        if (!started) { ctx.moveTo(xOf(i), yOf(yv)); started = true; }
        else ctx.lineTo(xOf(i), yOf(yv));
      });
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      /* 最后点 */
      for (var i = n - 1; i >= 0; i--) {
        var v2 = s.map(list[i]);
        if (v2 != null) {
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(xOf(i), yOf(v2 >= 720 ? v2 - 1440 : v2), 2.4, 0, Math.PI * 2); ctx.fill();
          break;
        }
      }
    });
    drawXAxis(ctx, W, H, padL, padR, padT, padB, xTicks(n, 7), list);
    attachTip(canvas, opts.tipEl, xOf, function () { return padT + plotH / 2; }, list, function (d) {
      var html = '<div class="t-date">' + d.d + '</div>';
      series.forEach(function (s) {
        var v = s.map(d);
        html += '<div class="t-row"><span>' + s.label + '</span><b>' + (v != null ? fmtTime(v) : '—') + '</b></div>';
      });
      return html;
    });
  }

  /* 直方图 */
  function drawHistogram(canvas, tsArr, vArr, lo, hi, opts) {
    opts = opts || {};
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 44, padR = 10, padT = 16, padB = 24;
    var count = hi - lo;
    if (count < 2) { emptyState(canvas, '该范围内采样不足'); return; }
    var minV = 1e9, maxV = -1e9;
    for (var i = lo; i < hi; i++) { var v = vArr[i]; if (v < minV) minV = v; if (v > maxV) maxV = v; }
    var bins = 24;
    var step = Math.max(0.01, (maxV - minV) / bins);
    var bucket = new Array(bins).fill(0);
    for (var j = lo; j < hi; j++) {
      var b = Math.min(bins - 1, Math.floor((vArr[j] - minV) / step));
      bucket[b]++;
    }
    var maxB = 1;
    bucket.forEach(function (x) { if (x > maxB) maxB = x; });
    var sum = 0;
    bucket.forEach(function (x, bi) { sum += x * (minV + step * (bi + 0.5)); });
    var mean = sum / count;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    ctx.clearRect(0, 0, W, H);
    var ysc = niceScale(0, maxB, 4);
    drawGrid(ctx, W, H, padL, padR, padT, padB, 0, ysc[1], ysc[2]);
    var bw = plotW / bins * 0.72;
    var color = opts.color || '#4FC3B7';
    bucket.forEach(function (x, bi) {
      var h = x / maxB * plotH;
      var x0 = padL + bi * (plotW / bins) + (plotW / bins - bw) / 2;
      var grad = ctx.createLinearGradient(0, padT, 0, H - padB);
      grad.addColorStop(0, color);
      grad.addColorStop(1, color + '22');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, H - padB - h, bw, h);
    });
    var mx = padL + (mean - minV) / (step * bins) * plotW;
    ctx.strokeStyle = '#E8A33D';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(mx, padT); ctx.lineTo(mx, H - padB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#E8A33D';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('均值 ' + mean.toFixed(1), mx, padT - 4);
    ctx.fillStyle = '#6B7480';
    ctx.textBaseline = 'top';
    var tickN = Math.min(bins, 6);
    for (var t = 0; t <= tickN; t++) {
      var bi2 = Math.round(t / tickN * (bins - 1));
      ctx.fillText(Math.round(minV + step * bi2) + '', padL + bi2 * (plotW / bins) + (plotW / bins) / 2, H - padB + 5);
    }
    var hit = [];
    bucket.forEach(function (x, bi) {
      hit.push({ lo: Math.round(minV + step * bi), hi: Math.round(minV + step * (bi + 1)), x: padL + bi * (plotW / bins) + (plotW / bins) / 2, count: x });
    });
    attachTip(canvas, opts.tipEl, function () { return 0; }, function () { return H / 2; }, hit, function (d) {
      return '<div class="t-date">' + d.lo + '–' + d.hi + ' bpm</div><div class="t-row"><span>采样数</span><b>' + fmtNum(d.count) + '</b></div>' +
        '<div class="t-row"><span>占比</span><b>' + (count ? (d.count / count * 100).toFixed(1) : 0) + '%</b></div>';
    });
  }
  function lowerBound(arr, x) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function upperBound(arr, x) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /* 周热力（通用） */
  function renderHeatGrid(wrap, days, color, maxVal, tipLabel, tipEl, fmt, colorFn) {
    if (!days.length) {
      wrap.innerHTML = '<div class="chart-empty" style="position:static;padding:36px 0"><div>数据不足</div><div class="em-line"></div><div>NO DATA</div></div>';
      return;
    }
    var rows = [];
    var cur = null;
    var maxV = maxVal || 1;
    days.forEach(function (d) {
      var dt = new Date(d.ts);
      var dow = (dt.getDay() + 6) % 7;
      var wk = weekKey(dt);
      if (!cur || cur.week !== wk) { cur = { week: wk, cells: new Array(7).fill(null) }; rows.push(cur); }
      cur.cells[dow] = d;
      if (d.v > maxV) maxV = d.v;
    });
    /* 按容器宽度分块：每块最多容纳 chunkCols 周，多块纵向堆叠（数据多时上下拓展，不横向溢出）
     * 实际列宽 ≈ 格高(13px) × 宽高比(1.4) + gap(3px) ≈ 21px */
    var cellW = 22;
    var avail = Math.max(240, (wrap.clientWidth || 800) - 34);
    var chunkCols = Math.max(3, Math.floor(avail / cellW));
    var chunks = [];
    for (var ci = 0; ci < rows.length; ci += chunkCols) chunks.push(rows.slice(ci, ci + chunkCols));
    var html = '';
    chunks.forEach(function (chunk) {
      var startWk = chunk[0].week, endWk = chunk[chunk.length - 1].week;
      html += '<div class="heat-chunk"><div class="heat-chunk-label">' + startWk.slice(5) + ' 起' + (chunk.length > 1 ? ' ~ ' + endWk.slice(5) : '') + '</div><div class="heat-chunk-body">';
      html += '<div class="heat-row-label">' + ['一', '二', '三', '四', '五', '六', '日'].map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
      html += '<div class="heat-grid">';
      chunk.forEach(function (r) {
        r.cells.forEach(function (cell) {
          if (!cell) { html += '<div class="heat-cell" style="opacity:.2"></div>'; return; }
          var a = 0.06 + Math.pow(cell.v / maxV, 0.6) * 0.94;
          var col = colorFn ? colorFn(cell) : color;
          html += '<div class="heat-cell" style="background:' + col + ';opacity:' + a.toFixed(3) + '" data-d="' + cell.d + '" data-v="' + cell.v + '"></div>';
        });
      });
      html += '</div></div></div>';
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('.heat-cell[data-d]').forEach(function (cell) {
      cell.addEventListener('mousemove', function (e) {
        var v = +cell.getAttribute('data-v');
        var st = sleepStatus(v);
        tipEl.innerHTML = '<div class="t-date">' + cell.getAttribute('data-d') + '</div><div class="t-row"><span>' + tipLabel + '</span><b>' + (fmt ? fmt(v) : fmtNum(v)) + '</b></div>' +
          '<div class="t-row"><span>状态</span><b>' + (st ? st.label : '—') + '</b></div>';
        tipEl.hidden = false;
        var rect = wrap.getBoundingClientRect();
        var tRect = tipEl.getBoundingClientRect();
        tipEl.style.left = Math.min(Math.max(6, e.clientX - rect.left + 14), rect.width - tRect.width - 6) + 'px';
        tipEl.style.top = Math.max(4, e.clientY - rect.top - tRect.height - 10) + 'px';
      });
      cell.addEventListener('mouseleave', function () { tipEl.hidden = true; });
    });
  }
  function weekKey(dt) {
    var d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
    var day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }

  /* ---------------- 文件导入 ---------------- */
  var fileInput = $('file-input');
  var dropZone = $('drop-zone');

  function showError(msg) {
    var old = $('error-bar');
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.id = 'error-bar';
    bar.textContent = msg;
    $('landing').appendChild(bar);
  }
  function clearError() { var old = $('error-bar'); if (old) old.remove(); }

  function startParse(file) {
    clearError();
    $('landing').hidden = true;
    $('dash').hidden = false;
    var pw = $('progress-wrap');
    pw.hidden = false;
    $('prog-fill').style.width = '0%';
    $('prog-pct').textContent = '0%';
    $('prog-text').textContent = '正在解析 ' + file.name + ' …';
    var t0 = Date.now();
    HE.parseFile(file, {
      onProgress: function (p) {
        var pct = Math.min(100, Math.round(p.bytesRead / p.totalBytes * 100));
        $('prog-fill').style.width = pct + '%';
        $('prog-pct').textContent = pct + '%';
        $('prog-text').textContent = '正在解析 ' + file.name + ' · ' + (p.bytesRead / 1048576).toFixed(0) + ' MB';
        if (p.phase === 'done') $('prog-text').textContent = '解析完成，正在渲染…';
      }
    }).then(function (res) {
      res.stats.parseMs = Date.now() - t0;
      state.res = res;
      state.module = 'overview';
      state.metric = 'steps';
      state.range = '30d';
      state.sleepGran = 'day';
      state.sleepCur = lastSleepDay();
      state.hrGran = 'day';
      state.hrCur = lastDataDay('heartRate');
      state.othersSel = null;
      pw.hidden = true;
      renderBadges();
      switchModule('overview');
      try { document.title = 'Apple Health 本地看板 — ' + res.stats.recordCount.toLocaleString() + ' 条记录 · READY'; } catch (e) {}
    }).catch(function (err) {
      pw.hidden = true;
      $('dash').hidden = true;
      $('landing').hidden = false;
      showError(err && err.message ? err.message : String(err));
    });
  }

  function handleFile(file) {
    if (!file) return;
    var name = file.name.toLowerCase();
    if (name.indexOf('.xml') === -1 && name.indexOf('export') === -1 && file.type.indexOf('xml') === -1) {
      showError('请选择 Apple 健康导出的 export.xml 文件（当前：' + file.name + '）。如果拿到的是 export.zip，请先解压。');
      return;
    }
    startParse(file);
  }
  fileInput.addEventListener('change', function () { handleFile(fileInput.files[0]); fileInput.value = ''; });
  $('btn-file').addEventListener('click', function () { fileInput.click(); });
  dropZone.addEventListener('click', function () { fileInput.click(); });
  dropZone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropZone.addEventListener(ev, function (e) { e.preventDefault(); dropZone.classList.remove('drag'); });
  });
  dropZone.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  /* ---------------- 模块导航 ---------------- */
  function lastDataDay(key) {
    var d = state.res.daily[key];
    return d && d.days.length ? d.days[d.days.length - 1].d : null;
  }
  function lastSleepDay() {
    var days = sleepAllDays();
    if (!days || !days.length) return null;
    for (var i = days.length - 1; i >= 0; i--) if (days[i].v > 0) return days[i].d;
    return days[days.length - 1].d;
  }
  function switchModule(m) {
    state.module = m;
    document.querySelectorAll('.mnav').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-module') === m);
    });
    ['overview', 'sleep', 'heart', 'others'].forEach(function (mod) {
      $('module-' + mod).hidden = mod !== m;
    });
    try {
      if (m === 'overview') renderOverview();
      else if (m === 'sleep') renderSleep();
      else if (m === 'heart') renderHeart();
      else if (m === 'others') renderOthers();
    } catch (e) {
      try { document.title = 'MODULE-ERR:' + m + ':' + (e.message || e) + ' @' + ((e.stack || '').split('\n')[1] || ''); } catch (_) {}
      throw e;
    }
  }
  $('module-nav').addEventListener('click', function (e) {
    var b = e.target.closest('.mnav');
    if (b) switchModule(b.getAttribute('data-module'));
  });

  function renderBadges() {
    var res = state.res;
    var sd = res.daily.sleep, hd = res.daily.heartRate;
    $('badge-overview').textContent = fmtNum(res.stats.recordCount);
    $('badge-sleep').textContent = sd ? sd.days.length + ' 天' : '0';
    $('badge-heart').textContent = hd ? hd.days.length + ' 天' : '0';
    $('badge-others').textContent = res.other.length ? res.other.length + ' 项' : '0';
  }

  /* ================= 概览模块 ================= */
  function renderOverview() {
    renderSummary();
    renderCards();
    renderMetricTabs();
    setRangeTab(state.range);
    drawOverviewMain();
    drawOverviewDist();
    renderOverviewHeat();
    renderOtherTable('other-table');
    renderQuality();
  }
  function renderSummary() {
    var s = state.res.stats;
    var html =
      '<div class="sum-item"><span class="k">文件</span><span class="v">' + esc(s.fileName || '—') + ' · ' + (s.fileSize / 1048576).toFixed(1) + ' MB</span></div>' +
      '<div class="sum-item"><span class="k">总记录</span><span class="v">' + fmtNum(s.recordCount) + '</span></div>' +
      '<div class="sum-item"><span class="k">有效记录</span><span class="v">' + fmtNum(s.validCount) + '</span></div>' +
      '<div class="sum-item"><span class="k">指标种类</span><span class="v cyan">' + s.typeCount + ' 种</span></div>' +
      '<div class="sum-item"><span class="k">覆盖范围</span><span class="v">' + HE.fmtDate(s.spanFirst) + ' → ' + HE.fmtDate(s.spanLast) + '</span></div>' +
      '<div class="sum-item"><span class="k">解析耗时</span><span class="v">' + (s.parseMs / 1000).toFixed(2) + ' s</span></div>' +
      '<div class="sum-item"><span class="k">外部请求</span><span class="v cyan">' + externalRequests() + ' 次</span></div>';
    var strip = $('summary-strip');
    strip.innerHTML = html;
    strip.hidden = false;
  }
  function sparkline(days, color, w, h) {
    if (!days || days.length < 2) return '';
    var max = -Infinity, min = Infinity;
    days.forEach(function (d) { if (d.v > max) max = d.v; if (d.v < min) min = d.v; });
    if (max === min) { max += 1; min -= 1; }
    var pts = days.map(function (d, i) {
      var x = i / (days.length - 1) * (w - 2) + 1;
      var y = h - 3 - (d.v - min) / (max - min) * (h - 6);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var area = 'M' + pts[0].split(',')[0] + ',' + (h - 2) + ' L' + pts.join(' L') + ' L' + pts[pts.length - 1].split(',')[0] + ',' + (h - 2) + ' Z';
    return '<svg class="card-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">' +
      '<path d="' + area + '" fill="' + color + '" opacity="0.10"></path>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.4" opacity="0.85"></polyline></svg>';
  }
  function renderCards() {
    var res = state.res, d = res.daily;
    var latestTs = res.stats.spanLast;
    var isToday = dayStr(latestTs) === dayStr(Date.now());
    var cards = [];
    function addCard(conf, valueHtml, subHtml, sparkDays, color) {
      cards.push(
        '<div class="card ' + (conf.cls || '') + (valueHtml ? '' : ' no-data') + '" data-goto="' + conf.goto + '" role="button" tabindex="0" aria-label="' + esc(conf.label) + '">' +
        '<div class="card-head"><span class="card-label"><span class="dot" style="background:' + color + '"></span>' + conf.label + '</span>' +
        '<span class="card-date">' + (isToday ? 'TODAY' : 'LATEST · ' + shortDay(latestTs, true)) + '</span></div>' +
        '<div class="card-value">' + (valueHtml || 'NO DATA') + '</div>' +
        '<div class="card-sub">' + (subHtml || '&nbsp;') + '</div>' +
        sparkline(sparkDays, color, 92, 24) + '</div>'
      );
    }
    var st = d.steps ? d.steps.days : [];
    var stLast = st.length ? st[st.length - 1] : null;
    var stSub = '';
    if (stLast && st.length > 1) {
      var prev = st[st.length - 2];
      var delta = stLast.v - prev.v;
      var pct = prev.v ? Math.round(delta / prev.v * 100) : 0;
      stSub = (delta >= 0 ? '<span class="up">▲ +' + fmtNum(delta) : '<span class="down">▼ ' + fmtNum(delta)) + ' 步</span> vs 昨日（' + (pct >= 0 ? '+' : '') + pct + '%）';
    }
    addCard({ label: '步数', cls: 'amber', goto: 'overview:steps' }, stLast ? fmtNum(stLast.v) + '<small>步</small>' : '', stSub, st.slice(-7), '#E8A33D');

    var en = d.energy ? d.energy.days : [];
    var enLast = en.length ? en[en.length - 1] : null;
    var enSub = '';
    if (enLast && en.length > 1) {
      var ep = en[en.length - 2];
      var eDelta = enLast.v - ep.v;
      enSub = (eDelta >= 0 ? '<span class="up">▲ +' + fmtNum(eDelta) : '<span class="down">▼ ' + fmtNum(eDelta)) + ' kcal</span> vs 昨日';
    }
    addCard({ label: '活动能量', cls: 'amber', goto: 'overview:energy' }, enLast ? fmtNum(enLast.v) + '<small>kcal</small>' : '', enSub, en.slice(-7), '#F2B45C');

    var hr = d.heartRate ? d.heartRate.days : [];
    var hrLast = hr.length ? hr[hr.length - 1] : null;
    var rr = d.restingHR ? d.restingHR.days : [];
    var rrLast = rr.length ? rr[rr.length - 1] : null;
    var hrSub = '';
    if (hrLast) {
      hrSub = '区间 ' + hrLast.min + '–' + hrLast.max + ' bpm · ' + fmtNum(hrLast.n) + ' 条';
      if (rrLast) hrSub += ' · 静息 ' + rrLast.v;
    }
    addCard({ label: '心率', cls: 'cyan', goto: 'heart:day' }, hrLast ? hrLast.v + '<small>bpm</small>' : '', hrSub, hr.slice(-7), '#4FC3B7');

    var sl = d.sleep ? d.sleep.days : [];
    var slLast = null;
    for (var i = sl.length - 1; i >= 0; i--) { if (sl[i].v > 0) { slLast = sl[i]; break; } }
    var slSub = '';
    if (slLast) {
      var deepPct = slLast.v ? Math.round(slLast.deep / slLast.v * 100) : 0;
      slSub = '深睡 ' + fmtDur(slLast.deep) + '（' + deepPct + '%）';
    }
    addCard({ label: '睡眠', cls: 'violet', goto: 'sleep:day' }, slLast ? fmtDur(slLast.v) : '', slSub, sl.slice(-7), '#9B8AFB');

    var wm = d.bodyMass ? d.bodyMass.days : [];
    var wmLast = wm.length ? wm[wm.length - 1] : null;
    var wmSub = '';
    if (wmLast && wm.length > 1) {
      var weekAgo = wm[Math.max(0, wm.length - 8)];
      var wDelta = Math.round((wmLast.v - weekAgo.v) * 100) / 100;
      wmSub = (wDelta <= 0 ? '<span class="up">▼ ' : '<span class="down">▲ +') + wDelta.toFixed(2) + ' kg</span> 近 7 天';
    }
    addCard({ label: '体重', cls: 'amber', goto: 'overview:bodyMass' }, wmLast ? wmLast.v.toFixed(1) + '<small>kg</small>' : '', wmSub, wm.slice(-7), '#E8A33D');

    var ds = d.distance ? d.distance.days : [];
    var dsLast = ds.length ? ds[ds.length - 1] : null;
    var dsSub = '';
    if (dsLast && ds.length > 1) {
      var dp = ds[ds.length - 2];
      var dDelta = Math.round((dsLast.v - dp.v) * 100) / 100;
      dsSub = (dDelta >= 0 ? '<span class="up">▲ +' : '<span class="down">▼ ') + dDelta.toFixed(2) + ' km</span> vs 昨日';
    }
    addCard({ label: '步行+跑步距离', goto: 'overview:distance' }, dsLast ? dsLast.v.toFixed(2) + '<small>km</small>' : '', dsSub, ds.slice(-7), '#F2B45C');

    var wrap = $('today-cards');
    wrap.innerHTML = cards.join('');
    wrap.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('click', function () {
        var g = card.getAttribute('data-goto');
        if (g === 'sleep:day') { state.sleepGran = 'day'; switchModule('sleep'); }
        else if (g === 'heart:day') { state.hrGran = 'day'; switchModule('heart'); }
        else if (g.indexOf('overview:') === 0) { state.metric = g.slice(9); renderMetricTabs(); drawOverviewMain(); }
      });
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter') card.click(); });
    });
  }
  function renderMetricTabs() {
    var wrap = $('metric-tabs');
    var html = '';
    var order = ['steps', 'energy', 'heartRate', 'sleep', 'bodyMass', 'distance', 'restingHR', 'vo2max', 'oxygen', 'temperature', 'respiratory'];
    order.forEach(function (m) {
      if (state.res.daily[m] && state.res.daily[m].days.length) {
        html += '<button class="tab' + (state.metric === m ? ' active' : '') + '" data-metric="' + m + '">' + METRIC_CONF[m].label + '</button>';
      }
    });
    if (state.res.other.length) {
      var opts = '<option value="">其他 ▾</option>';
      state.res.other.forEach(function (o) {
        opts += '<option value="other:' + esc(o.type) + '"' + (state.metric === 'other:' + o.type ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      });
      html += '<select class="other-select" id="other-select">' + opts + '</select>';
    }
    wrap.innerHTML = html;
    wrap.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var m = t.getAttribute('data-metric');
        if (m === 'sleep') { switchModule('sleep'); return; }
        state.metric = m;
        renderMetricTabs();
        drawOverviewMain();
      });
    });
    var sel = $('other-select');
    if (sel) sel.addEventListener('change', function () { if (sel.value) { state.metric = sel.value; renderMetricTabs(); drawOverviewMain(); } });
  }
  function setRangeTab(r) {
    $('range-tabs').querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-range') === r);
    });
  }
  $('range-tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (t) { state.range = t.getAttribute('data-range'); setRangeTab(state.range); drawOverviewMain(); drawOverviewDist(); renderOverviewHeat(); }
  });
  function drawOverviewMain() {
    var wrap = $('main-wrap');
    clearEmpty(wrap);
    var data = getMetricData(state.metric);
    if (!data || !data.days.length) { emptyState($('main-chart'), '该指标在导出数据中没有记录'); setChartMeta('—', '—', '—'); return; }
    var rng = sliceRange(data.days, state.range);
    if (!rng.list.length) { emptyState($('main-chart'), '该指标在此时间范围内没有记录'); setChartMeta(data.label, data.unit, '0 天'); return; }
    var metric = state.metric;
    if (metric === 'sleep') drawSleepStack($('main-chart'), rng.list, { tipEl: $('chart-tip'), highlightKey: lastSleepDay() });
    else if (metric === 'heartRate') drawRangeChart($('main-chart'), rng.list, { tipEl: $('chart-tip') });
    else drawLineChart($('main-chart'), rng.list, { label: data.label, unit: data.unit, color: (METRIC_CONF[metric] || {}).color || '#E8A33D' }, { tipEl: $('chart-tip'), tipExtra: function (d) { return d.n ? '<div class="t-row"><span>记录数</span><b>' + fmtNum(d.n) + '</b></div>' : ''; } });
    var days = rng.list.length;
    var first = rng.list[0], last = rng.list[days - 1];
    setChartMeta(data.label, data.unit, (days === 1 ? dayStr(first.ts) : shortDay(first.ts, true) + ' → ' + shortDay(last.ts, true)) + ' · ' + days + ' 天');
  }
  function setChartMeta(label, unit, span) {
    $('chart-meta').innerHTML =
      '<span><b>指标：</b>' + esc(label) + '（' + esc(unit) + '）</span>' +
      '<span><b>范围：</b>' + esc(span) + '</span>' +
      '<span><b>悬停</b>查看每日数值</span>';
  }
  function drawOverviewDist() {
    var res = state.res;
    var canvas = $('dist-chart');
    clearEmpty(canvas.parentElement);
    if (!res.heartRaw) { emptyState(canvas, '心率数据不足'); return; }
    var rng = sliceRange(res.daily.heartRate ? res.daily.heartRate.days : [], state.range);
    var lo = lowerBound(res.heartRaw.ts, rng.start), hi = upperBound(res.heartRaw.ts, rng.end);
    drawHistogram(canvas, res.heartRaw.ts, res.heartRaw.v, lo, hi, { tipEl: $('dist-tip') });
  }
  function renderOverviewHeat() {
    var data = getMetricData('steps');
    var wrap = $('heat-wrap');
    if (!data || !data.days.length) {
      wrap.innerHTML = '<div class="chart-empty" style="position:static;padding:36px 0"><div>步数数据不足</div><div class="em-line"></div><div>NO DATA</div></div>';
      $('heat-range-label').textContent = '—';
      return;
    }
    var range = state.range === 'all' ? 'all' : String(Math.min(RANGE_DAYS[state.range], 420));
    var rng = sliceRange(data.days, range);
    $('heat-range-label').textContent = rng.list.length + ' 天 · ' + shortDay(rng.list[0].ts, true) + ' → ' + shortDay(rng.list[rng.list.length - 1].ts, true);
    renderHeatGrid(wrap, rng.list, 'rgba(232,163,61,1)', 0, '步数', $('dist-tip'));
  }
  function renderOtherTable(tableId) {
    var other = state.res.other;
    var panel = $('other-panel');
    if (tableId === 'other-table') {
      if (!other.length) { panel.hidden = true; return; }
      panel.hidden = false;
    }
    var rows = other.map(function (o) {
      var last = o.days[o.days.length - 1];
      var latest = last ? last.v + ' ' + esc(o.unit) : '—';
      return '<tr data-metric="other:' + esc(o.type) + '"><td>' + esc(o.label) + '</td><td class="mut">' + esc(o.type.replace(/^HK(?:Quantity|Category)TypeIdentifier/, '')) + '</td>' +
        '<td class="num">' + fmtNum(o.days.length) + '</td><td class="mut">' + o.days.length + ' 天</td><td class="num">' + latest + '</td></tr>';
    }).join('');
    $('other-table').innerHTML =
      '<thead><tr><th>指标</th><th>原始类型</th><th>记录天数</th><th>覆盖</th><th>最新日均</th></tr></thead><tbody>' + rows + '</tbody>';
    $('other-table').querySelectorAll('tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function () { state.metric = tr.getAttribute('data-metric'); renderMetricTabs(); drawOverviewMain(); });
    });
  }
  function renderQuality() {
    var s = state.res.stats;
    var sk = s.skipped;
    var items = [
      { k: '总记录 / 有效', v: fmtNum(s.recordCount) + ' / ' + fmtNum(s.validCount), cls: '' },
      { k: '跳过·结构', v: fmtNum(sk.rows), cls: sk.rows ? 'warn' : 'ok' },
      { k: '跳过·值', v: fmtNum(sk.badValue), cls: sk.badValue ? 'warn' : 'ok' },
      { k: '跳过·日期', v: fmtNum(sk.badDate), cls: sk.badDate ? 'warn' : 'ok' },
      { k: '跳过·负值', v: fmtNum(sk.negative), cls: sk.negative ? 'warn' : 'ok' },
      { k: '跳过·单位', v: fmtNum(sk.badUnit), cls: sk.badUnit ? 'warn' : 'ok' },
      { k: '其他指标记录', v: fmtNum(sk.unknownType), cls: '' },
      { k: '外部网络请求', v: externalRequests() + ' 次', cls: externalRequests() ? 'warn' : 'ok' }
    ];
    $('qual-grid').innerHTML = items.map(function (it) {
      return '<div class="qual-item ' + it.cls + '"><div class="k">' + it.k + '</div><div class="v">' + it.v + '</div></div>';
    }).join('');
    var notes = [];
    if (sk.unknownType) notes.push('有 ' + fmtNum(sk.unknownType) + ' 条记录来自未收录类型（如饮食、步态等），已在「其他指标」中通用展示。');
    if (sk.rows || sk.badValue || sk.badDate || sk.negative || sk.badUnit) notes.push('被跳过的异常行不会影响其他指标统计，也不会导致页面崩溃。');
    if (!notes.length) notes.push('未发现异常数据。所有指标按 Apple 原始记录聚合展示。');
    $('qual-note').innerHTML = notes.map(function (n) { return '<div><b>◈</b> ' + n + '</div>'; }).join('');
  }

  /* 睡眠模块：按口径（全部/晚间/午睡）取数据 */
  var SLEEP_MODE_KEY = { all: 'sleep', night: 'sleepNight', nap: 'sleepNap' };
  function sleepAllDays() {
    var k = SLEEP_MODE_KEY[state.sleepMode] || 'sleep';
    return state.res.daily[k] ? state.res.daily[k].days : [];
  }
  function sleepDataDays() { return sleepAllDays().filter(function (d) { return d.v > 0 || d.inBed > 0; }); }
  function setSleepMode(m) {
    state.sleepMode = m;
    state.sleepCur = lastSleepDay();
    document.querySelectorAll('#sleep-mode-tabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-mode') === m); });
    renderSleep();
  }
  $('sleep-mode-tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (t) setSleepMode(t.getAttribute('data-mode'));
  });
  function setSleepGran(g) {
    state.sleepGran = g;
    document.querySelectorAll('#sleep-gran-tabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-gran') === g); });
    if (g === 'week' && state.sleepCur) state.sleepCur = weekStartKey(state.sleepCur);
    if (g === 'month' && state.sleepCur) state.sleepCur = state.sleepCur.slice(0, 7) + '-01';
    renderSleep();
  }
  $('sleep-gran-tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (t) setSleepGran(t.getAttribute('data-gran'));
  });
  function sleepWindow(cur) {
    var g = state.sleepGran;
    if (g === 'day') return { start: cur, end: cur, label: cur };
    if (g === 'week') {
      var ws = weekStartKey(cur), we = weekEndKey(cur);
      return { start: ws, end: we, label: ws.slice(5) + ' ~ ' + we.slice(5) + ' 周' };
    }
    var mStart = cur.slice(0, 7) + '-01', mEnd = monthEndKey(cur);
    return { start: mStart, end: mEnd, label: cur.slice(0, 7) + ' 月' };
  }
  function prevSleepWindow() {
    var g = state.sleepGran, cur = state.sleepCur;
    if (g === 'day') {
      var days = sleepDataDays();
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx > 0 ? days[idx - 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), -7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', -1);
  }
  function nextSleepWindow() {
    var g = state.sleepGran, cur = state.sleepCur;
    if (g === 'day') {
      var days = sleepDataDays();
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx >= 0 && idx < days.length - 1 ? days[idx + 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), 7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', 1);
  }
  function aggSleepDays(days) {
    var a = { asleep: 0, deep: 0, rem: 0, core: 0, awake: 0, inBed: 0, n: 0, fallSum: 0, wakeSum: 0, tN: 0 };
    days.forEach(function (d) {
      a.asleep += d.v; a.deep += d.deep; a.rem += d.rem; a.core += d.core; a.awake += d.awake; a.inBed += d.inBed;
      if (d.v > 0 || d.inBed > 0) a.n++;
      if (d.fallAsleepTs) { a.fallSum += localMinOf(d.fallAsleepTs); a.tN++; }
      if (d.wakeTs) { a.wakeSum += localMinOf(d.wakeTs); }
    });
    return a;
  }
  function avgFall(a) {
    if (!a.tN) return null;
    var sum = a.fallSum;
    var vals = [];
    return null;
  }
  function renderSleep() {
    var all = sleepAllDays();
    var win = sleepWindow(state.sleepCur);
    var inWin = windowDays(all, win.start, win.end);
    var agg = aggSleepDays(inWin);
    var prevCur = prevSleepWindow();
    var prevAgg = prevCur ? aggSleepDays(windowDays(all, sleepWindow(prevCur).start, sleepWindow(prevCur).end)) : null;
    var isDay = state.sleepGran === 'day';
    var hasData = agg.n > 0 || inWin.length > 0;

    function step(name, fn) {
      try { fn(); } catch (e) {
        try { document.title = 'SLEEP-STEP:' + name + ':' + (e.message || e) + ' @' + ((e.stack || '').split('\n')[1] || ''); } catch (_) {}
        throw e;
      }
    }
    step('label', function () {
      var modeLabel = state.sleepMode === 'all' ? '全部睡眠（晚间+午睡）' : state.sleepMode === 'night' ? '仅晚间睡眠（18:00–次日 10:30 开始）' : '仅午睡段（10:30–18:00 开始）';
      $('sleep-cur-label').textContent = win.label;
      $('sleep-prev').disabled = !prevCur;
      $('sleep-next').disabled = !nextSleepWindow();
      $('sleep-chart-meta').innerHTML =
        '<span><b>口径：</b>' + modeLabel + '</span>' +
        '<span><b>粒度：</b>' + (isDay ? '单日详情（上方时间轴 + 近 30 天趋势）' : state.sleepGran === 'week' ? '本周 7 天 vs 上周（浅色）' : '本月每日 vs 上月（浅色）') + '</span>' +
        '<span><b>柱色：</b><span class="legend"><span><i style="background:#4FC3B7"></i>浅睡</span><span><i style="background:#7B6CF6"></i>深睡</span><span><i style="background:#9B8AFB"></i>REM</span><span><i style="background:#E5655A"></i>清醒</span></span></span>';
    });
    step('cards', function () { renderSleepCards(agg, inWin, prevAgg, isDay, prevCur); });
    step('score', function () { renderSleepScore(agg, isDay ? (inWin[0] ? inWin[0] : null) : null); });
    step('history', function () { renderSleepHistory(); });
    step('main', function () { renderSleepMain(all, inWin, win, prevCur, isDay); });
    step('stages', function () { renderSleepStages(agg, isDay ? (inWin[0] ? inWin[0] : null) : null); });
    step('timing', function () {
      var t30 = all.slice(-30);
      drawDualLine($('sleep-timing-chart'), t30, {
        tipEl: $('sleep-timing-tip'),
        series: [
          { key: 'fall', color: '#4FC3B7', label: '入睡', map: function (d) { return d.fallAsleepTs ? localMinOf(d.fallAsleepTs) : null; } },
          { key: 'wake', color: '#F2B45C', label: '醒来', map: function (d) { return d.wakeTs ? localMinOf(d.wakeTs) : null; } }
        ]
      });
    });
    step('trend', function () { renderSleepWeeklyTrend(); });
    step('heat', function () { renderSleepHeat(); });
    step('hrv', function () { renderSleepHrv(); });
    step('extra', function () { renderSleepExtra(); });
  }
  function renderSleepCards(agg, inWin, prevAgg, isDay, prevCur) {
    var cards = [];
    function card(label, value, sub, color, cls) {
      cards.push('<div class="card ' + (cls || '') + (value ? '' : ' no-data') + '" style="cursor:default"><div class="card-head"><span class="card-label"><span class="dot" style="background:' + color + '"></span>' + label + '</span></div>' +
        '<div class="card-value">' + (value || 'NO DATA') + '</div><div class="card-sub">' + (sub || '&nbsp;') + '</div></div>');
    }
    function vsPrev(curVal, prevVal, suffix, betterLower) {
      if (prevVal == null || !curVal) return '';
      var delta = curVal - prevVal;
      var good = betterLower ? delta < 0 : delta > 0;
      var cls = good ? 'up' : 'down';
      return '<span class="' + cls + '">' + (delta >= 0 ? '▲ +' : '▼ ') + Math.abs(Math.round(delta)) + ' ' + suffix + '</span> vs 上期';
    }
    var hasData = agg.n > 0 || inWin.length > 0;
    /* 全部口径时显示晚间/午睡拆分 */
    var splitHtml = '';
    if (state.sleepMode === 'all') {
      var nKey = state.res.daily.sleepNight, pKey = state.res.daily.sleepNap;
      var nWin = nKey ? windowDays(nKey.days, inWin.length ? inWin[0].d : (nKey.days.length ? nKey.days[nKey.days.length - 1].d : ''), inWin.length ? inWin[inWin.length - 1].d : '') : [];
      var pWin = pKey ? windowDays(pKey.days, inWin.length ? inWin[0].d : (pKey.days.length ? pKey.days[pKey.days.length - 1].d : ''), inWin.length ? inWin[inWin.length - 1].d : '') : [];
      var nV = 0, pV = 0;
      nWin.forEach(function (d) { nV += d.v || 0; });
      pWin.forEach(function (d) { pV += d.v || 0; });
      if (isDay) { nV = nWin.length ? (nWin[0].v || 0) : 0; pV = pWin.length ? (pWin[0].v || 0) : 0; }
      splitHtml = '<br><span style="color:#4FC3B7">晚间 ' + fmtDur(nV) + '</span> · <span style="color:#E8A33D">午睡 ' + fmtDur(pV) + '</span>';
    }
    if (hasData) {
      var curAsleep = isDay ? (inWin[0] ? inWin[0].v : 0) : (agg.n ? agg.asleep / agg.n : 0);
      var prevAsleep = prevAgg ? (isDay ? (prevAgg.n ? prevAgg.asleep : null) : (prevAgg.n ? prevAgg.asleep / prevAgg.n : 0)) : null;
      var statusHtml2 = (function () {
        var st = statusOf(curAsleep);
        if (!st) return '';
        var warn = st.label.indexOf('不足') >= 0 || st.label.indexOf('高于') >= 0;
        return '<span style="color:' + st.color + '">' + (warn ? '⚠ ' : '') + st.label + (st.label.indexOf('严重') >= 0 ? ' · 需重点关注' : '') + '</span>';
      })();
      card('总睡眠', fmtDur(curAsleep), statusHtml2 + ' ' + vsPrev(curAsleep, prevAsleep, 'min', false) + (agg.n ? ' · ' + agg.n + ' 晚' : '') + splitHtml, '#9B8AFB', 'violet');
      var curDeep = isDay ? (inWin[0] ? inWin[0].deep : 0) : (agg.n ? agg.deep / agg.n : 0);
      var deepPct = curAsleep ? Math.round(curDeep / curAsleep * 100) : 0;
      card('深睡', fmtDur(curDeep), '占比 ' + deepPct + '%' + (deepPct < 15 ? '（偏低）' : deepPct > 25 ? '（偏高）' : '（正常）'), '#7B6CF6');
      var curRem = isDay ? (inWin[0] ? inWin[0].rem : 0) : (agg.n ? agg.rem / agg.n : 0);
      card('REM', fmtDur(curRem), '占比 ' + (curAsleep ? Math.round(curRem / curAsleep * 100) : 0) + '%', '#9B8AFB');
      var eff = agg.inBed ? Math.round(agg.asleep / agg.inBed * 100) : null;
      card('睡眠效率', eff != null ? eff + '<small>%</small>' : '', eff != null ? (eff > 90 ? '良好' : eff > 80 ? '正常' : '偏低') : '在床时长缺失', '#E8A33D', 'amber');
      var fallMin = isDay ? (inWin[0] && inWin[0].fallAsleepTs ? localMinOf(inWin[0].fallAsleepTs) : null) : avgCircular(agg, 'fall');
      var wakeMin = isDay ? (inWin[0] && inWin[0].wakeTs ? localMinOf(inWin[0].wakeTs) : null) : (agg.tN ? agg.wakeSum / agg.tN : null);
      card('入睡时间', fmtTime(fallMin), isDay ? '' : '窗口内平均', '#4FC3B7', 'cyan');
      card('醒来时间', fmtTime(wakeMin), isDay ? '' : '窗口内平均', '#4FC3B7', 'cyan');
    } else {
      ['总睡眠', '深睡', 'REM', '睡眠效率', '入睡时间', '醒来时间'].forEach(function (l) { card(l, '', '', '#9B8AFB'); });
    }
    $('sleep-cards').innerHTML = cards.join('');
  }
  /* 睡眠质量评分（参考 Apple Sleep Score：时长 / 效率 / 深睡 / 规律）
   * 时长：7.5h=100 理想、6h=60 及格，线性插值
   */
  function sleepScoreCalc(agg, day) {
    var hours = day ? (day.v / 60) : (agg.n ? agg.asleep / agg.n / 60 : 0);
    var durScore = hours >= 7.5 ? 100 : hours >= 6 ? 60 + (hours - 6) / 1.5 * 40 : Math.max(0, hours / 6 * 60);

    var eff = day ? (day.inBed ? day.v / day.inBed * 100 : null) : (agg.inBed ? agg.asleep / agg.inBed * 100 : null);
    var effScore = eff == null ? null : (eff >= 90 ? 100 : eff >= 80 ? 70 + (eff - 80) / 10 * 30 : Math.max(0, eff / 80 * 70));

    var deepPct = day ? (day.v ? day.deep / day.v * 100 : null) : (agg.asleep ? agg.deep / agg.asleep * 100 : null);
    var deepScore = deepPct == null ? null : (deepPct >= 20 ? 100 : deepPct >= 15 ? 75 + (deepPct - 15) / 5 * 25 : deepPct >= 10 ? 50 + (deepPct - 10) / 5 * 25 : Math.max(0, deepPct / 10 * 50));

    /* 规律分：最近 7 个有入睡时间的夜晚，入睡时刻标准差 */
    var regScore = null;
    var falls = [];
    var all = sleepAllDays();
    for (var i = all.length - 1; i >= 0 && falls.length < 7; i--) {
      if (all[i].fallAsleepTs) falls.push(localMinOf(all[i].fallAsleepTs));
    }
    if (falls.length >= 3) {
      var vals = falls.map(function (m) { return m >= 720 ? m - 1440 : m; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / vals.length);
      regScore = sd <= 15 ? 100 : sd <= 30 ? 85 : sd <= 45 ? 70 : sd <= 60 ? 60 : Math.max(30, 60 - (sd - 60));
    }

    var dims = [
      { k: '时长', w: 0.40, s: durScore, desc: hours >= 7.5 ? '达到理想 7.5h' : hours >= 6 ? '及格线以上' : '低于及格线', val: fmtDur(day ? day.v : (agg.n ? agg.asleep / agg.n : 0)) },
      { k: '效率', w: 0.25, s: effScore, desc: eff == null ? '数据不足' : eff >= 90 ? '效率优秀' : eff >= 80 ? '效率正常' : '效率偏低', val: eff != null ? Math.round(eff) + '%' : '—' },
      { k: '深睡', w: 0.20, s: deepScore, desc: deepPct == null ? '数据不足' : deepPct >= 20 ? '深睡充足' : deepPct >= 15 ? '深睡正常' : '深睡偏少', val: deepPct != null ? Math.round(deepPct) + '%' : '—' },
      { k: '规律', w: 0.15, s: regScore, desc: regScore == null ? '数据不足' : regScore >= 85 ? '作息稳定' : regScore >= 60 ? '作息一般' : '作息波动大', val: regScore == null ? '—' : '' }
    ];
    var weighted = 0, wSum = 0;
    dims.forEach(function (d) { if (d.s != null) { weighted += d.s * d.w; wSum += d.w; } });
    var total = wSum ? Math.round(weighted / wSum) : 0;
    var grade = total >= 90 ? '优秀' : total >= 75 ? '良好' : total >= 60 ? '及格' : '待改善';
    return { total: total, grade: grade, dims: dims, hours: hours };
  }
  function renderSleepScore(agg, day) {
    var el = $('sleep-score-body');
    if (state.sleepMode === 'nap') {
      el.innerHTML = '<div class="qual-note">午睡不参与睡眠质量评分。评分仅针对晚间睡眠（18:00–次日 10:30 开始的主睡眠段），午睡请关注时长合理性（0.5–1h 正常，&gt;1.5h 异常）。</div>';
      return;
    }
    var sc = sleepScoreCalc(agg, day);
    if (!agg.n && !day) {
      el.innerHTML = '<div class="qual-note">该窗口内没有睡眠数据，无法评分。</div>';
      return;
    }
    var gradeColor = sc.total >= 90 ? '#63C77F' : sc.total >= 75 ? '#4FC3B7' : sc.total >= 60 ? '#E8A33D' : '#E5655A';
    var html = '<div class="score-row">' +
      '<div class="score-big"><div class="score-num" style="color:' + gradeColor + '">' + sc.total + '</div>' +
      '<div class="score-grade" style="color:' + gradeColor + '">' + sc.grade + '</div>' +
      '<div class="score-desc">' + (day ? '单晚' : '窗口均值') + ' · ' + (sc.hours ? fmtDur(Math.round(sc.hours * 60)) : '—') + '</div></div>' +
      '<div class="score-dims">';
    sc.dims.forEach(function (d) {
      var s = d.s == null ? 0 : Math.round(d.s);
      var c = s >= 75 ? '#63C77F' : s >= 60 ? '#E8A33D' : '#E5655A';
      html += '<div class="score-dim"><div class="score-dim-head"><span>' + d.k + ' <b style="color:' + c + '">' + (d.s == null ? '—' : s) + '</b></span><span class="score-dim-val">' + d.val + '</span></div>' +
        '<div class="score-dim-bar"><span style="width:' + (d.s == null ? 0 : Math.max(2, s)) + '%;background:' + c + '"></span></div>' +
        '<div class="score-dim-desc">' + d.desc + '</div></div>';
    });
    html += '</div></div>';
    html += '<div class="score-note">评分参考 Apple 睡眠质量评分：时长 7.5h 为理想（100 分）、6h 为及格（60 分），综合效率、深睡占比与作息规律加权（40/25/20/15）。</div>';
    el.innerHTML = html;
  }
  /* 睡眠质量历史：近 90 天逐日评分 + 等级色带 + 改进建议 */
  function drawScoreHistory(canvas, list) {
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 44, padR = 12, padT = 14, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = list.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };
    var yOf = function (v) { return padT + (1 - v / 100) * plotH; };
    ctx.clearRect(0, 0, W, H);
    var bands = [[60, 0, 'rgba(229,101,90,0.12)'], [75, 60, 'rgba(232,163,61,0.10)'], [90, 75, 'rgba(79,195,183,0.10)'], [101, 90, 'rgba(99,199,127,0.13)']];
    bands.forEach(function (b) {
      ctx.fillStyle = b[3];
      ctx.fillRect(padL, yOf(b[0]), plotW, Math.max(0, yOf(b[1]) - yOf(b[0])));
    });
    /* 65 分参考线 */
    ctx.save();
    ctx.strokeStyle = 'rgba(232,163,61,0.75)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.1;
    var l65 = yOf(65);
    ctx.beginPath(); ctx.moveTo(padL, l65); ctx.lineTo(W - padR, l65); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(232,163,61,0.9)';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('参考线 65', padL + 4, l65 - 3);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 25, 50, 60, 75, 90, 100].forEach(function (v) {
      var y = yOf(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(v, padL - 7, y);
    });
    ctx.restore();
    ctx.beginPath();
    list.forEach(function (d, i) { if (i === 0) ctx.moveTo(xOf(i), yOf(d.v)); else ctx.lineTo(xOf(i), yOf(d.v)); });
    ctx.strokeStyle = '#9B8AFB';
    ctx.lineWidth = 1.7;
    ctx.stroke();
    list.forEach(function (d, i) {
      var col = d.v >= 90 ? '#63C77F' : d.v >= 75 ? '#4FC3B7' : d.v >= 60 ? '#E8A33D' : '#E5655A';
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(xOf(i), yOf(d.v), 2.4, 0, Math.PI * 2); ctx.fill();
    });
    ctx.save();
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    xTicks(n, 8).forEach(function (idx) {
      ctx.fillText(list[idx].d.slice(5), xOf(idx), H - padB + 4);
    });
    ctx.restore();
    attachTip(canvas, $('sleep-history-tip'), xOf, function () { return padT + plotH / 2; }, list, function (d) {
      var grade = d.v >= 90 ? '优秀' : d.v >= 75 ? '良好' : d.v >= 60 ? '及格' : '待改善';
      return '<div class="t-date">' + d.d + '</div><div class="t-row"><span>评分</span><b>' + d.v + ' 分（' + grade + '）</b></div>' +
        '<div class="t-row"><span>睡眠</span><b>' + fmtDur(d.hours) + '</b></div>';
    });
  }
  function buildSleepAdvice(a) {
    if (!a.n) return '该窗口无睡眠数据。';
    var parts = [];
    var hours = a.asleep / a.n / 60;
    if (hours < 6) parts.push('时长严重不足（' + hours.toFixed(1) + 'h/晚）：建议提前 30–60 分钟入睡，逐步向 7.5h 目标靠拢');
    else if (hours < 7.5) parts.push('时长未达理想（' + hours.toFixed(1) + 'h < 7.5h）：可再提前 15–30 分钟入睡');
    var eff = a.inBed ? a.asleep / a.inBed * 100 : null;
    if (eff != null && eff < 85) parts.push('睡眠效率偏低（' + Math.round(eff) + '%）：减少卧床清醒时间，睡前 1 小时避免屏幕与咖啡因');
    var deepPct = a.asleep ? a.deep / a.asleep * 100 : null;
    if (deepPct != null && deepPct < 15) parts.push('深睡占比偏低（' + Math.round(deepPct) + '%）：规律作息与日间适度运动有助于深睡');
    return parts.length ? parts.join('；') : '近 7 天状态良好，继续保持规律作息';
  }
  function renderSleepHistory() {
    var canvas = $('sleep-history-chart');
    if (state.sleepMode === 'nap') {
      clearEmpty(canvas.parentElement);
      emptyState(canvas, '午睡不参与评分，无评分历史');
      $('sleep-history-meta').innerHTML = '<span><b>说明：</b>评分历史仅针对晚间睡眠口径。</span>';
      return;
    }
    var days = sleepDataDays().slice(-90);
    var canvas = $('sleep-history-chart');
    clearEmpty(canvas.parentElement);
    if (days.length < 2) { emptyState(canvas, '睡眠数据不足，无法绘制评分历史'); $('sleep-history-meta').innerHTML = ''; return; }
    var list = days.map(function (d) {
      var sc = sleepScoreCalc(null, d);
      return { d: d.d, ts: d.ts, v: sc.total, hours: d.v };
    });
    drawScoreHistory(canvas, list);
    var g = { 优秀: 0, 良好: 0, 及格: 0, 待改善: 0 };
    list.forEach(function (x) { var k = x.v >= 90 ? '优秀' : x.v >= 75 ? '良好' : x.v >= 60 ? '及格' : '待改善'; g[k]++; });
    var advice = buildSleepAdvice(aggSleepDays(days.slice(-7)));
    $('sleep-history-meta').innerHTML =
      '<span><b>近 ' + list.length + ' 天：</b>优秀 ' + g['优秀'] + ' · 良好 ' + g['良好'] + ' · 及格 ' + g['及格'] + ' · 待改善 ' + g['待改善'] + '</span>' +
      '<span><b>近期建议：</b>' + advice + '</span>';
  }
  function renderSleepMain(all, inWin, win, prevCur, isDay) {
    var wrap = $('sleep-main-wrap');
    clearEmpty(wrap);
    var canvas = $('sleep-chart');
    if (!all.length) { emptyState(canvas, '导出数据中没有睡眠记录'); return; }
    if (isDay) {
      var day = inWin[0];
      if (day) {
        var segs = state.res.sleepSegs.filter(function (s) {
          return s.d === day.d && (state.sleepMode === 'all' || (state.sleepMode === 'night' ? s.night === 1 : s.night === 0));
        });
        var stackDays = all.slice(-30);
        drawSleepDayView(canvas, day, segs, stackDays);
      } else {
        emptyState(canvas, '该日期没有睡眠数据');
      }
    } else if (state.sleepGran === 'week') {
      var wkDays = windowDays(all, win.start, win.end);
      var pWin = sleepWindow(prevCur);
      var prevDays = prevCur ? windowDays(all, pWin.start, pWin.end) : null;
      if (!wkDays.length && !prevDays) emptyState(canvas, '该周没有睡眠数据');
      else drawSleepStack(canvas, wkDays, { tipEl: $('sleep-tip'), prevList: prevDays });
    } else {
      var mDays = windowDays(all, win.start, win.end);
      var pWin2 = sleepWindow(prevCur);
      var prevDays2 = prevCur ? windowDays(all, pWin2.start, pWin2.end) : null;
      if (!mDays.length && !prevDays2) emptyState(canvas, '该月没有睡眠数据');
      else drawSleepStack(canvas, mDays, { tipEl: $('sleep-tip'), prevList: prevDays2 });
    }
  }
  function avgCircular(agg, which) {
    if (!agg.tN) return null;
    var sum = which === 'fall' ? agg.fallSum : agg.wakeSum;
    /* 简单环形平均：>720 的按 -1440 处理（针对入睡） */
    if (which === 'fall') {
      var corrected = 0;
      /* 重新统计需要原始值——用近似：若均值 >720 则整体偏移 */
      var avg = sum / agg.tN;
      if (avg >= 720) avg -= 1440;
      return avg;
    }
    return sum / agg.tN;
  }
  function drawSleepDayView(canvas, day, segs, stackDays) {
    var c = setupCanvas(canvas, 340);
    var ctx = c.ctx, W = c.W, H = c.H;
    /* 上半 150px：时间轴；下半 190px：近 30 天堆叠 */
    var topH = 138;
    /* 上半时间轴 + 下半堆叠，分两块区域绘制 */
    drawTimelineAt(ctx, W, topH, segs, 0);
    /* 下半堆叠：手动绘制简化版（复用 drawSleepStack 逻辑但带 y 偏移） */
    var padL = 56, padR = 16, padT = 6, padB = 24;
    var plotH = (H - topH) - padT - padB;
    var maxV = 60;
    stackDays.forEach(function (d) { var t = Math.min(d.inBed || 0, 720) + (d.awake || 0); if (t > maxV) maxV = t; });
    maxV = Math.max(480, Math.ceil(maxV / 60) * 60);
    if (maxV > 720) maxV = 720;
    var yOf = function (v) { return topH + padT + (1 - v / maxV) * plotH; };
    var n = stackDays.length;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * (W - padL - padR); };
    var colors = { core: 'rgba(79,195,183,0.85)', deep: '#7B6CF6', rem: '#9B8AFB', awake: 'rgba(229,101,90,0.7)' };
    var bw = Math.max(2, Math.min(30, (W - padL - padR) / n * 0.55));
    stackDays.forEach(function (d, i) {
      var x = xOf(i) - bw / 2;
      var segs2 = [['awake', d.awake || 0], ['rem', d.rem || 0], ['deep', d.deep || 0], ['core', d.core || 0]];
      var y = yOf(0);
      segs2.forEach(function (s) {
        if (!s[1]) return;
        var h = yOf(0) - yOf(s[1]);
        ctx.fillStyle = colors[s[0]];
        ctx.fillRect(x, y - h, bw, h);
        y -= h;
      });
      if (d.d === day.d) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - 3, topH + padT, bw + 6, plotH);
      }
      /* 状态分级点 */
      var st = statusOf(d.v);
      if (st && (st.label.indexOf('不足') >= 0 || st.label.indexOf('高于') >= 0 || st.label.indexOf('过长') >= 0)) {
        ctx.fillStyle = st.color;
        ctx.beginPath(); ctx.arc(xOf(i) + bw / 2, yOf(d.v) - 7, st.label.indexOf('严重') >= 0 ? 3.8 : 3, 0, Math.PI * 2); ctx.fill();
      }
      /* 在床时长虚线框 */
      if (d.inBed > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        var ibTop = yOf(Math.min(d.inBed, maxV));
        var ibBot = yOf(0);
        ctx.strokeRect(x + 0.5, ibTop + 0.5, Math.max(1, bw - 1), Math.max(1, ibBot - ibTop - 1));
        ctx.setLineDash([]);
        ctx.restore();
      }
    });
    /* y 轴刻度（下半） */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var v = 0; v <= maxV; v += maxV / 4) {
      var py = yOf(v);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
      ctx.fillText(fmtDur(v), padL - 7, py);
    }
    /* x 刻度（下半） */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var tickIdxs = xTicks(n, 6);
    tickIdxs.forEach(function (idx) {
      var d = stackDays[idx];
      ctx.fillText(d.d.slice(5), xOf(idx), H - padB + 2);
    });
    ctx.restore();
    /* tooltip：只对下半堆叠生效 */
    attachTip(canvas, $('sleep-tip'), xOf, function () { return topH + plotH / 2; }, stackDays, function (d) {
      return '<div class="t-date">' + d.d + '</div><div class="t-row"><span>总睡眠</span><b>' + fmtDur(d.v) + '</b></div>' +
        '<div class="t-row"><span>深睡</span><b>' + fmtDur(d.deep) + '</b></div>' +
        '<div class="t-row"><span>REM</span><b>' + fmtDur(d.rem) + '</b></div>' +
        '<div class="t-row"><span>浅睡</span><b>' + fmtDur(d.core) + '</b></div>';
    });
  }
  function drawTimelineAt(ctx, W, H, segs, yOff) {
    var padL = 56, padR = 16, padT = 8, padB = 22;
    var T0 = 21 * 60, T1 = 36 * 60;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var xOf = function (m) { return padL + (m - T0) / (T1 - T0) * plotW; };
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (var h = 21; h <= 35; h++) {
      var x = xOf(h * 60);
      ctx.beginPath(); ctx.moveTo(x, yOff + padT); ctx.lineTo(x, yOff + H - padB); ctx.stroke();
      ctx.fillText(String(h % 24).padStart(2, '0') + ':00', x, yOff + H - padB + 3);
    }
    ctx.restore();
    var stageColor = { inBed: '#3A4048', asleep: '#4FC3B7', core: '#4FC3B7', deep: '#7B6CF6', rem: '#9B8AFB', awake: '#E5655A' };
    var y = yOff + padT + 3, barH = plotH - 12;
    segs.forEach(function (s) {
      var start = s.startMin >= T0 ? s.startMin : s.startMin + 1440;
      var end = start + s.durMin;
      var x1 = Math.max(xOf(T0), xOf(Math.max(T0, start)));
      var x2 = Math.min(xOf(T1), xOf(Math.min(T1, end)));
      if (x2 <= x1) return;
      ctx.fillStyle = stageColor[s.stage] || '#4FC3B7';
      ctx.fillRect(x1, y, x2 - x1, barH);
    });
    ctx.save();
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var lx = padL;
    Object.keys(stageColor).forEach(function (k) {
      ctx.fillStyle = stageColor[k];
      ctx.fillRect(lx, y + barH + 6, 8, 8);
      ctx.fillStyle = '#6B7480';
      ctx.fillText(k, lx + 11, y + barH + 10);
      lx += 11 + ctx.measureText(k).width + 14;
    });
    ctx.restore();
  }
  function renderSleepStages(agg, day) {
    var el = $('sleep-stages');
    var src = day || agg;
    var asleepVal = day ? (day.v || 0) : (agg.asleep || 0);
    var total = asleepVal + (src.awake || 0);
    if (!total) { el.innerHTML = '<div class="qual-note">该窗口内没有睡眠阶段数据。</div>'; return; }
    var segs = [
      ['浅睡', src.core || 0, '#4FC3B7'],
      ['深睡', src.deep || 0, '#7B6CF6'],
      ['REM', src.rem || 0, '#9B8AFB'],
      ['清醒', src.awake || 0, '#E5655A']
    ];
    var html = '<div class="stack-bar">' + segs.map(function (s) {
      return '<span style="width:' + (s[1] / total * 100).toFixed(1) + '%;background:' + s[2] + '"></span>';
    }).join('') + '</div>';
    html += '<div class="stack-legend">' + segs.map(function (s) {
      return '<span><i style="background:' + s[2] + '"></i>' + s[0] + ' ' + fmtDur(s[1]) + '（' + (total ? Math.round(s[1] / total * 100) : 0) + '%）</span>';
    }).join('') + '</div>';
    if (day && day.inBed) {
      var eR3 = effCalc(day.v, day.inBed);
      html += '<div class="qual-note" style="margin-top:8px">在床 ' + fmtDur(day.inBed) + ' · 睡眠效率 ' + (eR3.abnormal ? '<span style="color:#E5655A">数据异常（在床记录缺失/矛盾）</span>' : (eR3.v != null ? Math.round(eR3.v) + '%' : '—')) +
        (day.fallAsleepTs ? ' · 入睡 ' + fmtTime(localMinOf(day.fallAsleepTs)) : '') +
        (day.wakeTs ? ' · 醒来 ' + fmtTime(localMinOf(day.wakeTs)) : '') + '</div>';
    } else if (day) {
      html += '<div class="qual-note" style="margin-top:8px">在床时长缺失，无法计算效率</div>';
    }
    el.innerHTML = html;
  }
  function renderSleepWeeklyTrend() {
    var all = sleepAllDays();
    if (!all.length) { emptyState($('sleep-trend-chart'), '睡眠数据不足'); return; }
    /* 按周聚合近 12 周（小时制） */
    var weeks = [];
    var endKey = all[all.length - 1].d;
    var ws = weekStartKey(endKey);
    for (var i = 11; i >= 0; i--) {
      var wkStart = dayKeyAdd(ws, -i * 7);
      var wkEnd = dayKeyAdd(wkStart, 6);
      var days = windowDays(all, wkStart, wkEnd);
      var n = days.filter(function (d) { return d.v > 0; }).length;
      var sum = days.reduce(function (a, d) { return a + (d.v > 0 ? d.v : 0); }, 0);
      weeks.push({ d: wkStart.slice(5) + '周', ts: HE.dkToTs(wkStart), v: n ? Math.round(sum / n / 6) / 10 : null, n: n });
    }
    var list = weeks.filter(function (w) { return w.v != null; });
    if (!list.length) { emptyState($('sleep-trend-chart'), '数据不足'); return; }
    var goal = state.res.daily.sleepGoal && state.res.daily.sleepGoal.days.length ? state.res.daily.sleepGoal.days[state.res.daily.sleepGoal.days.length - 1].v : null;
    var goals;
    if (state.sleepMode === 'nap') {
      goals = [
        { v: 0.5, label: '正常下限 0.5h', color: 'rgba(99,199,127,0.7)' },
        { v: 1.5, label: '异常线 1.5h', color: 'rgba(229,101,90,0.7)' }
      ];
    } else {
      goals = [
        { v: 5.5, label: '睡眠不足线 5.5h', color: 'rgba(229,101,90,0.7)' },
        { v: 8, label: '偏高线 8h', color: 'rgba(232,163,61,0.7)' }
      ];
      if (goal) goals.push({ v: goal, label: '目标 ' + goal + 'h', color: 'rgba(79,195,183,0.7)' });
    }
    drawLineChart($('sleep-trend-chart'), list, { label: '周均睡眠', unit: 'h', color: '#9B8AFB' }, {
      tipEl: $('sleep-trend-tip'),
      goals: goals,
      tipExtra: function (d) {
        return '<div class="t-row"><span>状态</span>' + (sleepStatusHtml(d.v) || '<b>—</b>') + '</div>';
      }
    });
  }
  function renderSleepHeat() {
    var all = sleepAllDays();
    var wrap = $('sleep-heat-wrap');
    if (!all.length) {
      wrap.innerHTML = '<div class="chart-empty" style="position:static;padding:36px 0"><div>数据不足</div><div class="em-line"></div><div>NO DATA</div></div>';
      $('sleep-heat-label').textContent = '—';
      return;
    }
    var rng = sliceRange(all, 'all');
    var days = rng.list.map(function (d) { return { d: d.d, ts: d.ts, v: d.v }; });
    $('sleep-heat-label').textContent = days.length + ' 天 · ' + shortDay(days[0].ts, true) + ' → ' + shortDay(days[days.length - 1].ts, true);
    renderHeatGrid(wrap, days, 'rgba(155,138,251,1)', 0, '睡眠时长', $('sleep-trend-tip'), function (v) { return fmtDur(v); }, function (cell) {
      var st = statusOf(cell.v);
      if (!st) return 'rgba(155,138,251,1)';
      if (st.label.indexOf('严重') >= 0 || st.label.indexOf('过长') >= 0) return 'rgba(229,101,90,1)';
      if (st.label.indexOf('不足') >= 0 || st.label.indexOf('偏长') >= 0) return 'rgba(245,158,107,1)';
      if (st.label.indexOf('高于') >= 0) return 'rgba(232,163,61,1)';
      return 'rgba(155,138,251,1)';
    });
  }
  /* 睡眠 × HRV 关联图：双轴叠加（柱=睡眠 h 左轴，线=睡眠期 HRV ms 右轴），共享时间轴 */
  function drawSleepHrvChart(canvas, sleepList, hrvMap) {
    var c = setupCanvas(canvas);
    var ctx = c.ctx, W = c.W, H = c.H;
    var padL = 56, padR = 56, padT = 18, padB = 28;
    var n = sleepList.length;
    if (!n) { emptyState(canvas, '数据不足'); return; }
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var xOf = function (i) { return padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW; };

    /* 左轴（睡眠）：0 ~ maxV（12h 封顶） */
    var maxV = 60;
    sleepList.forEach(function (d) { var t = Math.min(d.inBed || 0, 720) + (d.awake || 0); if (t > maxV) maxV = t; });
    maxV = Math.max(480, Math.ceil(maxV / 60) * 60);
    if (maxV > 720) maxV = 720;
    var yOfS = function (v) { return padT + (1 - v / maxV) * plotH; };

    /* 右轴（HRV） */
    var hrvVals = [];
    sleepList.forEach(function (d) { var v = hrvMap[d.d]; if (v != null) hrvVals.push(v); });
    var hasHrv = hrvVals.length >= 2;
    var yOfH = null, hrvMin = 0, hrvMax = 1;
    if (hasHrv) {
      var mn = Math.min.apply(null, hrvVals), mx = Math.max.apply(null, hrvVals);
      if (mn === mx) { mn -= 10; mx += 10; }
      var sc = niceScale(mn, mx, 4);
      hrvMin = sc[0]; hrvMax = sc[1];
      yOfH = function (v2) { return padT + (1 - (v2 - hrvMin) / (hrvMax - hrvMin)) * plotH; };
    }

    ctx.clearRect(0, 0, W, H);
    /* 左轴网格 + 刻度 */
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var v = 0; v <= maxV; v += maxV / 4) {
      var py = yOfS(v);
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(W - padR, py); ctx.stroke();
      ctx.fillText(fmtDur(v), padL - 7, py);
    }
    ctx.restore();
    /* 右轴刻度（HRV） */
    if (hasHrv) {
      ctx.save();
      ctx.strokeStyle = 'rgba(242,180,92,0.18)';
      ctx.fillStyle = '#B08A4E';
      ctx.font = '10.5px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      var hStep = (hrvMax - hrvMin) / 4;
      for (var gi = 0; gi <= 4; gi++) {
        var gv = hrvMin + hStep * gi;
        var gy = yOfH(gv);
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
        ctx.fillText(Math.round(gv), W - padR + 6, gy);
      }
      ctx.restore();
    }

    /* 睡眠堆叠柱 + 状态点 */
    var colors = { core: 'rgba(79,195,183,0.8)', deep: '#7B6CF6', rem: '#9B8AFB', awake: 'rgba(229,101,90,0.6)' };
    var bw = Math.max(2, Math.min(18, plotW / n * 0.5));
    sleepList.forEach(function (d, i) {
      var x = xOf(i) - bw / 2;
      var segs = [['awake', d.awake || 0], ['rem', d.rem || 0], ['deep', d.deep || 0], ['core', d.core || 0]];
      var y = yOfS(0);
      segs.forEach(function (s) {
        if (!s[1]) return;
        var h = yOfS(0) - yOfS(s[1]);
        ctx.fillStyle = colors[s[0]];
        ctx.fillRect(x, y - h, bw, h);
        y -= h;
      });
      var st = statusOf(d.v);
      if (st && (st.label.indexOf('不足') >= 0 || st.label.indexOf('高于') >= 0 || st.label.indexOf('过长') >= 0)) {
        ctx.fillStyle = st.color;
        ctx.beginPath(); ctx.arc(xOf(i), yOfS(d.v) - 6, st.label.indexOf('严重') >= 0 ? 3.6 : 2.8, 0, Math.PI * 2); ctx.fill();
      }
    });

    /* HRV 折线 + 点 */
    if (hasHrv) {
      ctx.beginPath();
      var started = false;
      sleepList.forEach(function (d, i) {
        var hv = hrvMap[d.d];
        if (hv == null) return;
        if (!started) { ctx.moveTo(xOf(i), yOfH(hv)); started = true; }
        else ctx.lineTo(xOf(i), yOfH(hv));
      });
      ctx.strokeStyle = '#F2B45C';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      sleepList.forEach(function (d, i) {
        var hv = hrvMap[d.d];
        if (hv == null) return;
        ctx.fillStyle = '#F2B45C';
        ctx.beginPath(); ctx.arc(xOf(i), yOfH(hv), 2.2, 0, Math.PI * 2); ctx.fill();
      });
    } else {
      ctx.save();
      ctx.fillStyle = '#6B7480';
      ctx.font = '11px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('该时间范围 HRV 数据不足', padL + plotW / 2, padT + plotH / 2);
      ctx.restore();
    }

    /* 图例（画布右上） */
    ctx.save();
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9B8AFB'; ctx.fillRect(padL, padT - 12, 9, 9);
    ctx.fillStyle = '#6B7480'; ctx.fillText('睡眠', padL + 13, padT - 7);
    if (hasHrv) {
      ctx.strokeStyle = '#F2B45C'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(padL + 80, padT - 8); ctx.lineTo(padL + 110, padT - 8); ctx.stroke();
      ctx.fillStyle = '#6B7480'; ctx.fillText('HRV', padL + 114, padT - 7);
    }
    ctx.restore();

    /* x 轴 */
    ctx.save();
    ctx.fillStyle = '#6B7480';
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    xTicks(n, 7).forEach(function (idx) {
      var d = sleepList[idx];
      ctx.fillText(d.d.slice(5), xOf(idx), H - padB + 4);
      ctx.beginPath(); ctx.moveTo(xOf(idx), padT); ctx.lineTo(xOf(idx), H - padB);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.stroke();
    });
    ctx.restore();

    attachTip(canvas, $('sleep-hrv-tip'), xOf, function () { return padT + plotH / 2; }, sleepList, function (d) {
      var hv = hrvMap[d.d];
      var html = '<div class="t-date">' + d.d + '</div>' +
        '<div class="t-row"><span>睡眠</span><b>' + fmtDur(d.v) + '（' + (sleepStatusHtml(d.v) || '—') + '）</b></div>' +
        '<div class="t-row"><span>深睡</span><b>' + fmtDur(d.deep) + '</b></div>';
      if (hv != null) html += '<div class="t-row"><span>睡眠期 HRV</span><b>' + hv + ' ms</b></div>';
      else html += '<div class="t-row"><span>睡眠期 HRV</span><b>无记录</b></div>';
      return html;
    });
  }
  function renderSleepHrv() {
    var sl = sleepAllDays().slice(-30);
    var canvas = $('sleep-hrv-chart');
    clearEmpty(canvas.parentElement);
    if (!sl.length) { emptyState(canvas, '睡眠数据不足'); return; }
    var hrvMap = {};
    /* 优先睡眠期 HRV；某天缺则回退全天均值 */
    var hrvSleep = state.res.daily.hrvSleep ? state.res.daily.hrvSleep.days : [];
    var hrvAll = state.res.daily.hrv ? state.res.daily.hrv.days : [];
    var allMap = {};
    hrvAll.forEach(function (d) { allMap[d.d] = d.v; });
    hrvSleep.forEach(function (d) { hrvMap[d.d] = d.v; });
    sl.forEach(function (d) { if (hrvMap[d.d] == null && allMap[d.d] != null) hrvMap[d.d] = allMap[d.d]; });
    drawSleepHrvChart(canvas, sl, hrvMap);
  }
  function renderSleepExtra() {
    var panel = $('sleep-extra-panel');
    var parts = [];
    var wt = state.res.daily.wristTemp;
    if (wt && wt.days.length) {
      parts.push('<div class="panel" style="margin-bottom:0"><div class="panel-head"><span class="panel-title violet">睡眠腕温</span><span class="panel-title" style="color:var(--faint)">近 30 天 · 夜间平均</span></div>' +
        '<div class="chart-wrap"><canvas class="mini-chart" id="wrist-chart" style="height:180px"></canvas><div class="chart-tip" id="wrist-tip" hidden></div></div></div>');
    }
    var goal = state.res.daily.sleepGoal && state.res.daily.sleepGoal.days.length ? state.res.daily.sleepGoal.days[state.res.daily.sleepGoal.days.length - 1] : null;
    if (goal) {
      parts.push('<div class="panel" style="margin-bottom:0"><div class="panel-head"><span class="panel-title">睡眠目标</span><span class="panel-title" style="color:var(--faint)">SLEEP GOAL</span></div>' +
        '<div class="panel-body"><div class="qual-item"><div class="k">目标时长</div><div class="v">' + goal.v + ' 小时</div></div>' +
        '<div class="qual-note">趋势图中琥珀色虚线为目标线。近期日均 ' + (sleepDataDays().length ? fmtDur(sleepDataDays().reduce(function (a, d) { return a + d.v; }, 0) / sleepDataDays().length) : '—') + '。</div></div></div>');
    }
    if (!parts.length) { panel.hidden = true; return; }
    panel.hidden = false;
    $('sleep-extra-body').innerHTML = '<div class="grid-2">' + parts.join('') + '</div>';
    if (wt && wt.days.length) {
      var list = wt.days.slice(-30);
      drawLineChart($('wrist-chart'), list, { label: '腕温', unit: '°C', color: '#F2B45C' }, { tipEl: $('wrist-tip') });
    }
  }
  $('sleep-prev').addEventListener('click', function () { var p = prevSleepWindow(); if (p) { state.sleepCur = p; renderSleep(); } });
  $('sleep-next').addEventListener('click', function () { var n = nextSleepWindow(); if (n) { state.sleepCur = n; renderSleep(); } });

  /* ================= 心率模块 ================= */
  function hrAllDays() { return state.res.daily.heartRate ? state.res.daily.heartRate.days : []; }
  function setHrGran(g) {
    state.hrGran = g;
    document.querySelectorAll('#hr-gran-tabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-gran') === g); });
    if (g === 'week' && state.hrCur) state.hrCur = weekStartKey(state.hrCur);
    if (g === 'month' && state.hrCur) state.hrCur = state.hrCur.slice(0, 7) + '-01';
    renderHeart();
  }
  $('hr-gran-tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (t) setHrGran(t.getAttribute('data-gran'));
  });
  function hrWindow(cur) {
    var g = state.hrGran;
    if (g === 'day') return { start: cur, end: cur, label: cur };
    if (g === 'week') {
      var ws = weekStartKey(cur), we = weekEndKey(cur);
      return { start: ws, end: we, label: ws.slice(5) + ' ~ ' + we.slice(5) + ' 周' };
    }
    return { start: cur.slice(0, 7) + '-01', end: monthEndKey(cur), label: cur.slice(0, 7) + ' 月' };
  }
  function hrPrevWin() {
    var g = state.hrGran, cur = state.hrCur;
    if (g === 'day') {
      var days = hrAllDays();
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx > 0 ? days[idx - 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), -7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', -1);
  }
  function hrNextWin() {
    var g = state.hrGran, cur = state.hrCur;
    if (g === 'day') {
      var days = hrAllDays();
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx >= 0 && idx < days.length - 1 ? days[idx + 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), 7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', 1);
  }
  function hrRawWindow(win) {
    if (!state.res.heartRaw) return null;
    var tsArr = state.res.heartRaw.ts;
    var startTs = HE.dkToTs(win.start), endTs = HE.dkToTs(win.end) + 86400000 - 1;
    var lo = lowerBound(tsArr, startTs), hi = upperBound(tsArr, endTs);
    return { lo: lo, hi: hi, count: hi - lo };
  }
  function hrRawStats(win) {
    var w = hrRawWindow(win);
    if (!w || !w.count) return null;
    var ts = state.res.heartRaw.ts, v = state.res.heartRaw.v;
    var sum = 0, min = 1e9, max = -1e9;
    for (var i = w.lo; i < w.hi; i++) { sum += v[i]; if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
    return { lo: w.lo, hi: w.hi, count: w.count, avg: sum / w.count, min: min, max: max };
  }
  function dayMetricAvg(key, mkey) {
    var d = state.res.daily[mkey];
    if (!d || !d.days.length) return null;
    var inWin = windowDays(d.days, key, key);
    if (!inWin.length) return null;
    var sum = 0, n = 0;
    inWin.forEach(function (x) { if (x.v != null) { sum += x.v; n++; } });
    return n ? sum / n : null;
  }
  function renderHeart() {
    var all = hrAllDays();
    var win = hrWindow(state.hrCur);
    var inWin = windowDays(all, win.start, win.end);
    var raw = hrRawStats(win);
    var prevCur = hrPrevWin();
    var prevRaw = prevCur ? hrRawStats(hrWindow(prevCur)) : null;

    $('hr-cur-label').textContent = win.label;
    $('hr-prev').disabled = !prevCur;
    $('hr-next').disabled = !hrNextWin();

    var cards = [];
    function card(label, value, sub, color, cls) {
      cards.push('<div class="card ' + (cls || '') + (value ? '' : ' no-data') + '" style="cursor:default"><div class="card-head"><span class="card-label"><span class="dot" style="background:' + color + '"></span>' + label + '</span></div>' +
        '<div class="card-value">' + (value || 'NO DATA') + '</div><div class="card-sub">' + (sub || '&nbsp;') + '</div></div>');
    }
    function vsPrev(cur, prev, suffix) {
      if (prev == null || cur == null) return '';
      var delta = cur - prev;
      return '<span class="' + (delta <= 0 ? 'up' : 'down') + '">' + (delta >= 0 ? '▲ +' : '▼ ') + Math.abs(delta).toFixed(1) + ' ' + suffix + '</span> vs 上期';
    }
    var avg = raw ? raw.avg : null;
    var prevAvg = prevRaw ? prevRaw.avg : null;
    /* 峰值时段：窗口内按小时分桶，取平均最高的小时段 */
    var peakLabel = '';
    if (raw && raw.count >= 5) {
      var vArr = state.res.heartRaw.v;
      var hourSum = {}, hourN = {};
      for (var pi = raw.lo; pi < raw.hi; pi++) {
        var hh = new Date(state.res.heartRaw.ts[pi]).getHours();
        hourSum[hh] = (hourSum[hh] || 0) + vArr[pi];
        hourN[hh] = (hourN[hh] || 0) + 1;
      }
      var bestH = null, bestAvg = -1;
      Object.keys(hourSum).forEach(function (h) {
        var a = hourSum[h] / hourN[h];
        if (a > bestAvg) { bestAvg = a; bestH = +h; }
      });
      if (bestH != null) peakLabel = String(bestH).padStart(2, '0') + ':00–' + String(bestH + 1).padStart(2, '0') + ':00 · ' + Math.round(bestAvg) + ' bpm';
    }
    var resting = dayMetricAvg(state.hrCur, 'restingHR');
    if (state.hrGran !== 'day') {
      var rDays = state.res.daily.restingHR ? state.res.daily.restingHR.days : [];
      var rWin = windowDays(rDays, win.start, win.end);
      var rSum = 0, rN = 0;
      rWin.forEach(function (x) { if (x.v != null) { rSum += x.v; rN++; } });
      resting = rN ? rSum / rN : null;
    }
    var hrv = dayMetricAvg(state.hrCur, 'hrv');
    if (state.hrGran !== 'day') {
      var hDays = state.res.daily.hrv ? state.res.daily.hrv.days : [];
      var hWin = windowDays(hDays, win.start, win.end);
      var hSum = 0, hN = 0;
      hWin.forEach(function (x) { if (x.v != null) { hSum += x.v; hN++; } });
      hrv = hN ? hSum / hN : null;
    }
    if (raw) {
      card('平均心率', avg.toFixed(1) + '<small>bpm</small>', vsPrev(avg, prevAvg, 'bpm') + ' · ' + fmtNum(raw.count) + ' 条采样', '#4FC3B7', 'cyan');
      card('静息心率', resting != null ? resting.toFixed(0) + '<small>bpm</small>' : '', resting != null ? (resting < 60 ? '静息良好' : resting < 70 ? '正常' : '偏高') : '数据缺失', '#4FC3B7', 'cyan');
      card('最高 / 最低', Math.round(raw.max) + ' / ' + Math.round(raw.min) + '<small>bpm</small>', '', '#4FC3B7', 'cyan');
      card('心率变异性', hrv != null ? hrv.toFixed(0) + '<small>ms</small>' : '', hrv != null ? (hrv > 60 ? '恢复良好' : hrv > 30 ? '正常' : '偏低') : '数据缺失', '#9B8AFB', 'violet');
      card('采样天数', (inWin.length) + '<small>天</small>', '窗口 ' + win.label, '#E8A33D', 'amber');
      card('峰值时段', peakLabel || 'NO DATA', '窗口内平均最高的小时段', '#E8A33D');
    } else {
      ['平均心率', '静息心率', '最高 / 最低', '心率变异性', '采样天数', '峰值时段'].forEach(function (l) {
        card(l, '', '', '#4FC3B7');
      });
    }
    $('hr-cards').innerHTML = cards.join('');

    /* 主图 */
    var wrap = $('hr-main-wrap');
    clearEmpty(wrap);
    var canvas = $('hr-chart');
    if (!all.length) { emptyState(canvas, '导出数据中没有连续心率记录'); return; }
    var showDays;
    if (state.hrGran === 'day') showDays = all.slice(-30);
    else showDays = inWin;
    if (!showDays.length) { emptyState(canvas, '该窗口没有心率数据'); return; }
    drawRangeChart(canvas, showDays, { tipEl: $('hr-tip'), color: '#4FC3B7' });
    $('hr-chart-meta').innerHTML =
      '<span><b>粒度：</b>' + (state.hrGran === 'day' ? '单日（近 30 天区间带，当前日已含）' : state.hrGran === 'week' ? '本周 7 天' : '本月每日') + '</span>' +
      '<span><b>带区：</b>当日最低–最高 · 折线为日均</span>';

    /* 分布 */
    var dc = $('hr-dist-chart');
    clearEmpty(dc.parentElement);
    if (raw && raw.count >= 2) {
      drawHistogram(dc, state.res.heartRaw.ts, state.res.heartRaw.v, raw.lo, raw.hi, { tipEl: $('hr-dist-tip'), color: '#4FC3B7' });
    } else {
      emptyState(dc, '该窗口采样不足');
    }

    /* 强度分区 */
    renderHrZones(raw);

    /* 附加：HRV 趋势 + 静息/步行对比 */
    renderHrExtra();
  }
  function renderHrZones(raw) {
    var el = $('hr-zones');
    if (!raw || !raw.count) { el.innerHTML = '<div class="qual-note">该窗口内没有心率采样。</div>'; return; }
    var zones = [
      ['静息 <60', 0, 60, '#6B7480'],
      ['日常 60–100', 60, 100, '#4FC3B7'],
      ['燃脂 100–140', 100, 140, '#F2B45C'],
      ['有氧 140–180', 140, 180, '#E8A33D'],
      ['极限 >180', 180, 1e9, '#E5655A']
    ];
    var v = state.res.heartRaw.v;
    var counts = zones.map(function () { return 0; });
    for (var i = raw.lo; i < raw.hi; i++) {
      for (var z = 0; z < zones.length; z++) {
        if (v[i] >= zones[z][1] && v[i] < zones[z][2]) { counts[z]++; break; }
      }
    }
    var html = '<div class="stack-bar">' + zones.map(function (z, zi) {
      return '<span style="width:' + (counts[zi] / raw.count * 100).toFixed(1) + '%;background:' + z[3] + '"></span>';
    }).join('') + '</div>';
    html += '<div class="stack-legend">' + zones.map(function (z, zi) {
      return '<span><i style="background:' + z[3] + '"></i>' + z[0] + ' ' + Math.round(counts[zi] / raw.count * 100) + '%</span>';
    }).join('') + '</div>';
    el.innerHTML = html;
  }
  function renderHrExtra() {
    var panel = $('hr-extra-panel');
    var parts = [];
    var hrv = state.res.daily.hrv;
    var rh = state.res.daily.restingHR;
    var wh = state.res.daily.walkingHR;
    if (hrv && hrv.days.length) {
      parts.push('<div class="panel" style="margin-bottom:0"><div class="panel-head"><span class="panel-title violet">HRV 趋势</span><span class="panel-title" style="color:var(--faint)">近 90 天</span></div>' +
        '<div class="chart-wrap"><canvas class="mini-chart" id="hrv-chart" style="height:180px"></canvas><div class="chart-tip" id="hrv-tip" hidden></div></div></div>');
    }
    if ((rh && rh.days.length) || (wh && wh.days.length)) {
      parts.push('<div class="panel" style="margin-bottom:0"><div class="panel-head"><span class="panel-title cyan">静息 vs 步行心率</span><span class="panel-title" style="color:var(--faint)">近 90 天</span></div>' +
        '<div class="chart-wrap"><canvas class="mini-chart" id="hr-cmp-chart" style="height:180px"></canvas><div class="chart-tip" id="hr-cmp-tip" hidden></div></div></div>');
    }
    if (!parts.length) { panel.hidden = true; return; }
    panel.hidden = false;
    $('hr-extra-body').innerHTML = '<div class="grid-2">' + parts.join('') + '</div>';
    if (hrv && hrv.days.length) {
      drawLineChart($('hrv-chart'), hrv.days.slice(-90), { label: 'HRV', unit: 'ms', color: '#9B8AFB' }, { tipEl: $('hrv-tip') });
    }
    if ((rh && rh.days.length) || (wh && wh.days.length)) {
      var days = (rh && rh.days.length ? rh.days : wh.days).slice(-90);
      drawDualLine($('hr-cmp-chart'), days, {
        tipEl: $('hr-cmp-tip'),
        series: [
          { key: 'rest', color: '#4FC3B7', label: '静息', map: function (d) {
            var dd = rh ? windowDays(rh.days, d.d, d.d) : [];
            return dd.length ? dd[0].v : null;
          } },
          { key: 'walk', color: '#F2B45C', label: '步行', map: function (d) {
            var dd = wh ? windowDays(wh.days, d.d, d.d) : [];
            return dd.length ? dd[0].v : null;
          } }
        ]
      });
    }
  }
  $('hr-prev').addEventListener('click', function () { var p = hrPrevWin(); if (p) { state.hrCur = p; renderHeart(); } });
  $('hr-next').addEventListener('click', function () { var n = hrNextWin(); if (n) { state.hrCur = n; renderHeart(); } });

  /* ================= 通用指标分析模块（其他指标） ================= */
  var METRIC_LIB = [];
  function buildMetricLib() {
    METRIC_LIB = [];
    var core = ['steps', 'energy', 'basalEnergy', 'distance', 'restingHR', 'walkingHR', 'oxygen', 'respiratory', 'hrv', 'bodyMass', 'flights', 'exerciseTime', 'standTime', 'cycling', 'walkingSpeed', 'stepLength', 'doubleSupport', 'wristTemp'];
    var colors = ['#E8A33D', '#F2B45C', '#4FC3B7', '#9B8AFB', '#7B6CF6'];
    var ci = 0;
    core.forEach(function (k) {
      var d = state.res.daily[k];
      if (d && d.days.length) {
        METRIC_LIB.push({ key: k, label: d.label, unit: d.unit, kind: d.kind, color: colors[ci++ % colors.length], group: '核心指标', daysLen: d.days.length });
      }
    });
    state.res.other.forEach(function (o) {
      if (o.days.length >= 7) METRIC_LIB.push({ key: 'other:' + o.type, label: o.label, unit: o.unit, kind: 'avg', color: '#E8A33D', group: '其他指标', daysLen: o.days.length });
    });
    METRIC_LIB.sort(function (a, b) { return a.group === b.group ? b.daysLen - a.daysLen : (a.group === '核心指标' ? -1 : 1); });
    if (!METRIC_LIB.length) METRIC_LIB.push({ key: 'steps', label: '步数', unit: '步', kind: 'sum', color: '#E8A33D', group: '核心指标', daysLen: 0 });
    if (!state.metricMod.sel || !METRIC_LIB.some(function (m) { return m.key === state.metricMod.sel; })) {
      state.metricMod.sel = METRIC_LIB[0].key;
    }
  }
  function metricModInfo() {
    var lib = null;
    for (var i = 0; i < METRIC_LIB.length; i++) if (METRIC_LIB[i].key === state.metricMod.sel) { lib = METRIC_LIB[i]; break; }
    if (!lib) return null;
    var days = lib.key.indexOf('other:') === 0
      ? ((state.res.other.find(function (o) { return o.type === lib.key.slice(6); }) || {}).days || [])
      : ((state.res.daily[lib.key] || {}).days || []);
    return { lib: lib, days: days };
  }
  function mmWindow(cur) {
    var g = state.metricMod.gran;
    if (g === 'day') return { start: cur, end: cur, label: cur };
    if (g === 'week') { var ws = weekStartKey(cur), we = weekEndKey(cur); return { start: ws, end: we, label: ws.slice(5) + ' ~ ' + we.slice(5) + ' 周' }; }
    return { start: cur.slice(0, 7) + '-01', end: monthEndKey(cur), label: cur.slice(0, 7) + ' 月' };
  }
  function mmPrevCur() {
    var g = state.metricMod.gran, cur = state.metricMod.cur;
    if (g === 'day') {
      var days = metricModInfo().days;
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx > 0 ? days[idx - 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), -7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', -1);
  }
  function mmNextCur() {
    var g = state.metricMod.gran, cur = state.metricMod.cur;
    if (g === 'day') {
      var days = metricModInfo().days;
      var idx = days.findIndex(function (d) { return d.d === cur; });
      return idx >= 0 && idx < days.length - 1 ? days[idx + 1].d : null;
    }
    if (g === 'week') return dayKeyAdd(weekStartKey(cur), 7);
    return monthKeyAdd(cur.slice(0, 7) + '-01', 1);
  }
  function mmDefaultCur() {
    var days = metricModInfo().days;
    return days.length ? days[days.length - 1].d : null;
  }
  function aggMetricDays(list) {
    var a = { n: 0, sum: 0, min: Infinity, max: -Infinity, last: null, lastD: null };
    list.forEach(function (d) {
      if (d.v == null) return;
      a.n++; a.sum += d.v;
      if (d.v < a.min) a.min = d.v;
      if (d.v > a.max) a.max = d.v;
      a.last = d.v; a.lastD = d.d;
    });
    return a;
  }
  function mmFmt(v, unit, kind) {
    if (v == null) return '—';
    if (kind === 'last') return v + ' ' + unit;
    var r = Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
    return r + ' ' + unit;
  }
  function renderMetricModule() {
    var info = metricModInfo();
    if (!info) return;
    var lib = info.lib, days = info.days;
    if (!state.metricMod.cur || !days.some(function (d) { return d.d === state.metricMod.cur; })) {
      state.metricMod.cur = mmDefaultCur();
    }
    if (!state.metricMod.cur) { $('metric-mod-cards').innerHTML = ''; emptyState($('metric-mod-chart'), '该指标没有数据'); return; }
    var win = mmWindow(state.metricMod.cur);
    var inWin = windowDays(days, win.start, win.end);
    var agg = aggMetricDays(inWin);
    var prevCur = mmPrevCur();
    var prevAgg = prevCur ? aggMetricDays(windowDays(days, mmWindow(prevCur).start, mmWindow(prevCur).end)) : null;

    /* 选择器 */
    var sel = $('metric-mod-select');
    var curGroup = '';
    sel.innerHTML = METRIC_LIB.map(function (m) {
      if (m.group !== curGroup) { curGroup = m.group; return '<optgroup label="' + m.group + '">'; }
      return '';
    }).join('') + METRIC_LIB.map(function (m) {
      return '<option value="' + esc(m.key) + '"' + (m.key === state.metricMod.sel ? ' selected' : '') + '>' + esc(m.label) + '（' + esc(m.unit) + '）</option>';
    }).join('') + '</optgroup>';
    sel.value = state.metricMod.sel;

    document.querySelectorAll('#metric-mod-gran .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-gran') === state.metricMod.gran); });
    $('metric-mod-label').textContent = win.label;
    $('metric-mod-prev').disabled = !prevCur;
    $('metric-mod-next').disabled = !mmNextCur();

    /* 指标卡 */
    var cards = [];
    function card(label, value, sub, color) {
      cards.push('<div class="card ' + (value ? '' : ' no-data') + '" style="cursor:default"><div class="card-head"><span class="card-label"><span class="dot" style="background:' + color + '"></span>' + label + '</span></div>' +
        '<div class="card-value">' + (value || 'NO DATA') + '</div><div class="card-sub">' + (sub || '&nbsp;') + '</div></div>');
    }
    var isDay = state.metricMod.gran === 'day';
    var mainVal = null, mainSub = '';
    if (agg.n) {
      if (lib.kind === 'last') { mainVal = mmFmt(agg.last, lib.unit, 'last'); mainSub = agg.lastD + ' 最新'; }
      else { mainVal = mmFmt(agg.sum / agg.n, lib.unit); mainSub = (isDay ? '当日' : '日均') + ' · ' + agg.n + ' 天有记录'; }
    }
    var prevMain = null;
    if (prevAgg && prevAgg.n) {
      if (lib.kind === 'last') prevMain = prevAgg.last;
      else prevMain = prevAgg.sum / prevAgg.n;
    }
    var vs = '';
    if (prevMain != null && mainVal != null) {
      var curNum = lib.kind === 'last' ? agg.last : agg.sum / agg.n;
      var dPct = prevMain ? Math.round((curNum - prevMain) / prevMain * 100) : null;
      var cls = curNum >= prevMain ? 'up' : 'down';
      vs = '<span class="' + cls + '">' + (curNum >= prevMain ? '▲ +' : '▼ ') + (dPct != null ? Math.abs(dPct) + '%' : '') + '</span> vs 上期';
    }
    card(lib.kind === 'last' ? '最新值' : '日均值', mainVal, mainSub + ' ' + vs, lib.color);
    card('窗口最高', agg.n ? mmFmt(agg.max, lib.unit, lib.kind) : '', agg.n ? '' : '', lib.color);
    card('窗口最低', agg.n ? mmFmt(agg.min, lib.unit, lib.kind) : '', agg.n ? '' : '', lib.color);
    card('覆盖天数', (agg.n ? agg.n : 0) + '<small>天</small>', '窗口 ' + win.label, lib.color);
    card('总记录天数', days.length + '<small>天</small>', days.length ? shortDay(days[0].ts, true) + ' → ' + shortDay(days[days.length - 1].ts, true) : '', lib.color);
    $('metric-mod-cards').innerHTML = cards.join('');

    /* 主图 */
    var wrap = $('metric-mod-wrap');
    clearEmpty(wrap);
    var showDays = isDay ? days.slice(-30) : inWin;
    if (!showDays.length) { emptyState($('metric-mod-chart'), '该窗口没有数据'); }
    else {
      drawLineChart($('metric-mod-chart'), showDays, { label: lib.label, unit: lib.unit, color: lib.color }, {
        tipEl: $('metric-mod-tip'),
        tipExtra: function (d) { return d.n ? '<div class="t-row"><span>记录数</span><b>' + fmtNum(d.n) + '</b></div>' : ''; }
      });
    }
    $('metric-mod-meta').innerHTML =
      '<span><b>指标：</b>' + esc(lib.label) + '（' + esc(lib.unit) + '）</span>' +
      '<span><b>粒度：</b>' + (isDay ? '近 30 天趋势' : state.metricMod.gran === 'week' ? '本周 7 天' : '本月每日') + '</span>' +
      '<span><b>口径：</b>' + (lib.kind === 'sum' ? '累计值' : lib.kind === 'last' ? '最新值' : '日均值') + '</span>';

    /* 周热力 */
    var heatWrap = $('metric-mod-heat');
    var rng = sliceRange(days, 'all');
    $('metric-mod-heat-label').textContent = rng.list.length + ' 天 · ' + shortDay(rng.list[0].ts, true) + ' → ' + shortDay(rng.list[rng.list.length - 1].ts, true);
    renderHeatGrid(heatWrap, rng.list, lib.color, 0, lib.label, $('metric-mod-tip'), function (v) { return mmFmt(v, lib.unit, lib.kind); });

    /* 统计摘要（近 12 周） */
    var weeks = [];
    if (days.length) {
      var endKey = days[days.length - 1].d;
      var ws = weekStartKey(endKey);
      for (var i = 11; i >= 0; i--) {
        var wkStart = dayKeyAdd(ws, -i * 7), wkEnd = dayKeyAdd(wkStart, 6);
        var wDays = windowDays(days, wkStart, wkEnd);
        var wAgg = aggMetricDays(wDays);
        weeks.push({ wk: wkStart.slice(5), v: wAgg.n ? (lib.kind === 'last' ? wAgg.last : wAgg.sum / wAgg.n) : null, n: wAgg.n });
      }
    }
    var wkVals = weeks.filter(function (w) { return w.v != null; });
    var statsHtml = '';
    if (wkVals.length) {
      var vals = wkVals.map(function (w) { return w.v; });
      var avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals);
      statsHtml =
        '<div class="qual-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">' +
        '<div class="qual-item"><div class="k">近 12 周周均</div><div class="v">' + mmFmt(avg, lib.unit, lib.kind) + '</div></div>' +
        '<div class="qual-item"><div class="k">周最高</div><div class="v">' + mmFmt(mx, lib.unit, lib.kind) + '</div></div>' +
        '<div class="qual-item"><div class="k">周最低</div><div class="v">' + mmFmt(mn, lib.unit, lib.kind) + '</div></div>' +
        '<div class="qual-item"><div class="k">有数据周数</div><div class="v">' + wkVals.length + '/12</div></div>' +
        '</div>';
      if (lib.kind !== 'last') {
        statsHtml += '<div class="qual-note" style="margin-top:8px">趋势周均：' + wkVals.map(function (w) { return w.wk + ' ' + mmFmt(w.v, lib.unit); }).join(' · ') + '</div>';
      }
    } else {
      statsHtml = '<div class="qual-note">数据不足以计算周统计。</div>';
    }
    $('metric-mod-stats').innerHTML = statsHtml;
  }
  function renderOthers() {
    buildMetricLib();
    renderMetricModule();
    /* 指标清单表格 */
    var rows = METRIC_LIB.map(function (m) {
      var info = m.key.indexOf('other:') === 0
        ? (state.res.other.find(function (o) { return o.type === m.key.slice(6); }) || null)
        : null;
      var daysArr = info ? info.days : ((state.res.daily[m.key] || {}).days || []);
      var last = daysArr.length ? daysArr[daysArr.length - 1] : null;
      var latest = last ? mmFmt(last.v, m.unit, m.kind) : '—';
      return '<tr data-key="' + esc(m.key) + '"><td>' + esc(m.label) + '</td><td class="mut">' + esc(m.key.replace(/^other:/, '').replace(/^HK(?:Quantity|Category)TypeIdentifier/, '')) + '</td>' +
        '<td class="num">' + fmtNum(daysArr.length) + '</td><td class="mut">' + (daysArr.length ? shortDay(daysArr[0].ts, true) + ' → ' + shortDay(daysArr[daysArr.length - 1].ts, true) : '—') + '</td><td class="num">' + latest + '</td></tr>';
    }).join('');
    $('others-table').innerHTML =
      '<thead><tr><th>指标</th><th>原始类型</th><th>记录天数</th><th>覆盖范围</th><th>最新日均</th></tr></thead><tbody>' + rows + '</tbody>';
    $('others-table').querySelectorAll('tbody tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        state.metricMod.sel = tr.getAttribute('data-key');
        state.metricMod.gran = 'day';
        state.metricMod.cur = null;
        renderMetricModule();
      });
    });
  }
  $('metric-mod-select').addEventListener('change', function () {
    state.metricMod.sel = this.value;
    state.metricMod.cur = null;
    renderMetricModule();
  });
  $('metric-mod-gran').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (!t) return;
    var g = t.getAttribute('data-gran');
    state.metricMod.gran = g;
    if (g === 'week' && state.metricMod.cur) state.metricMod.cur = weekStartKey(state.metricMod.cur);
    if (g === 'month' && state.metricMod.cur) state.metricMod.cur = state.metricMod.cur.slice(0, 7) + '-01';
    renderMetricModule();
  });
  $('metric-mod-prev').addEventListener('click', function () { var p = mmPrevCur(); if (p) { state.metricMod.cur = p; renderMetricModule(); } });
  $('metric-mod-next').addEventListener('click', function () { var n = mmNextCur(); if (n) { state.metricMod.cur = n; renderMetricModule(); } });

  /* ---------------- URL 测试钩子（http 调试用） ---------------- */
  (function () {
    var q = new URLSearchParams(location.search);
    var sample = q.get('sample');
    if (!sample) return;
    if (q.get('module')) state.module = q.get('module');
    if (q.get('gran')) { state.sleepGran = q.get('gran'); state.hrGran = q.get('gran'); }
    if (q.get('metric')) state.metric = q.get('metric');
    if (q.get('range')) state.range = q.get('range');
    fetch(sample).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var file = new File([buf], sample.split('/').pop() || 'export.xml', { type: 'text/xml' });
      startParse(file);
    }).catch(function (e) {
      showError('样例加载失败：' + e.message);
    });
  })();

  /* 窗口尺寸变化重绘 */
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (!state.res) return;
      if (state.module === 'overview') renderOverview();
      else if (state.module === 'sleep') renderSleep();
      else if (state.module === 'heart') renderHeart();
      else if (state.module === 'others') renderOthers();
    }, 180);
  });
})();
