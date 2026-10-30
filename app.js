/* Levels — cassette tape · multi-ticker ready (AVGO first) · K-line on every tab */
(function () {
  'use strict';

  const KIND_LABEL = { resistance: '压力', support: '支撑', anchor: '锚点' };
  const KIND_CLASS = { resistance: 'kind-res', support: 'kind-sup', anchor: 'kind-anc' };

  const filters = { vrvp: true };
  const lvFilters = {
    kinds: { resistance: true, support: true, anchor: true },
    preset: 'priority',
  };
  const holdFilters = { side: 'all', out: 'all' };
  const brkFilters = { dir: 'all' };

  let DATA = null;
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
    return yrs + (defs.n_bars ? ' · ' + defs.n_bars + 'K' : '') + (defs.display_from ? ' · 图上' + winLabel() : '');
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

  function candleData(n) {
    if (DATA.ohlcv && DATA.ohlcv.length) {
      return (n ? DATA.ohlcv.slice(-n) : DATA.ohlcv).map(function (b) {
        return { time: toUnix(b.date), open: b.open, high: b.high, low: b.low, close: b.close };
      });
    }
    if (DATA.price_series && DATA.price_series.length) {
      return (n ? DATA.price_series.slice(-n) : DATA.price_series).map(function (b) {
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
      });
      linesArr.push(pl);
    });
    if (withVrvp && DATA.state && DATA.state.vrvp) {
      const v = DATA.state.vrvp;
      [
        { price: v.poc, color: 'rgba(232,168,56,0.95)', w: 2, style: LightweightCharts.LineStyle.Solid },
        { price: v.vah, color: 'rgba(230,220,196,0.45)', w: 1, style: LightweightCharts.LineStyle.Dashed },
        { price: v.val, color: 'rgba(230,220,196,0.45)', w: 1, style: LightweightCharts.LineStyle.Dashed },
      ].forEach(function (cfg) {
        if (cfg.price == null) return;
        linesArr.push(series.createPriceLine({
          price: cfg.price, color: cfg.color, lineWidth: cfg.w,
          lineStyle: cfg.style, axisLabelVisible: true,
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

  /* —— 观察：近 1/2/3 月窗口 · 模型判断的关键位 + 可选参考线 —— */
  const obs = { win: '3m', hot: null, hotZone: null, ref: false };
  let obsLines = [];
  const AUTOSCALE_PCT = 12;
  const GROUP_STYLE = {
    ma: { style: 0, w: 1, zh: '均线', dash: '' },
    boll: { style: 2, w: 1, zh: '布林', dash: '5 3' },
    range: { style: 3, w: 1, zh: '区间高低', dash: '9 4' },
    vrvp: { style: 0, w: 1, zh: '成交剖面', dash: '' },
    swing: { style: 1, w: 1, zh: '前高/前低', dash: '1.5 2.5' },
    gap: { style: 4, w: 1, zh: '缺口', dash: '1.5 5' },
  };
  const KEY_W = { high: 3, mid: 2, low: 1 };

  function obsData() { return DATA.observe || null; }
  function obsWin() {
    const o = obsData();
    return o ? o.by_window[obs.win] || null : null;
  }
  function obsKey() { const w = obsWin(); return w ? w.key : null; }
  function winFrom() { const w = obsWin(); return w ? w.from : ''; }
  function winLabel() { const w = obsWin(); return w ? w.label : '近1年'; }
  function loadWinPref() {
    const o = obsData();
    if (!o) return;
    let saved = null, ref = null;
    try { saved = localStorage.getItem('levels.window'); ref = localStorage.getItem('levels.ref'); } catch (e) { /* */ }
    obs.win = saved && o.by_window[saved] ? saved : o.default;
    obs.ref = ref === '1';
  }

  function kindRgb(kind) { return kind === 'resistance' ? '255,184,58' : '159,212,95'; }
  function swatch(group, kind, w) {
    const st = group === 'key' ? { w: w || 2, dash: '' } : (GROUP_STYLE[group] || GROUP_STYLE.range);
    const col = kind === 'resistance' ? '#ffb83a' : (kind === 'support' ? '#9fd45f' : '#c9bfa4');
    return '<svg class="sw" width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke="' + col +
      '" stroke-width="' + (st.w + 0.5) + '"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/></svg>';
  }
  function winRange(w) {
    const bars = (DATA.ohlcv || []).slice(-w.bars);
    let lo = Infinity, hi = -Infinity;
    bars.forEach(function (b) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; });
    return [lo, hi];
  }
  function inChart(ln, rg) {
    return Math.abs(ln.dist_pct) <= AUTOSCALE_PCT || (ln.price >= rg[0] && ln.price <= rg[1]);
  }
  function keyName(k, lv) {
    const lvls = k.levels;
    const same = lvls.filter(function (x) { return x.kind === lv.kind; })
      .sort(function (a, b) { return lv.kind === 'resistance' ? a.price - b.price : b.price - a.price; });
    return (lv.kind === 'resistance' ? '关键压力 R' : '关键支撑 S') + (same.indexOf(lv) + 1);
  }

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
    const win = obsWin();
    if (!win) return;
    const plotW = chart.timeScale().width() || w;
    const yOf = function (p) {
      try { return candleSeries.priceToCoordinate(p); } catch (e) { return null; }
    };
    function band(lo, hi, fill, stroke) {
      const y1 = yOf(hi), y2 = yOf(lo);
      if (y1 == null || y2 == null) return;
      ctx.fillStyle = fill;
      ctx.fillRect(0, Math.min(y1, y2), plotW, Math.max(1, Math.abs(y2 - y1)));
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, Math.min(y1, y2) + 0.5, plotW - 1, Math.abs(y2 - y1));
      }
    }
    if (filters.vrvp && win.profile) {
      const prof = win.profile;
      if (prof.val != null && prof.vah != null) band(prof.val, prof.vah, 'rgba(232,168,56,0.045)', null);
      const profileW = Math.min(96, Math.max(56, w * 0.14));
      const x0 = plotW - profileW - 2;
      for (let i = 0; i < prof.vol.length; i++) {
        const pLo = prof.lo + i * prof.step;
        const pHi = pLo + prof.step;
        const ya = yOf(pHi), yb = yOf(pLo);
        if (ya == null || yb == null) continue;
        const bw = prof.vol[i] / 1000 * (profileW - 4);
        const inVA = pLo >= prof.val - 1e-9 && pHi <= prof.vah + 1e-9;
        ctx.fillStyle = inVA ? 'rgba(232,168,56,0.36)' : 'rgba(154,144,120,0.22)';
        ctx.fillRect(x0 + (profileW - 4 - bw), Math.min(ya, yb), bw, Math.max(1, Math.abs(yb - ya) - 1));
      }
    }
    const k = win.key;
    if (k) {
      k.zones.forEach(function (z, j) {
        if (obs.hotZone === 'k' + j) band(z.lo, z.hi, 'rgba(255,208,120,0.12)', 'rgba(255,208,120,0.55)');
        else if (z.current) band(z.lo, z.hi, 'rgba(243,235,212,0.04)', null);
      });
      k.levels.forEach(function (lv, i) {
        const a = obs.hot === 'k' + i ? 0.3 : (lv.salience === 'high' ? 0.2 : 0.12);
        band(lv.lo, lv.hi, 'rgba(' + kindRgb(lv.kind) + ',' + a + ')', null);
      });
    }
  }

  function lineSpec(e, hot) {
    if (e.key) {
      return { color: 'rgba(' + kindRgb(e.kind) + ',' + (hot ? 1 : 0.92) + ')', lineWidth: (KEY_W[e.strength] || 2) + (hot ? 1 : 0) };
    }
    const st = GROUP_STYLE[e.group] || GROUP_STYLE.range;
    return { color: 'rgba(' + kindRgb(e.kind) + ',' + (hot ? 0.95 : 0.42) + ')', lineWidth: st.w + (hot ? 1 : 0) };
  }

  function applyObsLines() {
    obsLines.forEach(function (e) { try { candleSeries.removePriceLine(e.handle); } catch (err) { /* */ } });
    obsLines = [];
    const w = obsWin();
    if (!w || !candleSeries) return;
    const add = function (e, style) {
      const sp = lineSpec(e, e.id === obs.hot);
      e.handle = candleSeries.createPriceLine({
        price: e.price, color: sp.color, lineWidth: sp.lineWidth, lineStyle: style, axisLabelVisible: e.key || obs.ref,
      });
      obsLines.push(e);
    };
    if (obs.ref) {
      w.lines.forEach(function (ln, i) {
        add({ id: 'r' + i, price: ln.price, kind: ln.kind, group: ln.group, key: false }, (GROUP_STYLE[ln.group] || GROUP_STYLE.range).style);
      });
    }
    if (w.key) {
      w.key.levels.forEach(function (lv, i) {
        add({ id: 'k' + i, price: lv.price, kind: lv.kind, strength: lv.salience, key: true }, LightweightCharts.LineStyle.Solid);
      });
    }
  }

  function footHint() {
    const el = $('#levelLegend');
    if (!el) return;
    const w = obsWin();
    if (!w) { el.innerHTML = ''; return; }
    const o = obsData();
    const id = obs.hot;
    if (id && id[0] === 'k' && w.key) {
      const lv = w.key.levels[Number(id.slice(1))];
      el.innerHTML = swatch('key', lv.kind, KEY_W[lv.salience]) + '<b>' + keyName(w.key, lv) + '</b> <span class="px">' +
        lv.price.toFixed(2) + '</span> <span class="' + (lv.kind === 'resistance' ? 'kind-res' : 'kind-sup') + '">' +
        pctPts(lv.dist_pct, 1) + '</span> · 10 日内碰到 ' + pct(lv.reach) + ' · 碰到后' + (lv.kind === 'resistance' ? '回落' : '反弹') +
        ' ' + pct(lv.react) + ' · ' + esc(lv.why[0] || '');
      return;
    }
    if (id && id[0] === 'r') {
      const ln = w.lines[Number(id.slice(1))];
      const d = (o.defs || {})[ln.members[0].key] || {};
      el.innerHTML = swatch(ln.group, ln.kind) + '<b>' + esc(ln.members.map(function (m) { return m.name; }).join(' + ')) +
        '</b> <span class="px">' + ln.price.toFixed(2) + '</span> · ' + esc(d.what || '');
      return;
    }
    if (obs.hotZone && w.key) {
      const z = w.key.zones[Number(obs.hotZone.slice(1))];
      const tags = o.zone_tags || {};
      el.innerHTML = '区间 <span class="px">' + z.lo.toFixed(2) + '–' + z.hi.toFixed(2) + '</span> · ' +
        (z.tags || []).map(function (t) { return esc((tags[t] || {}).label || t); }).join(' · ') + ' · 宽 ' + z.width_pct.toFixed(1) + '%';
      return;
    }
    el.innerHTML = '<span class="muted">实线 = 模型从价格结构里找出的关键位，色带 = ±0.3 ATR 反应区；鼠标移上去看依据和概率</span>';
  }

  function setHot(line, zone) {
    if (line === obs.hot && zone === obs.hotZone) return;
    const prev = obs.hot;
    obs.hot = line;
    obs.hotZone = zone;
    obsLines.forEach(function (e) {
      if (e.id !== prev && e.id !== line) return;
      e.handle.applyOptions(lineSpec(e, e.id === line));
    });
    const list = $('#guideList');
    if (list) {
      list.querySelectorAll('.hot').forEach(function (el) { el.classList.remove('hot'); });
      if (line) { const el = list.querySelector('[data-li="' + line + '"]'); if (el) el.classList.add('hot'); }
      if (zone) { const el = list.querySelector('[data-zi="' + zone + '"]'); if (el) el.classList.add('hot'); }
    }
    footHint();
    scheduleOverlay();
  }

  function statHtml(m, tr) {
    const s = m.stat;
    if (!s || !s.pool || s.pool.rate == null) return '';
    const p = s.pool, base = s.base;
    let vd = '', cls = '';
    if (base != null && p.ci_lo != null) {
      if (p.ci_lo > base) { vd = '比随机线可靠'; cls = 'ok'; }
      else if (p.ci_hi < base) { vd = '不如随机线'; cls = 'bad'; }
      else { vd = '和随机线差不多'; cls = 'meh'; }
    }
    return '<div class="gl-s"><span class="k">回测</span>碰到后 5 日内' + (s.side === 'support' ? '撑住' : '压住') +
      ' <b>' + pct(p.rate) + '</b> <span class="muted">' + tr.n_symbols + '只×' + tr.years + '年 n=' + p.n +
      ' · 随机线 ' + pct(base) + '</span>' + (vd ? ' <span class="vd ' + cls + '">' + vd + '</span>' : '') + '</div>';
  }

  function refCard(ln, i, o, rg) {
    const defs = o.defs || {};
    const ms = ln.members;
    const k = ln.kind === 'resistance' ? 'res' : 'sup';
    const names = ms.map(function (m) { return esc(m.name); }).join('<i class="plus">＋</i>');
    const body = ms.map(function (m) {
      const d = defs[m.key] || {};
      return '<div class="gl-w">' + (ms.length > 1 ? '<b>' + esc(m.name) + '</b>：' : '') + esc(d.what) + '</div>';
    }).join('') + '<div class="gl-u"><span class="k">怎么看</span>' + esc((defs[ms[0].key] || {}).use) + '</div>';
    return '<div class="gl ref ' + k + '" data-li="r' + i + '">' +
      '<div class="gl-h">' + swatch(ln.group, ln.kind) + '<b class="px">' + ln.price.toFixed(2) + '</b>' +
      '<span class="nm">' + names + '</span><span class="d ' + (k === 'res' ? 'kind-res' : 'kind-sup') + '">' +
      pctPts(ln.dist_pct, 1) + '</span></div>' +
      (inChart(ln, rg) ? '' : '<div class="gl-off">在图外</div>') +
      body + ms.map(function (m) { return statHtml(m, o.training); }).join('') + '</div>';
  }

  function probBar(p, cls, base) {
    const w = Math.max(0, Math.min(100, (p || 0) * 100));
    return '<div class="fb ' + (cls || '') + '"><i style="width:' + w.toFixed(1) + '%"></i>' +
      (base != null ? '<b class="base" style="left:' + (base * 100).toFixed(1) + '%"></b>' : '') + '</div>';
  }

  function keyCard(k, lv, i, rg, km) {
    const c = lv.kind === 'resistance' ? 'res' : 'sup';
    const verb = lv.kind === 'resistance' ? '先回落' : '先反弹';
    return '<div class="gl key ' + c + ' sl-' + lv.salience + '" data-li="k' + i + '">' +
      '<div class="gl-h">' + swatch('key', lv.kind, KEY_W[lv.salience]) + '<b class="px">' + lv.price.toFixed(2) + '</b>' +
      '<span class="nm">' + keyName(k, lv) + '</span><span class="stg" title="结构分 ' + lv.score.toFixed(1) +
      '：转折次数、大级别转折、窗口极值等加起来">显著度 ' + lv.salience_zh + '</span>' +
      '<span class="d ' + (c === 'res' ? 'kind-res' : 'kind-sup') + '">' + pctPts(lv.dist_pct, 1) + ' · ' +
      Math.abs(lv.atr_dist).toFixed(1) + ' ATR</span></div>' +
      (inChart(lv, rg) ? '' : '<div class="gl-off">在图外：离现价太远</div>') +
      '<ul class="why">' + lv.why.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '<div class="gl-p two"><div><span>' + km.reach_days + ' 日内碰到 <b>' + pct(lv.reach) + '</b></span>' + probBar(lv.reach, c === 'res' ? 'r' : '') + '</div>' +
      '<div><span>碰到后' + verb + ' ' + km.win_atr + ' ATR <b>' + pct(lv.react) + '</b></span>' + probBar(lv.react, c === 'res' ? 'r' : '', 0.5) + '</div></div>' +
      '</div>';
  }

  function zoneCard(z, j, o, w, k) {
    const zt = o.zone_tags || {};
    const tags = (z.tags || []).map(function (t) {
      const d = zt[t] || {};
      let lab = d.label || t;
      if ((t === 'dense' || t === 'thin') && z.density != null) lab += ' ' + z.density.toFixed(1) + '×';
      return '<span class="tg ' + t + '" title="' + esc(d.text) + '">' + esc(lab) + '</span>';
    }).join('');
    const head = '<div class="gz-h"><span class="gz-w">↕ ' + z.width_pct.toFixed(1) + '%' +
      (z.atr_w != null ? ' · ' + z.atr_w.toFixed(1) + ' ATR' : '') + '</span>' + tags +
      '<span class="gz-d" title="窗口内收盘落在这个区间的天数">停留 ' + z.days_in + ' 天</span></div>';
    if (!z.current) return '<div class="gz" data-zi="k' + j + '">' + head + '</div>';
    const up = k.levels[j], dn = k.levels[j + 1];
    const text = (z.tags || []).map(function (t) { return esc((zt[t] || {}).text || ''); }).join('');
    return '<div class="gz cur" data-zi="k' + j + '">' + head +
      '<div class="gz-now">▶ 现价 <b>' + w.close.toFixed(2) + '</b> 在 ' + keyName(k, dn) + ' 和 ' + keyName(k, up) + ' 之间</div>' +
      '<div class="gz-t">' + text + '</div></div>';
  }

  function judgeHtml(k, w, o) {
    const s = k.summary || {};
    const find = function (p) { return k.levels.filter(function (x) { return x.price === p; })[0]; };
    const R1 = find(s.r1), S1 = find(s.s1), R2 = find(s.r2), S2 = find(s.s2);
    const nm = function (lv) { return lv ? keyName(k, lv) + ' <b>' + lv.price.toFixed(2) + '</b>' : ''; };
    const items = [];
    if (R1 && S1) {
      items.push('现价 <b>' + w.close.toFixed(2) + '</b> 夹在 ' + nm(S1) + '（' + pctPts(S1.dist_pct, 1) + '）和 ' + nm(R1) +
        '（' + pctPts(R1.dist_pct, 1) + '）之间。' + (s.room_ratio != null ? (s.room_ratio < 0.8 ? '离压力更近：向上空间只有向下的 ' + s.room_ratio.toFixed(1) + ' 倍。' :
        (s.room_ratio > 1.25 ? '离支撑更近：向上空间是向下的 ' + s.room_ratio.toFixed(1) + ' 倍。' : '上下空间差不多。')) : ''));
    } else if (S1) {
      items.push('上方' + esc(w.label) + '内没有结构上的压力，最近的关键支撑是 ' + nm(S1) + '。');
    } else if (R1) {
      items.push('下方' + esc(w.label) + '内没有结构上的支撑，最近的关键压力是 ' + nm(R1) + '。');
    }
    if (s.first_touch) {
      const f = s.first_touch;
      items.push('接下来 ' + f.days + ' 个交易日，历史同类情形先碰到上方 <b class="kind-res">' + pct(f.up) + '</b>、先碰到下方 <b class="kind-sup">' +
        pct(f.down) + '</b>、都没碰到 ' + pct(f.none) + '。');
    }
    if (S1) {
      items.push('<span class="k sup">回落</span>到 ' + nm(S1) + '：10 日内到这里的概率 ' + pct(S1.reach) + '，到了之后先反弹 1 ATR 的概率 ' +
        pct(S1.react) + '。收盘跌破 <b>' + s.s1_break.toFixed(2) + '</b> 算这条支撑失效' +
        (S2 ? '，下一个看 ' + nm(S2) + '。' : '，' + esc(w.label) + '内下方没有更多关键支撑。'));
    }
    if (R1) {
      items.push('<span class="k res">上涨</span>到 ' + nm(R1) + '：10 日内到这里的概率 ' + pct(R1.reach) + '，到了之后先回落 1 ATR 的概率 ' +
        pct(R1.react) + '。收盘站上 <b>' + s.r1_break.toFixed(2) + '</b> 算突破' +
        (R2 ? '，下一个看 ' + nm(R2) + '。' : '，' + esc(w.label) + '内上方没有更多关键压力。'));
    }
    return '<div class="jd"><div class="jd-h">模型判断 · ' + esc(w.label) + '</div><ul>' +
      items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>';
  }

  function checkHtml(km) {
    if (!km || !km.oos) return '';
    const o = km.oos;
    const e = o.edge || {};
    const pp = function (x) {
      if (!x || x.edge == null) return '—';
      return (x.edge >= 0 ? '+' : '') + (x.edge * 100).toFixed(1) + ' ± ' + (x.ci * 100).toFixed(1);
    };
    const row = function (lab, k, cls) {
      return '<tr class="' + (cls || '') + '"><td>' + lab + '</td><td>' + pp((e[k] || {}).support) + '</td><td>' + pp((e[k] || {}).resistance) + '</td></tr>';
    };
    const dec = o.reach_deciles || [];
    const cal = dec.length ? dec.filter(function (_, i) { return i % 3 === 1; }).map(function (d) {
      return '预测 ' + pct(d[0]) + ' → 实际 ' + pct(d[1]);
    }).join('，') : '';
    return '<div class="mc"><div class="sec-l">模型体检 · 样本外（' + esc(o.split.slice(0, 4)) + ' 年以后，训练时没见过）</div>' +
      '<div class="note"><b>「10 日内碰到」</b>的概率是准的：' + cal + '（AUC ' + (o.reach_auc || 0).toFixed(2) + '）。</div>' +
      '<div class="note"><b>「碰到后先反向」</b>只能靠距离和趋势粗略区分（AUC ' + (o.react_auc || 0).toFixed(2) + '）。' +
      '价位本身多给的有效率（百分点，实际 − 同距离同趋势的预期，±95% 区间）：</div>' +
      '<table class="mt"><thead><tr><th></th><th>当支撑</th><th>当压力</th></tr></thead><tbody>' +
      row('结构关键位（本页）', 'structure', 'pick') + row('常用参考线', 'ref') + row('随机价位', 'random') +
      '</tbody></table><div class="note">结论：关键位适合用来<b>定计划</b>（在哪里观察、跌破/突破哪里算错、下一步看哪里），' +
      '但别指望某一条线本身「一定撑得住」——10 年回测里，转折点、均线、布林这些位置被碰到后的表现，和同样距离的随机价位只差 1 个百分点左右。</div></div>';
  }

  function renderGuide() {
    const o = obsData();
    const list = $('#guideList');
    if (!list) return;
    const w = obsWin();
    if (!o || !w) {
      list.innerHTML = '<div class="muted" style="padding:10px 12px">没有观察数据</div>';
      return;
    }
    const rg = winRange(w);
    const km = o.key_model || {};
    const k = w.key;
    $('#guideSub').textContent = w.label + '（' + w.from + ' 起）· 概率模型用 ' + (km.n_symbols || '—') + ' 只股票 × ' + (km.years || '—') + ' 年训练';
    let html = '';
    if (k && k.levels.length) {
      html += judgeHtml(k, w, o);
      k.levels.forEach(function (lv, i) {
        html += keyCard(k, lv, i, rg, km);
        if (i < k.zones.length) html += zoneCard(k.zones[i], i, o, w, k);
      });
    } else {
      html += '<div class="muted" style="padding:10px 12px">窗口内没有找到模型认可的关键位</div>';
    }
    html += checkHtml(km);
    html += '<div class="ref-h"><button type="button" class="tog ' + (obs.ref ? 'on' : '') + '" data-ref-toggle>参考线 ' +
      (obs.ref ? '已显示' : '已隐藏') + '</button><span class="muted">均线、布林、高低点、成交剖面等常用标志线，只作对照</span></div>';
    if (obs.ref) w.lines.forEach(function (ln, i) { html += refCard(ln, i, o, rg); });
    list.innerHTML = html;
    list.onmouseover = function (ev) {
      const el = ev.target.closest('[data-li],[data-zi]');
      if (!el) return;
      setHot(el.getAttribute('data-li'), el.getAttribute('data-zi'));
    };
    list.onmouseleave = function () { setHot(null, null); };
    const rt = list.querySelector('[data-ref-toggle]');
    if (rt) rt.onclick = function () { setRef(!obs.ref); };
    const used = {};
    ((k && k.zones) || []).forEach(function (z) { (z.tags || []).forEach(function (t) { used[t] = true; }); });
    const zt = o.zone_tags || {};
    $('#guideTags').innerHTML = '<div class="sec-l">区间标签是什么意思</div>' +
      Object.keys(zt).filter(function (t) { return used[t]; }).map(function (t) {
        return '<div class="tgdef"><span class="tg ' + t + '">' + esc(zt[t].label) + '</span>' + esc(zt[t].text) + '</div>';
      }).join('');
    $('#guideDef').innerHTML = '颜色：<span class="kind-res">橙 = 在现价上方（压力）</span>，<span class="kind-sup">绿 = 在现价下方（支撑）</span>；线越粗，结构上越显著。' +
      'ATR = 近 14 日平均每天的波动幅度。<br>' + esc(km.def || '');
    const key = $('#obsKey');
    if (key) {
      let kh = '<span class="ky">' + swatch('key', 'support', 3) + '关键位（越粗越显著）</span>';
      if (obs.ref) {
        const groups = {};
        w.lines.forEach(function (ln) { groups[ln.group] = true; });
        kh += Object.keys(GROUP_STYLE).filter(function (g) { return groups[g]; }).map(function (g) {
          return '<span class="ky">' + swatch(g, null) + GROUP_STYLE[g].zh + '</span>';
        }).join('');
      }
      key.innerHTML = kh;
    }
    const rb = $('#btnRef');
    if (rb) rb.classList.toggle('on', obs.ref);
    const rail = list.closest('.rail');
    if (rail) rail.scrollTop = 0;
    footHint();
  }

  function setRef(on) {
    obs.ref = on;
    obs.hot = null;
    try { localStorage.setItem('levels.ref', on ? '1' : '0'); } catch (e) { /* */ }
    renderGuide();
    if (chart) { applyObsLines(); scheduleOverlay(); }
  }

  function bindGuideCrosshair() {
    let pending = null, raf = 0;
    chart.subscribeCrosshairMove(function (param) {
      pending = param;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        const p = pending;
        const w = obsWin();
        if (!w || !p || !p.point) { setHot(null, null); return; }
        const y = p.point.y;
        let best = null, bestD = 7;
        obsLines.forEach(function (e) {
          const ly = candleSeries.priceToCoordinate(e.price);
          if (ly == null) return;
          const d = Math.abs(ly - y) - (e.key ? 2 : 0);
          if (d < bestD) { bestD = d; best = e.id; }
        });
        if (best) { setHot(best, null); return; }
        const price = candleSeries.coordinateToPrice(y);
        let zone = null;
        if (price != null && w.key) w.key.zones.forEach(function (z, j) { if (price >= z.lo && price <= z.hi) zone = 'k' + j; });
        setHot(null, zone);
      });
    });
  }

  function obsAutoscale(orig) {
    const r = orig();
    const w = obsWin();
    if (!r || !r.priceRange || !w) return r;
    const pts = ((w.key && w.key.levels) || []).concat(obs.ref ? w.lines : []);
    pts.forEach(function (ln) {
      if (Math.abs(ln.dist_pct) > AUTOSCALE_PCT) return;
      r.priceRange.minValue = Math.min(r.priceRange.minValue, ln.price);
      r.priceRange.maxValue = Math.max(r.priceRange.maxValue, ln.price);
    });
    return r;
  }

  function buildChart() {
    const el = $('#chart');
    if (!el || typeof LightweightCharts === 'undefined') return;
    el.innerHTML = '';
    chart = LightweightCharts.createChart(el, chartTheme());
    candleSeries = chart.addCandlestickSeries(Object.assign(candleOpts(), { autoscaleInfoProvider: obsAutoscale }));
    candleSeries.setData(candleData(nBars()));
    applyObsLines();
    fitWithGutter(chart, nBars(), obsGutter());
    bindCrosshair(chart, candleSeries, '#crossBar');
    bindGuideCrosshair();
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlay);
    bindResize(chart, el);
  }

  const TAPE_GUTTER = 24;

  function nBars() {
    const all = (DATA.ohlcv && DATA.ohlcv.length) || (DATA.price_series && DATA.price_series.length) || 0;
    const w = obsWin();
    return w ? Math.min(all, w.bars) : all;
  }

  function obsGutter() {
    const stack = $('#chart') && $('#chart').parentElement;
    const w = stack ? stack.clientWidth : 0;
    return filters.vrvp ? Math.min(96, Math.max(56, w * 0.14)) + 20 : TAPE_GUTTER;
  }

  // Show every bar but leave an empty strip on the right, so the newest candles
  // never sit under the price-axis labels or the VRVP profile overlay.
  function fitWithGutter(ch, n, gutterPx) {
    if (!ch) return;
    const ts = ch.timeScale();
    const w = ts.width();
    if (!n || !w || w <= gutterPx * 3) { ts.fitContent(); return; }
    ts.setVisibleLogicalRange({ from: -0.5, to: n * w / (w - gutterPx) - 0.5 });
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
      if (key === 'signal') ch.timeScale().fitContent();
      else if (key === 'playback') fitWithGutter(ch, playState.idx + 1, TAPE_GUTTER);
      else fitWithGutter(ch, nBars(), key ? TAPE_GUTTER : obsGutter());
      if (!key) scheduleOverlay();
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { ensureChartSized(key); });
      });
    }
  }

  function syncWinButtons() {
    document.querySelectorAll('[data-win]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-win') === obs.win);
    });
  }

  function setWin(key) {
    const o = obsData();
    if (!o || !o.by_window[key] || key === obs.win) return;
    obs.win = key;
    obs.hot = null;
    obs.hotZone = null;
    try { localStorage.setItem('levels.window', key); } catch (e) { /* */ }
    syncWinButtons();
    renderGuide();
    renderHoldRail();
    renderBreakRail();
    if (chart) {
      candleSeries.setData(candleData(nBars()));
      applyObsLines();
      fitWithGutter(chart, nBars(), obsGutter());
      scheduleOverlay();
    }
    ['levels', 'hold', 'break'].forEach(function (k) {
      const t = tapes[k];
      if (!t.inited) return;
      t.series.setData(candleData(nBars()));
      if (k === 'levels') refreshLevelsChart();
      if (k === 'hold') refreshHoldMarkers();
      if (k === 'break') refreshBreakMarkers();
      fitWithGutter(t.chart, nBars(), TAPE_GUTTER);
    });
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
    series.setData(candleData(nBars()));
    tapes.levels = { chart: ch, series: series, lines: [], inited: true };
    refreshLevelsChart();
    fitWithGutter(ch, nBars(), TAPE_GUTTER);
    bindCrosshair(ch, series, '#crossLevels');
    bindResize(ch, el);
    const fit = $('#btnFitLevels');
    if (fit) fit.onclick = function () { fitWithGutter(ch, nBars(), TAPE_GUTTER); };
  }

  /* —— 触及 —— */
  function holdEventsFiltered() {
    const ev = ((DATA.backtest || {}).hold || {}).events || [];
    const from = winFrom();
    return ev.filter(function (e) {
      if (from && e.date < from) return false;
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
    series.setData(candleData(nBars()));
    tapes.hold = { chart: ch, series: series, lines: [], inited: true };
    refreshHoldMarkers();
    fitWithGutter(ch, nBars(), TAPE_GUTTER);
    bindCrosshair(ch, series, '#crossHold');
    bindResize(ch, el);
    const fit = $('#btnFitHold');
    if (fit) fit.onclick = function () { fitWithGutter(ch, nBars(), TAPE_GUTTER); };
  }

  /* —— 突破 —— */
  function breakEventsFiltered() {
    const br = (DATA.backtest || {}).breakout || {};
    let ev = br.events || [];
    if (!ev.length) {
      ev = [].concat(br.examples_up || [], br.examples_down || []);
    }
    const from = winFrom();
    return ev.filter(function (e) {
      if (from && e.date < from) return false;
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
    series.setData(candleData(nBars()));
    tapes.break = { chart: ch, series: series, lines: [], inited: true };
    refreshBreakMarkers();
    fitWithGutter(ch, nBars(), TAPE_GUTTER);
    bindCrosshair(ch, series, '#crossBreak');
    bindResize(ch, el);
    const fit = $('#btnFitBreak');
    if (fit) fit.onclick = function () { fitWithGutter(ch, nBars(), TAPE_GUTTER); };
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
      fitWithGutter(t.chart, idx + 1, TAPE_GUTTER);
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
    if (fit) fit.onclick = function () { fitWithGutter(ch, playState.idx + 1, TAPE_GUTTER); };
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
    const rbtn = $('#btnRef');
    if (rbtn) rbtn.addEventListener('click', function () { setRef(!obs.ref); });
    const vbtn = $('#btnVrvp');
    if (vbtn) {
      vbtn.addEventListener('click', function () {
        filters.vrvp = !filters.vrvp;
        syncPresetButtons();
        if (chart) fitWithGutter(chart, nBars(), obsGutter());
        scheduleOverlay();
      });
    }
    const fit = $('#btnFit');
    if (fit) {
      fit.addEventListener('click', function () {
        if (chart) fitWithGutter(chart, nBars(), obsGutter());
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
    document.querySelectorAll('[data-win]').forEach(function (btn) {
      btn.addEventListener('click', function () { setWin(btn.getAttribute('data-win')); });
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
    const ws = $('#winSwitch');
    if (ws) ws.hidden = !obsData() || ['observe', 'levels', 'hold', 'break'].indexOf(id) < 0;
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
    renderHeader();
    loadPrefs();
    renderSignalRail();
    renderSigMetrics();
    loadWinPref();
    syncWinButtons();
    renderGuide();
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
