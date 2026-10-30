/* Levels — cassette tape · multi-ticker ready (AVGO first) · K-line on every tab */
(function () {
  'use strict';

  const KIND_LABEL = { resistance: '压力', support: '支撑', anchor: '锚点' };
  const KIND_CLASS = { resistance: 'kind-res', support: 'kind-sup', anchor: 'kind-anc' };

  const filters = {
    kinds: { resistance: true, support: true, anchor: true },
    preset: 'priority',
    vrvp: true,
  };
  const lvFilters = {
    kinds: { resistance: true, support: true, anchor: true },
    preset: 'priority',
  };
  const holdFilters = { side: 'all', out: 'all' };
  const brkFilters = { dir: 'all' };

  let DATA = null;
  let profileCache = null;
  let overlayRaf = 0;

  /* observe chart */
  let chart = null;
  let candleSeries = null;
  let priceLines = [];

  /* satellite charts */
  const tapes = {
    levels: { chart: null, series: null, lines: [], inited: false },
    hold: { chart: null, series: null, lines: [], inited: false },
    break: { chart: null, series: null, lines: [], inited: false },
    playback: { chart: null, series: null, lines: [], inited: false },
  };

  const playState = {
    idx: 0,
    playing: false,
    timer: null,
    speed: 1,
    layers: { hold: true, break: true },
    fullCandles: null,
    holdEvents: null,
    breakEvents: null,
  };

  function $(sel) { return document.querySelector(sel); }
  function pct(x, d) {
    if (x == null || Number.isNaN(x)) return '—';
    return (Number(x) * 100).toFixed(d == null ? 0 : d) + '%';
  }
  function pctPts(x, d) {
    if (x == null || Number.isNaN(x)) return '—';
    const n = Number(x);
    return (n >= 0 ? '+' : '') + n.toFixed(d == null ? 1 : d) + '%';
  }
  function clsRet(x) {
    if (x == null || Number.isNaN(x)) return 'muted';
    return Number(x) >= 0 ? 'pos' : 'neg';
  }
  function toUnix(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 1000);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function barHtml(rate, cls) {
    const w = Math.max(0, Math.min(100, (Number(rate) || 0) * 100));
    return '<div class="bar ' + (cls || '') + '"><i style="width:' + w.toFixed(1) + '%"></i></div>';
  }
  function cell(lab, val, sub, bar) {
    return '<div class="cell"><div class="lab">' + esc(lab) + '</div><div class="val">' +
      val + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      (bar || '') + '</div>';
  }
  function windowLabel(defs) {
    if (!defs) return '';
    const yrs = defs.years ? defs.years + ' 年' : (defs.window || '');
    return yrs + (defs.n_bars ? ' · ' + defs.n_bars + 'K' : '') + (defs.display_from ? ' · 图上近1年' : '');
  }
  function ciText(lo, hi) {
    if (lo == null || hi == null) return '';
    return '[' + Math.round(lo * 100) + '–' + Math.round(hi * 100) + '%]';
  }
  function holdSub(s, base) {
    return 'n=' + (s.n || 0) + (base != null ? ' · 对照 ' + pct(base) : '');
  }
  function famHoldRow(f, hold) {
    const isR = f.side === 'resistance';
    const base = isR ? hold.baseline_resistance : hold.baseline_support;
    const w = Math.max(0, Math.min(100, (f.hit_rate || 0) * 100));
    const beat = base != null && f.ci_lo != null && f.ci_lo > base;
    return '<div class="fam"><span class="nm">' + esc(f.family || '') +
      '<span class="tag ' + (isR ? 'r' : '') + '">' + (isR ? '压' : '撑') + '</span>' +
      (beat ? '<span class="tag ok" title="95% 区间下沿高于对照">✓</span>' : '') + '</span>' +
      '<span class="rt">' + pct(f.hit_rate) + '</span>' +
      '<div class="fb ' + (isR ? 'r' : '') + '"><i style="width:' + w.toFixed(1) + '%"></i>' +
      (base != null ? '<b class="base" style="left:' + (base * 100).toFixed(1) + '%"></b>' : '') + '</div>' +
      '<span class="n">n=' + f.n + ' ' + ciText(f.ci_lo, f.ci_hi) + '</span></div>';
  }

  function PRI_LABEL(p) {
    return ({ 0: '现价', 1: '高优', 2: '中', 3: '低' })[p] || String(p);
  }

  const SYMBOLS = ['AVGO', 'SKHY', 'CRWV'];
  const VIEWS = ['signal', 'observe', 'levels', 'hold', 'break', 'playback'];

  function currentSymbol() {
    const s = (new URLSearchParams(location.search).get('s') || '').toUpperCase();
    return SYMBOLS.indexOf(s) >= 0 ? s : 'AVGO';
  }

  function loadScript(src) {
    return new Promise(function (resolve) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(url + ' HTTP ' + res.status);
    return res.json();
  }

  async function loadData() {
    const sym = currentSymbol();
    try {
      return await fetchJson('./data/' + sym + '.json');
    } catch (e) {
      if (sym !== 'AVGO') throw e;
      try {
        return await fetchJson('./data.json');
      } catch (e2) {
        await loadScript('./fallback-data.js');
        if (window.__AVGO_FALLBACK__) {
          console.warn('data fetch failed, using fallback', e2);
          return window.__AVGO_FALLBACK__;
        }
        throw e2;
      }
    }
  }

  function levelPasses(lv, f) {
    if (!f.kinds[lv.kind]) return false;
    if (f.preset === 'priority') return lv.priority <= 1;
    if (f.preset === 'near5') return Math.abs(Number(lv.dist_pct)) <= 5;
    return true;
  }
  function visibleLevels(f) {
    return (DATA.levels || []).filter(function (lv) { return levelPasses(lv, f || filters); });
  }

  function classifyVrvpLevel(lv) {
    const blob = ((lv.role || '') + ' ' + (lv.sources || []).join(' ')).toUpperCase();
    if (blob.indexOf('POC') >= 0) return 'poc';
    if (blob.indexOf('VAH') >= 0) return 'vah';
    if (blob.indexOf('VAL') >= 0) return 'val';
    if (blob.indexOf('HVN') >= 0) return 'hvn';
    if (blob.indexOf('LVN') >= 0) return 'lvn';
    return null;
  }

  function computeVolumeProfile(ohlcv, nBins) {
    if (!ohlcv || !ohlcv.length) return null;
    let lo = Infinity, hi = -Infinity;
    ohlcv.forEach(function (b) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    });
    if (!(hi > lo)) return null;
    const bins = nBins || 48;
    const step = (hi - lo) / bins;
    const vol = new Float64Array(bins);
    ohlcv.forEach(function (b) {
      const v = Number(b.volume) || 0;
      if (v <= 0) return;
      const i0 = Math.max(0, Math.min(bins - 1, Math.floor((b.low - lo) / step)));
      const i1 = Math.max(0, Math.min(bins - 1, Math.floor((b.high - lo) / step)));
      const span = i1 - i0 + 1;
      const share = v / span;
      for (let i = i0; i <= i1; i++) vol[i] += share;
    });
    let max = 0, pocIdx = 0;
    for (let i = 0; i < bins; i++) {
      if (vol[i] > max) { max = vol[i]; pocIdx = i; }
    }
    const total = Array.prototype.reduce.call(vol, function (a, b) { return a + b; }, 0);
    let covered = vol[pocIdx];
    let L = pocIdx, R = pocIdx;
    const target = total * 0.7;
    while (covered < target && (L > 0 || R < bins - 1)) {
      const left = L > 0 ? vol[L - 1] : -1;
      const right = R < bins - 1 ? vol[R + 1] : -1;
      if (right >= left) { R++; covered += vol[R]; }
      else { L--; covered += vol[L]; }
    }
    return {
      lo: lo, hi: hi, step: step, bins: bins, vol: vol, max: max,
      poc: lo + (pocIdx + 0.5) * step,
      val: lo + L * step,
      vah: lo + (R + 1) * step,
      total: total,
    };
  }
  function getProfile() {
    if (profileCache) return profileCache;
    profileCache = computeVolumeProfile(DATA.ohlcv, 48);
    return profileCache;
  }

  function candleData() {
    if (DATA.ohlcv && DATA.ohlcv.length) {
      return DATA.ohlcv.map(function (b) {
        return { time: toUnix(b.date), open: b.open, high: b.high, low: b.low, close: b.close };
      });
    }
    if (DATA.price_series && DATA.price_series.length) {
      return DATA.price_series.map(function (b) {
        const c = b.close;
        return { time: toUnix(b.date), open: c, high: c, low: c, close: c };
      });
    }
    return [];
  }

  function chartTheme() {
    return {
      layout: {
        background: { type: 'solid', color: '#010302' },
        textColor: '#7a8a62',
        fontSize: 15,
        fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace',
      },
      grid: {
        vertLines: { color: 'rgba(90, 130, 55, 0.12)' },
        horzLines: { color: 'rgba(90, 130, 55, 0.12)' },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255, 184, 58, 0.35)', width: 1, style: 2, labelBackgroundColor: '#1a1d14' },
        horzLine: { color: 'rgba(159, 212, 95, 0.35)', width: 1, style: 2, labelBackgroundColor: '#1a1d14' },
      },
      rightPriceScale: { borderColor: '#24301a', scaleMargins: { top: 0.04, bottom: 0.08 } },
      timeScale: { borderColor: '#24301a', timeVisible: false, rightOffset: 4 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    };
  }

  function candleOpts() {
    /* CRT phosphor glow tubes — near-solid neon (unmistakable bloom) */
    return {
      upColor: '#6fff5a',
      downColor: '#ffaa28',
      borderUpColor: '#6fff5a',
      borderDownColor: '#ffaa28',
      wickUpColor: '#b8ff90',
      wickDownColor: '#ffd878',
      borderVisible: true,
    };
  }

  function lineColor(kind, priority) {
    if (kind === 'resistance') return priority <= 1 ? 'rgba(255,184,58,0.95)' : 'rgba(255,184,58,0.42)';
    if (kind === 'support') return priority <= 1 ? 'rgba(159,212,95,0.95)' : 'rgba(159,212,95,0.4)';
    return 'rgba(255,208,120,0.9)';
  }

  function bindCrosshair(ch, series, elId) {
    ch.subscribeCrosshairMove(function (param) {
      const bar = $(elId);
      if (!bar) return;
      if (!param || !param.time || !param.seriesData) {
        bar.textContent = '十字线 · OHLC';
        return;
      }
      const d = param.seriesData.get(series);
      if (!d) { bar.textContent = '—'; return; }
      const t = param.time;
      let dateStr = '';
      if (typeof t === 'number') {
        dateStr = new Date(t * 1000).toISOString().slice(0, 10);
      } else if (t && t.year) {
        dateStr = t.year + '-' + String(t.month).padStart(2, '0') + '-' + String(t.day).padStart(2, '0');
      }
      bar.innerHTML = '<strong>' + esc(dateStr) + '</strong>  O ' + d.open.toFixed(2) +
        '  H ' + d.high.toFixed(2) + '  L ' + d.low.toFixed(2) +
        '  C <strong>' + d.close.toFixed(2) + '</strong>';
    });
  }

  function bindResize(ch, el) {
    function sync() {
      if (!ch || !el) return;
      const stack = el.parentElement;
      const w = stack ? stack.clientWidth : el.clientWidth;
      const h = stack ? stack.clientHeight : el.clientHeight;
      if (w > 0 && h > 0) ch.applyOptions({ width: w, height: h });
    }
    const ro = new ResizeObserver(sync);
    const stack = el.closest('.chart-stack') || el;
    ro.observe(stack);
    const pane = el.closest('.chart-pane');
    if (pane) ro.observe(pane);
    const obs = el.closest('.obs');
    if (obs) ro.observe(obs);
    window.addEventListener('resize', sync);
    requestAnimationFrame(function () { requestAnimationFrame(sync); });
    sync();
    return sync;
  }

  function clearLines(series, arr) {
    if (!series) return;
    arr.forEach(function (pl) {
      try { series.removePriceLine(pl); } catch (e) { /* */ }
    });
    arr.length = 0;
  }

  function applyLevelLines(series, linesArr, levels, withVrvp) {
    clearLines(series, linesArr);
    if (!series) return;
    levels.forEach(function (lv) {
      const pl = series.createPriceLine({
        price: lv.price,
        color: lineColor(lv.kind, lv.priority),
        lineWidth: lv.priority <= 1 || lv.kind === 'anchor' ? 2 : 1,
        lineStyle: lv.kind === 'anchor' ? LightweightCharts.LineStyle.Dashed :
          (lv.priority <= 1 ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed),
        axisLabelVisible: lv.priority <= 1 || lv.kind === 'anchor',
        title: KIND_LABEL[lv.kind] + ' ' + lv.price,
      });
      linesArr.push(pl);
    });
    if (withVrvp && DATA.state && DATA.state.vrvp) {
      const v = DATA.state.vrvp;
      [
        { price: v.poc, color: 'rgba(232,168,56,0.95)', w: 2, title: 'POC', style: LightweightCharts.LineStyle.Solid },
        { price: v.vah, color: 'rgba(230,220,196,0.45)', w: 1, title: 'VAH', style: LightweightCharts.LineStyle.Dashed },
        { price: v.val, color: 'rgba(230,220,196,0.45)', w: 1, title: 'VAL', style: LightweightCharts.LineStyle.Dashed },
      ].forEach(function (cfg) {
        if (cfg.price == null) return;
        linesArr.push(series.createPriceLine({
          price: cfg.price, color: cfg.color, lineWidth: cfg.w,
          lineStyle: cfg.style, axisLabelVisible: true, title: cfg.title,
        }));
      });
    }
  }

  function renderHeader() {
    const sym = DATA.symbol || 'AVGO';
    $('#title').textContent = sym;
    document.title = 'Levels · ' + sym;
    const close = Number(DATA.last_close).toFixed(2);
    $('#asof').innerHTML = '截至 <strong>' + esc(DATA.as_of) + '</strong> · 末收 <strong>' +
      close + '</strong>';
    document.querySelectorAll('#tickerSwitch .tick').forEach(function (btn) {
      const s = btn.getAttribute('data-symbol');
      const on = s === sym;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.onclick = function () {
        if (on) return;
        const view = (location.hash || '').replace('#', '');
        location.href = '?s=' + s + (VIEWS.indexOf(view) >= 0 ? '#' + view : '');
      };
    });
  }

  /* —— Observe VRVP overlay (unchanged logic) —— */
  function scheduleOverlay() {
    if (overlayRaf) cancelAnimationFrame(overlayRaf);
    overlayRaf = requestAnimationFrame(function () {
      overlayRaf = 0;
      drawVrvpOverlay();
    });
  }

  function drawVrvpOverlay() {
    const canvas = $('#vrvpOverlay');
    if (!canvas || !candleSeries || !chart) return;
    const stack = canvas.parentElement;
    const w = stack.clientWidth;
    const h = stack.clientHeight;
    if (w < 10 || h < 10) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!filters.vrvp) return;
    const st = DATA.state || {};
    const vrvp = st.vrvp || {};
    const yOf = function (p) {
      try { return candleSeries.priceToCoordinate(p); } catch (e) { return null; }
    };
    if (vrvp.val != null && vrvp.vah != null) {
      const y1 = yOf(vrvp.vah);
      const y2 = yOf(vrvp.val);
      if (y1 != null && y2 != null) {
        const top = Math.min(y1, y2);
        const bot = Math.max(y1, y2);
        ctx.fillStyle = 'rgba(232,168,56,0.08)';
        ctx.fillRect(0, top, w, bot - top);
        ctx.strokeStyle = 'rgba(232,168,56,0.28)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, top); ctx.lineTo(w, top);
        ctx.moveTo(0, bot); ctx.lineTo(w, bot);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    (DATA.levels || []).forEach(function (lv) {
      const tag = classifyVrvpLevel(lv);
      if (!tag || tag === 'poc' || tag === 'vah' || tag === 'val') return;
      const y = yOf(lv.price);
      if (y == null) return;
      const bandH = 7;
      if (tag === 'hvn') {
        ctx.fillStyle = 'rgba(143,188,90,0.18)';
        ctx.fillRect(0, y - bandH / 2, w, bandH);
      } else if (tag === 'lvn') {
        ctx.fillStyle = 'rgba(212,120,58,0.14)';
        ctx.fillRect(0, y - bandH / 2, w, bandH);
      }
    });
    const prof = getProfile();
    if (!prof || !prof.max) return;
    const profileW = Math.min(96, Math.max(56, w * 0.14));
    const x0 = w - profileW - 4;
    for (let i = 0; i < prof.bins; i++) {
      const pLo = prof.lo + i * prof.step;
      const pHi = pLo + prof.step;
      const ya = yOf(pHi);
      const yb = yOf(pLo);
      if (ya == null || yb == null) continue;
      const top = Math.min(ya, yb);
      const bot = Math.max(ya, yb);
      const bh = Math.max(1, bot - top);
      const ratio = prof.vol[i] / prof.max;
      const bw = ratio * (profileW - 4);
      const inVA = (vrvp.val != null && vrvp.vah != null && pLo >= vrvp.val && pHi <= vrvp.vah);
      ctx.fillStyle = inVA ? 'rgba(232,168,56,0.45)' : 'rgba(154,144,120,0.28)';
      ctx.fillRect(x0 + (profileW - 4 - bw), top, bw, bh);
    }
    if (vrvp.poc != null) {
      const yp = yOf(vrvp.poc);
      if (yp != null) {
        ctx.strokeStyle = 'rgba(232,168,56,0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, yp);
        ctx.lineTo(x0 + profileW - 2, yp);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(232,168,56,0.7)';
    ctx.font = '9px IBM Plex Mono, SF Mono, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('VRVP', w - 6, 12);
  }

  function clearPriceLines() {
    clearLines(candleSeries, priceLines);
  }

  function applyPriceLines() {
    if (!candleSeries) return;
    applyLevelLines(candleSeries, priceLines, visibleLevels(filters), filters.vrvp);
    renderLegend();
    scheduleOverlay();
  }

  function renderLegend() {
    const el = $('#levelLegend');
    if (!el) return;
    const parts = [];
    if (filters.vrvp && DATA.state && DATA.state.vrvp) {
      const v = DATA.state.vrvp;
      parts.push('<span class="lg"><span class="sw va"></span>VA ' +
        Number(v.val).toFixed(0) + '–' + Number(v.vah).toFixed(0) + '</span>');
      parts.push('<span class="lg"><span class="sw poc"></span>POC ' + Number(v.poc).toFixed(1) + '</span>');
    }
    visibleLevels(filters).slice().sort(function (a, b) { return b.price - a.price; })
      .forEach(function (lv) {
        const k = lv.kind === 'resistance' ? 'res' : (lv.kind === 'support' ? 'sup' : 'anc');
        const dist = (lv.dist_pct >= 0 ? '+' : '') + Number(lv.dist_pct).toFixed(1) + '%';
        parts.push('<span class="lg"><span class="sw ' + k + '"></span>' +
          '<span class="px">' + lv.price.toFixed(1) + '</span> ' +
          KIND_LABEL[lv.kind] + ' ' + dist + '</span>');
      });
    el.innerHTML = parts.join('');
  }

  function buildChart() {
    const el = $('#chart');
    if (!el || typeof LightweightCharts === 'undefined') return;
    el.innerHTML = '';
    chart = LightweightCharts.createChart(el, chartTheme());
    candleSeries = chart.addCandlestickSeries(candleOpts());
    candleSeries.setData(candleData());
    applyPriceLines();
    chart.timeScale().fitContent();
    bindCrosshair(chart, candleSeries, '#crossBar');
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlay);
    chart.subscribeCrosshairMove(scheduleOverlay);
    bindResize(chart, el);
  }

  function ensureChartSized(key) {
    const pack = key === 'signal' ? { chart: sig.chart } : (key ? tapes[key] : null);
    const ch = pack ? pack.chart : chart;
    const el = $(key === 'signal' ? '#chartSig' : key === 'levels' ? '#chartLevels' : key === 'hold' ? '#chartHold' : key === 'break' ? '#chartBreak' : key === 'playback' ? '#chartPlay' : '#chart');
    if (!ch || !el) return;
    const stack = el.parentElement;
    const w = stack ? stack.clientWidth : el.clientWidth;
    const h = stack ? stack.clientHeight : el.clientHeight;
    if (w > 0 && h > 0) {
      ch.applyOptions({ width: w, height: h });
      ch.timeScale().fitContent();
      if (!key) scheduleOverlay();
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { ensureChartSized(key); });
      });
    }
  }

  function renderObsAccuracy() {
    const bt = DATA.backtest || {};
    const hold = bt.hold || {};
    const br = bt.breakout || {};
    const defs = bt.definitions || {};
    const winEl = $('#accWindow');
    if (winEl) winEl.textContent = windowLabel(defs);
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#obsHoldKpi').innerHTML = [
      cell('支撑', pct(os.hit_rate), holdSub(os, hold.baseline_support), barHtml(os.hit_rate, '')),
      cell('压力', pct(or_.hit_rate), holdSub(or_, hold.baseline_resistance), barHtml(or_.hit_rate, 'res')),
    ].join('');
    const fam = hold.by_family || {};
    // Rank by the lower confidence bound so tiny samples can't top the list.
    const ranked = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n >= 10; })
      .sort(function (a, b) { return (b.ci_lo || 0) - (a.ci_lo || 0); })
      .slice(0, 6);
    if (!ranked.length) {
      $('#obsTopFamilies').innerHTML = '<div class="muted" style="padding:4px 12px;font-size:15px">样本不足（每族需 ≥10 次）</div>';
    } else {
      $('#obsTopFamilies').innerHTML = ranked.map(function (f) { return famHoldRow(f, hold); }).join('');
    }
    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};
    function bcell(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      return cell(
        (dir === 'up' ? '↑' : '↓') + h + 'd 超额',
        '<span class="' + clsRet(s.excess_mean) + '">' + pctPts(s.excess_mean, 2) + '</span>',
        '均 ' + pctPts(s.mean, 2) + ' 胜' + pct(s.win_rate) + ' n=' + (s.n || 0),
        barHtml(s.win_rate, dir === 'down' ? 'res' : '')
      );
    }
    $('#obsBreakKpi').innerHTML = [
      bcell('up', 1), bcell('up', 3), bcell('up', 5),
      bcell('down', 1), bcell('down', 3), bcell('down', 5),
    ].join('');
  }

  /* —— 点位 —— */
  function renderLevelsLadder() {
    const rows = visibleLevels(lvFilters).slice().sort(function (a, b) { return b.price - a.price; });
    const maxAbs = Math.max.apply(null, rows.map(function (lv) {
      return Math.abs(Number(lv.dist_pct) || 0);
    }).concat([5]));
    $('#levelsLadder').innerHTML = rows.map(function (lv) {
      const dist = Number(lv.dist_pct) || 0;
      const w = Math.min(100, (Math.abs(dist) / maxAbs) * 100);
      const tag = classifyVrvpLevel(lv);
      const near = Math.abs(dist) <= 3;
      const kcls = lv.kind === 'resistance' ? 'res' : (lv.kind === 'support' ? 'sup' : 'anc');
      return '<div class="lad ' + kcls + (near ? ' near' : '') + '">' +
        '<div class="px">' + lv.price.toFixed(2) + '</div>' +
        '<div class="dist ' + (dist >= 0 ? 'pos' : 'neg') + '">' +
          (dist >= 0 ? '+' : '') + dist.toFixed(1) + '%</div>' +
        '<div class="kind ' + KIND_CLASS[lv.kind] + '">' + KIND_LABEL[lv.kind] + '</div>' +
        '<div class="track"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<div class="mark">' + (tag ? tag.toUpperCase() : PRI_LABEL(lv.priority)) + '</div>' +
        '</div>';
    }).join('');

    const leg = $('#levelsLegend');
    if (leg) {
      leg.innerHTML = rows.slice(0, 8).map(function (lv) {
        const k = lv.kind === 'resistance' ? 'res' : (lv.kind === 'support' ? 'sup' : 'anc');
        return '<span class="lg"><span class="sw ' + k + '"></span>' + lv.price.toFixed(1) + '</span>';
      }).join('');
    }
  }

  function refreshLevelsChart() {
    const t = tapes.levels;
    if (!t.series) return;
    applyLevelLines(t.series, t.lines, visibleLevels(lvFilters), true);
    renderLevelsLadder();
  }

  function initLevelsChart() {
    const el = $('#chartLevels');
    if (!el || typeof LightweightCharts === 'undefined') return;
    if (tapes.levels.inited) {
      ensureChartSized('levels');
      refreshLevelsChart();
      return;
    }
    el.innerHTML = '';
    const ch = LightweightCharts.createChart(el, chartTheme());
    const series = ch.addCandlestickSeries(candleOpts());
    series.setData(candleData());
    tapes.levels = { chart: ch, series: series, lines: [], inited: true };
    refreshLevelsChart();
    ch.timeScale().fitContent();
    bindCrosshair(ch, series, '#crossLevels');
    bindResize(ch, el);
    const fit = $('#btnFitLevels');
    if (fit) fit.onclick = function () { ch.timeScale().fitContent(); };
  }

  /* —— 触及 —— */
  function holdEventsFiltered() {
    const ev = ((DATA.backtest || {}).hold || {}).events || [];
    return ev.filter(function (e) {
      if (holdFilters.side !== 'all' && e.side !== holdFilters.side) return false;
      if (holdFilters.out === 'held' && !e.held) return false;
      if (holdFilters.out === 'broken' && e.held) return false;
      return true;
    });
  }

  function refreshHoldMarkers() {
    const t = tapes.hold;
    if (!t.series) return;
    const evs = holdEventsFiltered();
    // one marker per date — prefer broken over held if both
    const byDate = {};
    evs.forEach(function (e) {
      const cur = byDate[e.date];
      if (!cur || (cur.held && !e.held)) byDate[e.date] = e;
    });
    const markers = Object.keys(byDate).sort().map(function (dt) {
      const e = byDate[dt];
      const held = !!e.held;
      const isSup = e.side === 'support';
      return {
        time: toUnix(dt),
        position: isSup ? 'belowBar' : 'aboveBar',
        color: held ? '#9fff5c' : '#ffb83a',
        shape: held ? 'circle' : 'square',
        text: (isSup ? '撑' : '压') + (held ? '✓' : '✗'),
      };
    });
    t.series.setMarkers(markers);

    // draw level lines for recent events (unique levels)
    clearLines(t.series, t.lines);
    const seen = {};
    evs.slice().reverse().forEach(function (e) {
      const key = e.family + '|' + e.level;
      if (seen[key]) return;
      if (Object.keys(seen).length >= 12) return;
      seen[key] = true;
      t.lines.push(t.series.createPriceLine({
        price: e.level,
        color: e.side === 'support' ? 'rgba(143,188,90,0.55)' : 'rgba(212,120,58,0.55)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
        title: e.family,
      }));
    });

    const cross = $('#crossHold');
    if (cross) {
      cross.innerHTML = '触及事件 <strong>' + evs.length + '</strong> · 图上标记 ' + markers.length;
    }
  }

  function renderHoldRail() {
    const bt = DATA.backtest || {};
    const hold = bt.hold || {};
    const def = (bt.definitions && bt.definitions.hold_def_zh) || '';
    const holdDef = $('#holdDef');
    if (holdDef) {
      holdDef.textContent = def.replace(/描述性回测，非交易建议。?$/, '').trim();
    }
    const win = $('#holdWin');
    if (win) win.textContent = windowLabel(bt.definitions);
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    const rg = hold.by_regime || {};
    $('#holdKpi').innerHTML = [
      cell('支撑', pct(os.hit_rate), holdSub(os, hold.baseline_support), barHtml(os.hit_rate, '')),
      cell('压力', pct(or_.hit_rate), holdSub(or_, hold.baseline_resistance), barHtml(or_.hit_rate, 'res')),
      cell('上升趋势撑', pct((rg['up|support'] || {}).hit_rate), 'n=' + ((rg['up|support'] || {}).n || 0)),
      cell('下降趋势撑', pct((rg['down|support'] || {}).hit_rate), 'n=' + ((rg['down|support'] || {}).n || 0)),
    ].join('');
    const fam = hold.by_family || {};
    const list = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n > 0; })
      .sort(function (a, b) { return (b.ci_lo || 0) - (a.ci_lo || 0); });
    $('#holdChart').innerHTML = list.map(function (f) { return famHoldRow(f, hold); }).join('');
  }

  function initHoldChart() {
    const el = $('#chartHold');
    if (!el || typeof LightweightCharts === 'undefined') return;
    if (tapes.hold.inited) {
      ensureChartSized('hold');
      refreshHoldMarkers();
      return;
    }
    el.innerHTML = '';
    const ch = LightweightCharts.createChart(el, chartTheme());
    const series = ch.addCandlestickSeries(candleOpts());
    series.setData(candleData());
    tapes.hold = { chart: ch, series: series, lines: [], inited: true };
    refreshHoldMarkers();
    ch.timeScale().fitContent();
    bindCrosshair(ch, series, '#crossHold');
    bindResize(ch, el);
    const fit = $('#btnFitHold');
    if (fit) fit.onclick = function () { ch.timeScale().fitContent(); };
  }

  /* —— 突破 —— */
  function breakEventsFiltered() {
    const br = (DATA.backtest || {}).breakout || {};
    let ev = br.events || [];
    if (!ev.length) {
      ev = [].concat(br.examples_up || [], br.examples_down || []);
    }
    return ev.filter(function (e) {
      if (brkFilters.dir !== 'all' && e.dir !== brkFilters.dir) return false;
      return true;
    });
  }

  function refreshBreakMarkers() {
    const t = tapes.break;
    if (!t.series) return;
    const evs = breakEventsFiltered();
    // one marker per date+dir (LWCharts allows one set per series)
    const seen = {};
    const markers = [];
    evs.forEach(function (e) {
      const key = e.date + '|' + e.dir;
      if (seen[key]) return;
      seen[key] = true;
      const up = e.dir === 'up';
      const r5 = e.rets && e.rets['5'];
      markers.push({
        time: toUnix(e.date),
        position: up ? 'aboveBar' : 'belowBar',
        color: up ? '#ffd078' : '#ffb83a',
        shape: up ? 'arrowUp' : 'arrowDown',
        text: (up ? '↑' : '↓') + (r5 != null ? pctPts(r5, 1) : ''),
      });
    });
    // LWCharts: only one marker per time — keep last for same timestamp
    const byTime = {};
    markers.forEach(function (m) { byTime[m.time] = m; });
    const dedup = Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; })
      .map(function (t) { return byTime[t]; });
    markers.length = 0;
    dedup.forEach(function (m) { markers.push(m); });
    t.series.setMarkers(markers);

    clearLines(t.series, t.lines);
    const seenLv = {};
    evs.slice().reverse().forEach(function (e) {
      const key = e.family + '|' + e.level;
      if (seenLv[key]) return;
      if (Object.keys(seenLv).length >= 10) return;
      seenLv[key] = true;
      t.lines.push(t.series.createPriceLine({
        price: e.level,
        color: e.dir === 'up' ? 'rgba(232,168,56,0.55)' : 'rgba(212,120,58,0.55)',
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
        title: e.family,
      }));
    });

    const cross = $('#crossBreak');
    if (cross) {
      cross.innerHTML = '突破事件 <strong>' + evs.length + '</strong> · 图上标记 ' + markers.length;
    }
  }

  function mapRetToPct(v, minR, maxR) {
    if (v == null || Number.isNaN(v)) return 50;
    const span = Math.max(1e-6, maxR - minR);
    return ((v - minR) / span) * 100;
  }

  function renderBreakRail() {
    const bt = DATA.backtest || {};
    const br = bt.breakout || {};
    const def = (bt.definitions && bt.definitions.break_def_zh) || '';
    const breakDef = $('#breakDef');
    if (breakDef) breakDef.textContent = def.trim();
    const win = $('#breakWin');
    if (win) win.textContent = windowLabel(bt.definitions);

    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};
    let minR = 0, maxR = 0;
    [up, dn].forEach(function (side) {
      [1, 3, 5].forEach(function (h) {
        const s = side[h] || {};
        if (s.p25 != null) minR = Math.min(minR, s.p25, s.median || 0);
        if (s.p75 != null) maxR = Math.max(maxR, s.p75, s.median || 0);
      });
    });
    const pad = Math.max(1, (maxR - minR) * 0.08);
    minR -= pad; maxR += pad;

    function hzCard(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      const left = mapRetToPct(s.p25, minR, maxR);
      const right = mapRetToPct(s.p75, minR, maxR);
      const med = mapRetToPct(s.median, minR, maxR);
      const zero = mapRetToPct(0, minR, maxR);
      return '<div class="hz ' + (dir === 'down' ? 'dn' : '') + '">' +
        '<div class="k">' + (dir === 'up' ? '↑' : '↓') + h + 'd</div>' +
        '<div class="med ' + clsRet(s.median) + '">' + pctPts(s.median) + '</div>' +
        '<div class="meta">胜 ' + pct(s.win_rate) + ' · n=' + (s.n || 0) +
          (s.excess_mean != null ? ' · 超额 <span class="' + clsRet(s.excess_mean) + '">' + pctPts(s.excess_mean, 2) + '</span>' : '') + '</div>' +
        '<div class="dist">' +
          '<span class="zero" style="left:' + zero.toFixed(1) + '%"></span>' +
          '<span class="iqr" style="left:' + left.toFixed(1) + '%;width:' +
            Math.max(1, right - left).toFixed(1) + '%"></span>' +
          '<span class="medline" style="left:' + med.toFixed(1) + '%"></span>' +
        '</div></div>';
    }
    $('#breakHorizon').innerHTML = [
      hzCard('up', 1), hzCard('up', 5),
      hzCard('down', 1), hzCard('down', 5),
    ].join('');

    const fam = br.by_family_h5 || {};
    const list = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n > 0; })
      .sort(function (a, b) { return (b.excess_mean || 0) - (a.excess_mean || 0); });
    $('#breakChart').innerHTML = list.map(function (f) {
      const isDn = f.dir === 'down';
      const sig = f.mean_ci != null && Math.abs(f.excess_mean || 0) > f.mean_ci;
      return '<div class="fam"><span class="nm">' + esc(f.family || '') +
        '<span class="tag ' + (isDn ? 'r' : '') + '">' + (isDn ? '↓' : '↑') + '</span>' +
        (sig ? '<span class="tag ok" title="超额超出 95% 误差范围">✓</span>' : '') + '</span>' +
        '<span class="rt ' + clsRet(f.excess_mean) + '" title="+5日超额（减去同期平均）">' + pctPts(f.excess_mean, 2) + '</span>' +
        '<div class="fb ' + (isDn ? 'r' : '') + '"><i style="width:' +
          Math.max(0, Math.min(100, (f.win_rate || 0) * 100)).toFixed(1) + '%"></i></div>' +
        '<span class="n">n=' + f.n + ' 胜' + pct(f.win_rate) + ' ±' + (f.mean_ci != null ? f.mean_ci.toFixed(1) : '—') + '</span></div>';
    }).join('');
  }

  function initBreakChart() {
    const el = $('#chartBreak');
    if (!el || typeof LightweightCharts === 'undefined') return;
    if (tapes.break.inited) {
      ensureChartSized('break');
      refreshBreakMarkers();
      return;
    }
    el.innerHTML = '';
    const ch = LightweightCharts.createChart(el, chartTheme());
    const series = ch.addCandlestickSeries(candleOpts());
    series.setData(candleData());
    tapes.break = { chart: ch, series: series, lines: [], inited: true };
    refreshBreakMarkers();
    ch.timeScale().fitContent();
    bindCrosshair(ch, series, '#crossBreak');
    bindResize(ch, el);
    const fit = $('#btnFitBreak');
    if (fit) fit.onclick = function () { ch.timeScale().fitContent(); };
  }


  /* —— 回测播放 —— */
  function playMs() {
    return ({ 1: 160, 2: 80, 4: 40 })[playState.speed] || 160;
  }

  function stopPlayback() {
    playState.playing = false;
    if (playState.timer) {
      clearInterval(playState.timer);
      playState.timer = null;
    }
    const btn = $('#btnPlayToggle');
    if (btn) {
      btn.classList.remove('on');
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '&#9654;';
    }
  }

  function startPlayback() {
    if (!playState.fullCandles || !playState.fullCandles.length) return;
    if (playState.idx >= playState.fullCandles.length - 1) {
      playState.idx = 0;
    }
    playState.playing = true;
    const btn = $('#btnPlayToggle');
    if (btn) {
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
      btn.innerHTML = '&#9646;&#9646;';
    }
    if (playState.timer) clearInterval(playState.timer);
    playState.timer = setInterval(function () {
      if (playState.idx >= playState.fullCandles.length - 1) {
        stopPlayback();
        return;
      }
      setPlayIndex(playState.idx + 1, false);
    }, playMs());
  }

  function togglePlayback() {
    if (playState.playing) stopPlayback();
    else startPlayback();
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    const a = arr.slice().sort(function (x, y) { return x - y; });
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function rollingHoldStats(uptoDate) {
    const evs = (playState.holdEvents || []).filter(function (e) { return e.date <= uptoDate; });
    let sn = 0, sh = 0, rn = 0, rh = 0;
    evs.forEach(function (e) {
      if (e.side === 'support') { sn++; if (e.held) sh++; }
      else if (e.side === 'resistance') { rn++; if (e.held) rh++; }
    });
    return {
      n: evs.length,
      support: { n: sn, held: sh, hit_rate: sn ? sh / sn : null },
      resistance: { n: rn, held: rh, hit_rate: rn ? rh / rn : null },
      events: evs,
    };
  }

  function rollingBreakStats(uptoDate) {
    const evs = (playState.breakEvents || []).filter(function (e) { return e.date <= uptoDate; });
    const buckets = {
      up1: [], up5: [], dn1: [], dn5: [],
      upN: 0, dnN: 0, upWin5: 0, dnWin5: 0,
    };
    evs.forEach(function (e) {
      const r = e.rets || {};
      if (e.dir === 'up') {
        buckets.upN++;
        if (r['1'] != null) buckets.up1.push(Number(r['1']));
        if (r['5'] != null) {
          buckets.up5.push(Number(r['5']));
          if (Number(r['5']) > 0) buckets.upWin5++;
        }
      } else if (e.dir === 'down') {
        buckets.dnN++;
        if (r['1'] != null) buckets.dn1.push(Number(r['1']));
        if (r['5'] != null) {
          buckets.dn5.push(Number(r['5']));
          if (Number(r['5']) < 0) buckets.dnWin5++;
        }
      }
    });
    return {
      n: evs.length,
      up: {
        n: buckets.upN,
        med1: median(buckets.up1),
        med5: median(buckets.up5),
        win5: buckets.up5.length ? buckets.upWin5 / buckets.up5.length : null,
      },
      down: {
        n: buckets.dnN,
        med1: median(buckets.dn1),
        med5: median(buckets.dn5),
        win5: buckets.dn5.length ? buckets.dnWin5 / buckets.dn5.length : null,
      },
      events: evs,
    };
  }

  function playMarkersAt(uptoDate) {
    const markers = [];
    const byTime = {};

    if (playState.layers.hold) {
      const holdByDate = {};
      (playState.holdEvents || []).forEach(function (e) {
        if (e.date > uptoDate) return;
        const cur = holdByDate[e.date];
        if (!cur || (cur.held && !e.held)) holdByDate[e.date] = e;
      });
      Object.keys(holdByDate).forEach(function (dt) {
        const e = holdByDate[dt];
        const held = !!e.held;
        const isSup = e.side === 'support';
        byTime[toUnix(dt) + '|h'] = {
          time: toUnix(dt),
          position: isSup ? 'belowBar' : 'aboveBar',
          color: held ? '#9fff5c' : '#ffb83a',
          shape: held ? 'circle' : 'square',
          text: (isSup ? '撑' : '压') + (held ? '✓' : '✗'),
        };
      });
    }

    if (playState.layers.break) {
      const seen = {};
      (playState.breakEvents || []).forEach(function (e) {
        if (e.date > uptoDate) return;
        const key = e.date + '|' + e.dir;
        if (seen[key]) return;
        seen[key] = true;
        const up = e.dir === 'up';
        // Prefer break markers over hold on same bar when both fire
        byTime[toUnix(e.date) + '|b'] = {
          time: toUnix(e.date),
          position: up ? 'aboveBar' : 'belowBar',
          color: up ? '#ffd078' : '#ffb83a',
          shape: up ? 'arrowUp' : 'arrowDown',
          text: up ? '↑' : '↓',
        };
      });
    }

    // LWCharts: one marker per time — prefer break over hold
    const final = {};
    Object.keys(byTime).forEach(function (k) {
      const m = byTime[k];
      const prev = final[m.time];
      if (!prev) {
        final[m.time] = m;
        return;
      }
      // arrows beat circles/squares
      if ((m.shape === 'arrowUp' || m.shape === 'arrowDown') &&
          prev.shape !== 'arrowUp' && prev.shape !== 'arrowDown') {
        final[m.time] = m;
      }
    });
    return Object.keys(final).map(Number).sort(function (a, b) { return a - b; })
      .map(function (t) { return final[t]; });
  }

  function renderPlayRail(dateStr) {
    const hold = rollingHoldStats(dateStr);
    const br = rollingBreakStats(dateStr);
    const win = $('#playWin');
    if (win) {
      const first = playState.fullCandles[0] ? new Date(playState.fullCandles[0].time * 1000).toISOString().slice(0, 10) : '';
      win.textContent = first + ' → ' + dateStr;
    }
    $('#playHoldKpi').innerHTML = [
      cell('支撑', pct(hold.support.hit_rate), 'n=' + hold.support.n, barHtml(hold.support.hit_rate, '')),
      cell('压力', pct(hold.resistance.hit_rate), 'n=' + hold.resistance.n, barHtml(hold.resistance.hit_rate, 'res')),
      cell('事件', String(hold.n), '累计'),
    ].join('');
    $('#playBreakKpi').innerHTML = [
      cell('↑+5d', '<span class="' + clsRet(br.up.med5) + '">' + pctPts(br.up.med5) + '</span>',
        '胜 ' + pct(br.up.win5) + ' n=' + br.up.n, barHtml(br.up.win5, '')),
      cell('↓+5d', '<span class="' + clsRet(br.down.med5) + '">' + pctPts(br.down.med5) + '</span>',
        '胜 ' + pct(br.down.win5) + ' n=' + br.down.n, barHtml(br.down.win5, 'res')),
      cell('↑+1d', '<span class="' + clsRet(br.up.med1) + '">' + pctPts(br.up.med1) + '</span>', '中位'),
      cell('↓+1d', '<span class="' + clsRet(br.down.med1) + '">' + pctPts(br.down.med1) + '</span>', '中位'),
    ].join('');

    const dayHold = (playState.holdEvents || []).filter(function (e) { return e.date === dateStr; });
    const dayBrk = (playState.breakEvents || []).filter(function (e) { return e.date === dateStr; });
    const feed = $('#playDayFeed');
    if (!feed) return;
    if (!dayHold.length && !dayBrk.length) {
      feed.innerHTML = '<div class="empty">当日无触及 / 突破事件</div>';
      return;
    }
    const rows = [];
    dayHold.forEach(function (e) {
      rows.push('<div class="ev"><span class="mk ' + (e.held ? 'held' : 'broke') + '">' +
        (e.side === 'support' ? '撑' : '压') + (e.held ? '✓' : '✗') + '</span>' +
        '<span class="nm">' + esc(e.family) + '</span>' +
        '<span class="px">' + Number(e.level).toFixed(1) + '</span></div>');
    });
    dayBrk.forEach(function (e) {
      const up = e.dir === 'up';
      const r5 = e.rets && e.rets['5'];
      rows.push('<div class="ev"><span class="mk ' + (up ? 'up' : 'dn') + '">' +
        (up ? '↑' : '↓') + '</span>' +
        '<span class="nm">' + esc(e.family) +
        (r5 != null ? ' · ' + pctPts(r5) : '') + '</span>' +
        '<span class="px">' + Number(e.level).toFixed(1) + '</span></div>');
    });
    feed.innerHTML = rows.join('');
  }

  function setPlayIndex(idx, fromUser) {
    const t = tapes.playback;
    if (!playState.fullCandles || !playState.fullCandles.length || !t.series) return;
    const max = playState.fullCandles.length - 1;
    idx = Math.max(0, Math.min(max, idx));
    playState.idx = idx;
    const slice = playState.fullCandles.slice(0, idx + 1);
    t.series.setData(slice);
    const dateStr = new Date(playState.fullCandles[idx].time * 1000).toISOString().slice(0, 10);
    t.series.setMarkers(playMarkersAt(dateStr));

    // level lines from events seen so far (recent unique)
    clearLines(t.series, t.lines);
    const seen = {};
    const allEv = []
      .concat((playState.holdEvents || []).filter(function (e) { return e.date <= dateStr; }))
      .concat((playState.breakEvents || []).filter(function (e) { return e.date <= dateStr; }));
    allEv.slice().reverse().forEach(function (e) {
      const key = (e.family || '') + '|' + e.level;
      if (seen[key]) return;
      if (Object.keys(seen).length >= 10) return;
      seen[key] = true;
      const isSup = e.side === 'support' || e.dir === 'down';
      const isUp = e.dir === 'up';
      t.lines.push(t.series.createPriceLine({
        price: e.level,
        color: isUp ? 'rgba(232,168,56,0.5)' :
          (isSup ? 'rgba(143,188,90,0.5)' : 'rgba(212,120,58,0.5)'),
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: false,
        title: e.family || '',
      }));
    });

    const scrub = $('#playScrub');
    if (scrub && Number(scrub.value) !== idx) scrub.value = String(idx);
    if (scrub) {
      const pctFill = max > 0 ? (idx / max) * 100 : 0;
      scrub.style.setProperty('--scrub-pct', pctFill.toFixed(2) + '%');
    }
    const dateEl = $('#playDate');
    if (dateEl) dateEl.textContent = dateStr;
    const prog = $('#playProg');
    if (prog) prog.textContent = (idx + 1) + ' / ' + (max + 1);

    const bar = slice[slice.length - 1];
    const cross = $('#crossPlay');
    if (cross && bar) {
      cross.innerHTML = '<strong>' + dateStr + '</strong>  O ' + bar.open.toFixed(2) +
        '  H ' + bar.high.toFixed(2) + '  L ' + bar.low.toFixed(2) +
        '  C <strong>' + bar.close.toFixed(2) + '</strong>';
    }

    renderPlayRail(dateStr);

    if (fromUser && t.chart) {
      t.chart.timeScale().fitContent();
    }
  }

  function syncPlayLayerButtons() {
    document.querySelectorAll('[data-play-layer]').forEach(function (btn) {
      const k = btn.getAttribute('data-play-layer');
      btn.classList.toggle('on', !!playState.layers[k]);
    });
    document.querySelectorAll('[data-play-speed]').forEach(function (btn) {
      btn.classList.toggle('on', Number(btn.getAttribute('data-play-speed')) === playState.speed);
    });
  }

  function bindPlaybackControls() {
    const toggle = $('#btnPlayToggle');
    if (toggle) toggle.onclick = function () { togglePlayback(); };
    const prev = $('#btnPlayPrev');
    if (prev) prev.onclick = function () {
      stopPlayback();
      setPlayIndex(playState.idx - 1, true);
    };
    const next = $('#btnPlayNext');
    if (next) next.onclick = function () {
      stopPlayback();
      setPlayIndex(playState.idx + 1, true);
    };
    const start = $('#btnPlayStart');
    if (start) start.onclick = function () {
      stopPlayback();
      setPlayIndex(0, true);
    };
    const end = $('#btnPlayEnd');
    if (end) end.onclick = function () {
      stopPlayback();
      setPlayIndex(playState.fullCandles.length - 1, true);
    };
    const scrub = $('#playScrub');
    if (scrub) {
      scrub.addEventListener('input', function () {
        stopPlayback();
        setPlayIndex(Number(scrub.value), true);
      });
    }
    document.querySelectorAll('[data-play-layer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-play-layer');
        playState.layers[k] = !playState.layers[k];
        syncPlayLayerButtons();
        setPlayIndex(playState.idx, false);
      });
    });
    document.querySelectorAll('[data-play-speed]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        playState.speed = Number(btn.getAttribute('data-play-speed')) || 1;
        syncPlayLayerButtons();
        if (playState.playing) {
          stopPlayback();
          startPlayback();
        }
      });
    });
  }

  function initPlaybackChart() {
    const el = $('#chartPlay');
    if (!el || typeof LightweightCharts === 'undefined') return;
    if (!playState.fullCandles) {
      playState.fullCandles = candleData();
      const bt = DATA.backtest || {};
      playState.holdEvents = ((bt.hold || {}).events || []).slice()
        .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      let bev = (bt.breakout || {}).events || [];
      if (!bev.length) {
        bev = [].concat((bt.breakout || {}).examples_up || [], (bt.breakout || {}).examples_down || []);
      }
      playState.breakEvents = bev.slice()
        .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
      const scrub = $('#playScrub');
      if (scrub) {
        scrub.max = String(Math.max(0, playState.fullCandles.length - 1));
        scrub.value = '0';
      }
    }
    if (tapes.playback.inited) {
      ensureChartSized('playback');
      setPlayIndex(playState.idx, true);
      return;
    }
    el.innerHTML = '';
    const ch = LightweightCharts.createChart(el, chartTheme());
    const series = ch.addCandlestickSeries(candleOpts());
    tapes.playback = { chart: ch, series: series, lines: [], inited: true };
    bindCrosshair(ch, series, '#crossPlay');
    bindResize(ch, el);
    const fit = $('#btnFitPlay');
    if (fit) fit.onclick = function () { ch.timeScale().fitContent(); };
    // start near beginning so playback story is clear (first ~20 days visible path)
    const startIdx = Math.min(19, Math.max(0, playState.fullCandles.length - 1));
    setPlayIndex(startIdx, true);
  }


  /* —— 信号 —— */
  const sig = {
    profile: null,
    curves: { constant: true, buy_hold: true },
    chart: null, series: {}, inited: false,
  };

  function model() { return DATA.model || null; }

  function loadPrefs() {
    const m = model();
    let p = null;
    try { p = localStorage.getItem('levels.profile'); } catch (e) { /* */ }
    const keys = ((m && m.profiles) || []).map(function (x) { return x.key; });
    sig.profile = keys.indexOf(p) >= 0 ? p : ((m && m.default_profile) || 'balanced');
  }

  function sizingSource() {
    const m = model();
    if (!m) return null;
    const own = m.sizing && m.sizing[sig.profile];
    if (own) return { s: own, proxy: null };
    const px = m.proxy && m.proxy.sizing && m.proxy.sizing[sig.profile];
    if (px) return { s: px, proxy: m.proxy };
    return null;
  }

  function fmtMoney(x, cur) {
    if (x == null || !isFinite(x)) return '—';
    const sym = ({ USD: '$', KRW: '₩', HKD: 'HK$', CNY: '¥' })[cur] || '';
    return sym + Math.round(x).toLocaleString('en-US');
  }

  function eqPct(v) { return ((v - 1) * 100).toFixed(0) + '%'; }

  function initSignalChart() {
    const el = $('#chartSig');
    if (!el || typeof LightweightCharts === 'undefined') return;
    if (sig.inited) { refreshSignalChart(); return; }
    el.innerHTML = '';
    const theme = chartTheme();
    theme.rightPriceScale = Object.assign({}, theme.rightPriceScale, {
      mode: LightweightCharts.PriceScaleMode.Logarithmic,
      scaleMargins: { top: 0.06, bottom: 0.24 },
    });
    const ch = LightweightCharts.createChart(el, theme);
    const fmt = { type: 'custom', formatter: eqPct, minMove: 0.0001 };
    sig.series.exposure = ch.addHistogramSeries({
      priceScaleId: 'exp', color: 'rgba(255,184,58,0.28)', priceFormat: { type: 'percent' },
      lastValueVisible: false, priceLineVisible: false,
    });
    ch.priceScale('exp').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    sig.series.buy_hold = ch.addLineSeries({ color: 'rgba(111,255,90,0.75)', lineWidth: 1, priceFormat: fmt, priceLineVisible: false });
    sig.series.constant = ch.addLineSeries({ color: 'rgba(243,235,212,0.55)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceFormat: fmt, priceLineVisible: false });
    sig.series.risk_budget = ch.addLineSeries({ color: '#ffd078', lineWidth: 2, priceFormat: fmt });
    sig.chart = ch;
    sig.inited = true;
    ch.subscribeCrosshairMove(function (param) {
      const bar = $('#crossSig');
      if (!bar) return;
      if (!param || !param.time || !param.seriesData) { bar.innerHTML = crossDefault(); return; }
      const g = function (k) { const d = param.seriesData.get(sig.series[k]); return d ? d.value : null; };
      const dateStr = new Date(param.time * 1000).toISOString().slice(0, 10);
      const parts = ['<strong>' + dateStr + '</strong>'];
      if (g('risk_budget') != null) parts.push('模型 <strong>' + eqPct(g('risk_budget')) + '</strong>');
      if (g('constant') != null && sig.curves.constant) parts.push('同仓 ' + eqPct(g('constant')));
      if (g('buy_hold') != null && sig.curves.buy_hold) parts.push('满仓 ' + eqPct(g('buy_hold')));
      if (g('exposure') != null) parts.push('仓位 ' + Math.round(g('exposure')) + '%');
      bar.innerHTML = parts.join('  ');
    });
    bindResize(ch, el);
    const fit = $('#btnFitSig');
    if (fit) fit.onclick = function () { ch.timeScale().fitContent(); };
    refreshSignalChart();
  }

  function crossDefault() {
    const src = sizingSource();
    if (!src) return '资金曲线 · 历史不足，暂无回测';
    return '资金曲线 · 对数坐标 · 自 ' + esc(src.s.start) + (src.proxy ? ' · 母股 ' + esc(src.proxy.symbol) : '') +
      ' · 收盘调仓 · 成本 ' + ((model().validation || {}).cost_bps || 10) + 'bp';
  }

  function refreshSignalChart() {
    if (!sig.chart) return;
    const src = sizingSource();
    const keys = ['risk_budget', 'constant', 'buy_hold'];
    if (!src) {
      keys.concat(['exposure']).forEach(function (k) { sig.series[k].setData([]); });
      $('#crossSig').innerHTML = crossDefault();
      return;
    }
    const c = src.s.curve;
    const times = c.dates.map(toUnix);
    keys.forEach(function (k) {
      const on = k === 'risk_budget' || sig.curves[k];
      sig.series[k].setData(on ? c[k].map(function (v, j) { return { time: times[j], value: v }; }) : []);
    });
    sig.series.exposure.setData(c.exposure.map(function (v, j) { return { time: times[j], value: v * 100 }; }));
    sig.chart.timeScale().fitContent();
    $('#crossSig').innerHTML = crossDefault();
  }

  function renderSigMetrics() {
    const el = $('#sigMetrics');
    const src = sizingSource();
    if (!src) { el.innerHTML = ''; return; }
    const m = src.s.metrics;
    const row = function (lab, x, cls) {
      if (!x) return '';
      return '<tr class="' + (cls || '') + '"><th>' + lab + '</th><td>' + pct(x.cagr, 1) + '</td><td>' + pct(x.vol, 1) +
        '</td><td>' + Number(x.sharpe).toFixed(2) + '</td><td class="neg">' + pct(x.max_dd, 1) + '</td><td>' +
        pct(x.avg_exposure, 0) + '</td></tr>';
    };
    el.innerHTML = '<table class="mt"><thead><tr><th>' + (src.proxy ? '母股 ' + esc(src.proxy.symbol) : '回测 ' + (m.risk_budget.years || '') + ' 年') +
      '</th><th>年化</th><th>波动</th><th>夏普</th><th>最大回撤</th><th>平均仓位</th></tr></thead><tbody>' +
      row('风险预算仓位', m.risk_budget, 'hl') + row('同仓固定', m.constant) + row('满仓持有', m.buy_hold) + '</tbody></table>';
  }

  function sizeOf(card, key) { return ((card.sizes || {})[key] || {}).size; }

  function renderSignalRail() {
    const m = model();
    const rail = $('#view-signal .rail');
    if (!m || !m.card) {
      rail.innerHTML = '<div class="rail-h">今日信号</div><div class="warn">此数据文件不含模型输出（旧版 data.json）。</div>';
      return;
    }
    const card = m.card;
    const cur = DATA.currency || 'USD';
    $('#sigDate').textContent = card.date + ' 收盘后 · 下一交易日执行';

    const warn = [];
    if ((m.history_days || 0) < 252) {
      warn.push('上市仅 ' + m.history_days + ' 个交易日：波动预测与统计样本都不足，仓位只按已有波动估算。' +
        (m.proxy ? '下方附母股 ' + esc(m.proxy.symbol) + ' 的长期参考。' : ''));
    } else if (m.history_days < 504) {
      warn.push('历史约 ' + (m.history_days / 252).toFixed(1) + ' 年，统计区间短，结论稳定性有限。');
    }
    $('#sigWarn').innerHTML = warn.map(function (w) { return '<div class="warn">' + w + '</div>'; }).join('');

    const prof = (m.profiles || []).filter(function (p) { return p.key === sig.profile; })[0] || {};
    const size = sizeOf(card, sig.profile);
    $('#sigSize').innerHTML =
      '<div class="big"><span class="num">' + (size == null ? '—' : Math.round(size * 100) + '%') + '</span>' +
      '<span class="cap">占总资金 · ' + esc(prof.label || '') + '</span></div>' +
      '<div class="kpi-strip three">' + (m.profiles || []).map(function (p) {
        const s = sizeOf(card, p.key);
        return '<button type="button" class="cell pick' + (p.key === sig.profile ? ' on' : '') + '" data-profile="' + p.key + '">' +
          '<div class="lab">' + esc(p.label) + ' ' + Math.round(p.budget * 100) + '%</div>' +
          '<div class="val">' + (s == null ? '—' : Math.round(s * 100) + '%') + '</div></button>';
      }).join('') + '</div>' +
      '<p class="note">仓位 = 波动预算 ÷ 预测波动。当前预测年化波动 <b>' + pct(card.vol_forecast, 1) +
      '</b>；预算 ' + pct(prof.budget, 0) + ' 表示这只股票每年给组合带来约 ' + pct(prof.budget, 0) + ' 的波动。' +
      profileDD(m) + '</p>';

    renderCash(card, size, cur);
    renderTiming(m, card);
    renderRisk(card, cur);
    renderProxy(m);
    renderCheck(m);
    $('#sigDef').textContent = '仅基于历史价格的统计参考，不构成投资建议。模型不预测涨跌方向，只把可承受的风险换算成仓位；请结合基本面与自身情况决策。';

    rail.querySelectorAll('[data-profile]').forEach(function (b) { b.onclick = function () { setProfile(b.getAttribute('data-profile')); }; });
  }

  function profileDD(m) {
    const v = ((m.validation || {}).sizing || {})[sig.profile];
    if (!v) return '';
    return ' 在 ' + v.n_symbols + ' 只同类股票上按此规则回测，单票最大回撤中位 <b class="neg">' + pct(v.max_dd_median, 0) +
      '</b>，最差 <b class="neg">' + pct(v.max_dd_worst, 0) + '</b>（以总资金计）。';
  }

  function renderCash(card, size, cur) {
    let cap = 100000;
    try { cap = Number(localStorage.getItem('levels.capital')) || cap; } catch (e) { /* */ }
    const el = $('#sigCash');
    el.innerHTML = '<label class="cash"><span>总资金</span><input type="number" min="0" step="1000" id="sigCapital" value="' + cap + '" inputmode="numeric" /></label>' +
      '<div class="cash-out" id="sigCashOut"></div>';
    const out = function () {
      const v = Number($('#sigCapital').value) || 0;
      try { localStorage.setItem('levels.capital', String(v)); } catch (e) { /* */ }
      if (size == null) { $('#sigCashOut').textContent = '—'; return; }
      const amt = v * size;
      const sh = Math.floor(amt / card.close);
      $('#sigCashOut').innerHTML = '目标持仓 <b>' + fmtMoney(amt, cur) + '</b> ≈ <b>' + sh.toLocaleString('en-US') + '</b> 股 @ ' +
        card.close.toFixed(2) + '<br><span class="muted">与现有持仓相差不足总资金 5% 时不必调仓。</span>';
    };
    $('#sigCapital').addEventListener('input', out);
    out();
  }

  function timingHtml(t, m, ownCal) {
    if (!t) return '<div class="muted pad">特征不足（需约 70 个交易日）</div>';
    const th = ((m.validation || {}).score_thresholds) || [];
    const posOf = function (s) { return ((Math.max(-1, Math.min(1, s)) + 1) / 2 * 100).toFixed(1); };
    const pooled = (((m.validation || {}).score_calibration || {}).all || []);
    const q = pooled[t.quintile - 1] || {};
    const allN = pooled.reduce(function (a, b) { return a + (b.n || 0); }, 0);
    const allMean = allN ? pooled.reduce(function (a, b) { return a + (b.r10_mean || 0) * (b.n || 0); }, 0) / allN : null;
    const own = ownCal && ownCal.all ? ownCal.all[t.quintile - 1] : null;
    return '<div class="tm"><div class="tm-l q' + t.quintile + '">' + esc(t.label) + '</div>' +
      '<div class="tm-s">分 ' + (t.score >= 0 ? '+' : '') + t.score.toFixed(2) + ' · 第 ' + t.quintile + '/5 档</div></div>' +
      '<div class="gauge">' + th.map(function (x) { return '<i class="tick" style="left:' + posOf(x) + '%"></i>'; }).join('') +
      '<b class="dot" style="left:' + posOf(t.score) + '%"></b></div>' +
      '<div class="gauge-l"><span>偏贵</span><span>有利</span></div>' +
      '<div class="parts">' + (t.parts || []).map(function (p) {
        const w = Math.min(50, Math.abs(p.contrib) * 100);
        return '<div class="part" title="' + esc(p.hint) + '"><span class="nm">' + esc(p.label) + '</span>' +
          '<span class="pb"><i class="' + (p.contrib >= 0 ? 'p' : 'n') + '" style="width:' + w.toFixed(1) + '%"></i></span>' +
          '<span class="v ' + clsRet(p.contrib) + '">' + (p.contrib >= 0 ? '+' : '') + p.contrib.toFixed(2) + '</span></div>';
      }).join('') + '</div>' +
      '<p class="note">历史同档（' + ((m.validation || {}).universe || []).length + ' 只股票合并）：之后 10 日平均 <b class="' + clsRet(q.r10_mean) + '">' +
      pctPts(q.r10_mean, 2) + '</b>，上涨概率 ' + pct(q.win) + '，n=' + (q.n || 0) + '；全部日子平均 ' + pctPts(allMean, 2) + '。' +
      (own && own.n ? ' 本股同档：' + pctPts(own.r10_mean, 2) + '，n=' + own.n + '。' : '') + '</p>';
  }

  function renderTiming(m, card) {
    const v = (m.validation || {}).verdict || {};
    $('#sigTiming').innerHTML = timingHtml(card.timing, m, m.score_calibration) +
      '<p class="note dim">用法：决定好总仓位后，在"有利"档分批买入、"偏贵"档暂缓追高。' +
      (v.tilt_adds_value ? '' : '回测中把它直接叠加到仓位上并没有提高夏普，所以它不改变上面的建议仓位。') + '</p>';
  }

  function renderRisk(card, cur) {
    const r = card.regime || {};
    const rows = [];
    rows.push(['趋势', '<span class="' + (r.trend === 'up' ? 'pos' : (r.trend === 'down' ? 'neg' : 'muted')) + '">' + esc(r.trend_zh || '—') + '</span>' +
      (r.sma50_slope_20d != null ? ' <span class="muted">SMA50 20日 ' + pctPts(r.sma50_slope_20d * 100, 1) + '</span>' : '')]);
    rows.push(['波动', esc(r.vol_zh || '—') + (r.vol_pctile != null ? ' <span class="muted">近1年分位 ' + pct(r.vol_pctile) + '</span>' : '')]);
    if (card.risk_line) {
      const broken = card.risk_line.price > card.close;
      rows.push(['风控线', '<b>' + card.risk_line.price.toFixed(2) + '</b> ' +
        (broken ? '<span class="neg">已跌破</span>' : '<span class="neg">' + pctPts(card.risk_line.dist_pct, 1) + '</span>') +
        '<div class="muted sm">' + esc(card.risk_line.def) + '。' +
        (broken ? '收盘已在线下：近期下跌超出常态波动，先复核持仓逻辑再考虑加仓。' : '收盘跌破 = 波动已超出常态，复核持仓逻辑。') + '</div>']);
    }
    if (card.next_support) {
      rows.push(['下方支撑', '<b>' + card.next_support.price.toFixed(2) + '</b> <span class="neg">' + pctPts(card.next_support.dist_pct, 1) + '</span>' +
        '<div class="muted sm">' + esc(card.next_support.role.split('；')[0]) + '</div>']);
    }
    if (card.next_resistance) {
      rows.push(['上方压力', '<b>' + card.next_resistance.price.toFixed(2) + '</b> <span class="pos">' + pctPts(card.next_resistance.dist_pct, 1) + '</span>' +
        '<div class="muted sm">' + esc(card.next_resistance.role.split('；')[0]) + '</div>']);
    }
    $('#sigRisk').innerHTML = '<dl class="kv">' + rows.map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>';
  }

  function renderProxy(m) {
    const sec = $('#sigProxySec');
    if (!m.proxy) { sec.hidden = true; return; }
    sec.hidden = false;
    const p = m.proxy;
    const c = p.card || {};
    const r = c.regime || {};
    $('#sigProxy').innerHTML = '<p class="note">' + esc(p.name) + '（' + esc(p.symbol) + '，' + (p.history_days / 252).toFixed(0) +
      ' 年历史，' + esc(p.currency) + '）。同一家公司，走势高度相关，可作长期参考。</p>' +
      '<dl class="kv"><dt>趋势</dt><dd>' + esc(r.trend_zh || '—') + '</dd><dt>波动</dt><dd>' + esc(r.vol_zh || '—') + ' · 预测 ' + pct(c.vol_forecast, 0) +
      '</dd><dt>时机</dt><dd>' + esc((c.timing || {}).label || '—') + '</dd><dt>建议仓位</dt><dd>' + (sizeOf(c, sig.profile) == null ? '—' : Math.round(sizeOf(c, sig.profile) * 100) + '%') +
      ' <span class="muted">按母股波动</span></dd></dl>';
  }

  function renderCheck(m) {
    const v = m.validation;
    if (!v) { $('#sigCheck').innerHTML = ''; return; }
    const vd = v.verdict || {};
    const sz = (v.sizing || {})[sig.profile] || {};
    const t = v.tilt || {};
    const rd = v.ridge || {};
    const per = (v.score_calibration || {}).by_period || {};
    const item = function (ok, title, body) {
      return '<div class="chk"><span class="mk ' + (ok ? 'ok' : 'no') + '">' + (ok ? '✓' : '✗') + '</span><div><div class="t">' + title +
        '</div><div class="b">' + body + '</div></div></div>';
    };
    const volOk = sz.realised_vol_median != null && Math.abs(sz.realised_vol_median - sz.budget) < 0.02;
    $('#sigCheck').innerHTML =
      item(volOk, '风险预算仓位：波动可控 · 采用',
        sz.n_symbols + ' 只股票回测，实际波动中位 ' + pct(sz.realised_vol_median, 1) + '（目标 ' + pct(sz.budget, 0) + '）。夏普 ' +
        Number(sz.sharpe_avg).toFixed(2) + '，同仓固定 ' + Number(sz.const_sharpe_avg).toFixed(2) + '：它管风险，不承诺超额收益。') +
      item(vd.score_stable, '时机分：分期方向一致 · 仅作参考',
        '最高档减最低档的 10 日风险调整收益：' + Object.keys(per).map(function (k) {
          return k + ' ' + (per[k].spread_y >= 0 ? '+' : '') + Number(per[k].spread_y).toFixed(2);
        }).join('，') + '。叠加到仓位后夏普 ' + Number(t.tilt_sharpe_avg).toFixed(2) + ' 对 ' + Number(t.base_sharpe_avg).toFixed(2) +
        '，换手 ' + Number(t.tilt_turnover_avg).toFixed(1) + '× 对 ' + Number(t.base_turnover_avg).toFixed(1) + '×/年。') +
      item(vd.ridge_useful, '11 因子回归择时：' + (vd.ridge_useful ? '有效' : '无效 · 未采用'),
        '滚动样本外 IC ' + (rd.oos_ic != null ? rd.oos_ic.toFixed(3) : '—') + '（' + Object.keys(rd.ic_by_period || {}).map(function (k) {
          return k + ' ' + rd.ic_by_period[k].toFixed(3);
        }).join('，') + '）。趋势、动量类因子在不同时期方向翻转。') +
      '<p class="note dim">股票池 ' + (v.universe || []).length + ' 只半导体 / AI 基建股及 SMH、QQQ；单边成本 ' + v.cost_bps +
      'bp；收盘价调仓假设。每个交易日随数据刷新重算。</p>';
  }

  function setProfile(key) {
    sig.profile = key;
    try { localStorage.setItem('levels.profile', key); } catch (e) { /* */ }
    syncSignalButtons();
    renderSignalRail();
    renderSigMetrics();
    refreshSignalChart();
  }

  function syncSignalButtons() {
    document.querySelectorAll('#view-signal .tool [data-profile]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-profile') === sig.profile);
    });
    document.querySelectorAll('[data-curve]').forEach(function (btn) {
      btn.classList.toggle('on', !!sig.curves[btn.getAttribute('data-curve')]);
    });
  }

  function bindSignalControls() {
    document.querySelectorAll('#view-signal .tool [data-profile]').forEach(function (btn) {
      btn.addEventListener('click', function () { setProfile(btn.getAttribute('data-profile')); });
    });
    document.querySelectorAll('[data-curve]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-curve');
        sig.curves[k] = !sig.curves[k];
        syncSignalButtons();
        refreshSignalChart();
      });
    });
  }

  /* —— filters / views —— */
  function syncPresetButtons() {
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-preset') === filters.preset);
    });
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      const k = btn.getAttribute('data-kind');
      btn.classList.toggle('on', !!filters.kinds[k]);
    });
    const vbtn = $('#btnVrvp');
    if (vbtn) vbtn.classList.toggle('on', !!filters.vrvp);

    document.querySelectorAll('[data-lv-preset]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-lv-preset') === lvFilters.preset);
    });
    document.querySelectorAll('[data-lv-kind]').forEach(function (btn) {
      const k = btn.getAttribute('data-lv-kind');
      btn.classList.toggle('on', !!lvFilters.kinds[k]);
    });

    document.querySelectorAll('[data-hold-side]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-hold-side') === holdFilters.side);
    });
    document.querySelectorAll('[data-hold-out]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-hold-out') === holdFilters.out);
    });
    document.querySelectorAll('[data-brk-dir]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-brk-dir') === brkFilters.dir);
    });
  }

  function bindFilters() {
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filters.preset = btn.getAttribute('data-preset');
        syncPresetButtons();
        applyPriceLines();
      });
    });
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-kind');
        filters.kinds[k] = !filters.kinds[k];
        syncPresetButtons();
        applyPriceLines();
      });
    });
    const vbtn = $('#btnVrvp');
    if (vbtn) {
      vbtn.addEventListener('click', function () {
        filters.vrvp = !filters.vrvp;
        syncPresetButtons();
        applyPriceLines();
        scheduleOverlay();
      });
    }
    const fit = $('#btnFit');
    if (fit) {
      fit.addEventListener('click', function () {
        if (chart) chart.timeScale().fitContent();
        scheduleOverlay();
      });
    }

    document.querySelectorAll('[data-lv-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        lvFilters.preset = btn.getAttribute('data-lv-preset');
        syncPresetButtons();
        refreshLevelsChart();
      });
    });
    document.querySelectorAll('[data-lv-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-lv-kind');
        lvFilters.kinds[k] = !lvFilters.kinds[k];
        syncPresetButtons();
        refreshLevelsChart();
      });
    });

    document.querySelectorAll('[data-hold-side]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        holdFilters.side = btn.getAttribute('data-hold-side');
        syncPresetButtons();
        refreshHoldMarkers();
      });
    });
    document.querySelectorAll('[data-hold-out]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        holdFilters.out = btn.getAttribute('data-hold-out');
        syncPresetButtons();
        refreshHoldMarkers();
      });
    });
    document.querySelectorAll('[data-brk-dir]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        brkFilters.dir = btn.getAttribute('data-brk-dir');
        syncPresetButtons();
        refreshBreakMarkers();
      });
    });
  }

  function switchView(id) {
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-view') === id);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      const on = v.id === 'view-' + id;
      v.classList.toggle('on', on);
      if (on) v.removeAttribute('hidden');
      else v.setAttribute('hidden', '');
    });
    const stamp = document.querySelector('.stamp');
    if (stamp) {
      stamp.textContent = ({ signal: '信号', observe: '观察', levels: '点位', hold: '触及', break: '突破', playback: '回测' })[id] || id;
    }
    if (history.replaceState) history.replaceState(null, '', location.search + '#' + id);
    if (id !== 'playback') stopPlayback();
    if (id === 'signal') {
      initSignalChart();
      requestAnimationFrame(function () { ensureChartSized('signal'); });
    } else if (id === 'observe') {
      if (!chart) buildChart();
      requestAnimationFrame(function () { ensureChartSized(); });
    } else if (id === 'levels') {
      initLevelsChart();
      requestAnimationFrame(function () { ensureChartSized('levels'); });
    } else if (id === 'hold') {
      initHoldChart();
      requestAnimationFrame(function () { ensureChartSized('hold'); });
    } else if (id === 'break') {
      initBreakChart();
      requestAnimationFrame(function () { ensureChartSized('break'); });
    } else if (id === 'playback') {
      initPlaybackChart();
      requestAnimationFrame(function () { ensureChartSized('playback'); });
    }
  }

  function bindViews() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchView(tab.getAttribute('data-view'));
      });
    });
  }

  async function main() {
    try {
      DATA = await loadData();
    } catch (e) {
      $('#app').innerHTML = '<div style="padding:20px;font-family:IBM Plex Mono,SF Mono,Menlo,monospace;background:#1e2118;color:#e6dcc4">无法加载 data.json：' + esc(e.message) + '</div>';
      return;
    }
    profileCache = null;
    renderHeader();
    loadPrefs();
    renderSignalRail();
    renderSigMetrics();
    renderObsAccuracy();
    renderLevelsLadder();
    renderHoldRail();
    renderBreakRail();
    syncPresetButtons();
    syncPlayLayerButtons();
    syncSignalButtons();
    bindFilters();
    bindPlaybackControls();
    bindSignalControls();
    bindViews();
    const hash = (location.hash || '').replace('#', '');
    const start = VIEWS.indexOf(hash) >= 0 ? hash : (model() ? 'signal' : 'observe');
    switchView(start);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
