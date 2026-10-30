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
  function PRI_LABEL(p) {
    return ({ 0: '现价', 1: '高优', 2: '中', 3: '低' })[p] || String(p);
  }

  async function loadData() {
    try {
      const res = await fetch('./data.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (window.__AVGO_FALLBACK__) {
        console.warn('data.json fetch failed, using fallback', e);
        return window.__AVGO_FALLBACK__;
      }
      throw e;
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
        fontSize: 11,
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
      const on = btn.getAttribute('data-symbol') === sym;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    const pack = key ? tapes[key] : null;
    const ch = pack ? pack.chart : chart;
    const el = $(key === 'levels' ? '#chartLevels' : key === 'hold' ? '#chartHold' : key === 'break' ? '#chartBreak' : key === 'playback' ? '#chartPlay' : '#chart');
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
    if (winEl) {
      winEl.textContent = (defs.window || '') + (defs.n_bars ? ' · ' + defs.n_bars + 'K' : '');
    }
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#obsHoldKpi').innerHTML = [
      cell('支撑', pct(os.hit_rate), 'n=' + (os.n || 0), barHtml(os.hit_rate, '')),
      cell('压力', pct(or_.hit_rate), 'n=' + (or_.n || 0), barHtml(or_.hit_rate, 'res')),
    ].join('');
    const fam = hold.by_family || {};
    const ranked = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n >= 3; })
      .sort(function (a, b) { return (b.hit_rate || 0) - (a.hit_rate || 0); })
      .slice(0, 6);
    if (!ranked.length) {
      $('#obsTopFamilies').innerHTML = '<div class="muted" style="padding:4px 12px;font-size:11px">—</div>';
    } else {
      $('#obsTopFamilies').innerHTML = ranked.map(function (f) {
        const isR = f.side === 'resistance';
        const w = Math.max(0, Math.min(100, (f.hit_rate || 0) * 100));
        return '<div class="fam"><span class="nm">' + esc(f.family || '') +
          '<span class="tag ' + (isR ? 'r' : '') + '">' + (isR ? '压' : '撑') + '</span></span>' +
          '<span class="rt">' + pct(f.hit_rate) + '</span>' +
          '<div class="fb ' + (isR ? 'r' : '') + '"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
          '<span class="n">n=' + f.n + '</span></div>';
      }).join('');
    }
    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};
    function bcell(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      return cell(
        (dir === 'up' ? '↑' : '↓') + h + 'd',
        '<span class="' + clsRet(s.median) + '">' + pctPts(s.median) + '</span>',
        '胜 ' + pct(s.win_rate) + ' n=' + (s.n || 0),
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
    if (win) win.textContent = (bt.definitions && bt.definitions.window) || '';
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#holdKpi').innerHTML = [
      cell('支撑', pct(os.hit_rate), 'n=' + (os.n || 0), barHtml(os.hit_rate, '')),
      cell('压力', pct(or_.hit_rate), 'n=' + (or_.n || 0), barHtml(or_.hit_rate, 'res')),
      cell('事件', String(hold.n_events || 0), '冷却10K'),
    ].join('');
    const fam = hold.by_family || {};
    const list = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n > 0; })
      .sort(function (a, b) { return (b.hit_rate || 0) - (a.hit_rate || 0); });
    $('#holdChart').innerHTML = list.map(function (f) {
      const isR = f.side === 'resistance';
      const w = Math.max(0, Math.min(100, (f.hit_rate || 0) * 100));
      return '<div class="fam"><span class="nm">' + esc(f.family || '') +
        '<span class="tag ' + (isR ? 'r' : '') + '">' + (isR ? '压' : '撑') + '</span></span>' +
        '<span class="rt">' + pct(f.hit_rate) + '</span>' +
        '<div class="fb ' + (isR ? 'r' : '') + '"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<span class="n">n=' + f.n + '</span></div>';
    }).join('');
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
    if (win) win.textContent = (bt.definitions && bt.definitions.window) || '';

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
        '<div class="meta">胜 ' + pct(s.win_rate) + ' · n=' + (s.n || 0) + '</div>' +
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
      .sort(function (a, b) { return (b.median || 0) - (a.median || 0); });
    $('#breakChart').innerHTML = list.map(function (f) {
      const isDn = f.dir === 'down';
      return '<div class="fam"><span class="nm">' + esc(f.family || '') +
        '<span class="tag ' + (isDn ? 'r' : '') + '">' + (isDn ? '↓' : '↑') + '</span></span>' +
        '<span class="rt ' + clsRet(f.median) + '">' + pctPts(f.median) + '</span>' +
        '<div class="fb ' + (isDn ? 'r' : '') + '"><i style="width:' +
          Math.max(0, Math.min(100, (f.win_rate || 0) * 100)).toFixed(1) + '%"></i></div>' +
        '<span class="n">n=' + f.n + ' 胜' + pct(f.win_rate) + '</span></div>';
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
      stamp.textContent = ({ observe: '观察', levels: '点位', hold: '触及', break: '突破', playback: '回测' })[id] || id;
    }
    if (id !== 'playback') stopPlayback();
    if (id === 'observe') {
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
    buildChart();
    renderObsAccuracy();
    renderLevelsLadder();
    renderHoldRail();
    renderBreakRail();
    syncPresetButtons();
    syncPlayLayerButtons();
    bindFilters();
    bindPlaybackControls();
    bindViews();
    switchView('observe');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
