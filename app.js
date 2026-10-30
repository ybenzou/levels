/* AVGO levels — Swiss observation + VRVP + chart tabs */
(function () {
  'use strict';

  const KIND_LABEL = { resistance: '压力', support: '支撑', anchor: '锚点' };
  const KIND_CLASS = { resistance: 'kind-res', support: 'kind-sup', anchor: 'kind-anc' };

  const filters = {
    kinds: { resistance: true, support: true, anchor: true },
    preset: 'priority',
    vrvp: true,
  };

  let DATA = null;
  let chart = null;
  let candleSeries = null;
  let priceLines = [];
  let profileCache = null;
  let overlayRaf = 0;

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

  function levelPasses(lv) {
    if (!filters.kinds[lv.kind]) return false;
    if (filters.preset === 'priority') return lv.priority <= 1;
    if (filters.preset === 'near5') return Math.abs(Number(lv.dist_pct)) <= 5;
    return true;
  }
  function visibleLevels() {
    return (DATA.levels || []).filter(levelPasses);
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
    // 70% value area around POC
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

  function renderHeader() {
    $('#title').textContent = DATA.symbol;
    const close = Number(DATA.last_close).toFixed(2);
    $('#asof').innerHTML = '截至 <strong>' + esc(DATA.as_of) + '</strong> · 末收 <strong>' +
      close + '</strong>';
  }

  function lineColor(kind, priority) {
    if (kind === 'resistance') return priority <= 1 ? 'rgba(200,16,46,0.95)' : 'rgba(200,16,46,0.4)';
    if (kind === 'support') return priority <= 1 ? 'rgba(10,10,10,0.9)' : 'rgba(10,10,10,0.35)';
    return 'rgba(92,92,92,0.85)';
  }

  function clearPriceLines() {
    if (!candleSeries) return;
    priceLines.forEach(function (pl) {
      try { candleSeries.removePriceLine(pl); } catch (e) { /* */ }
    });
    priceLines = [];
  }

  function applyPriceLines() {
    if (!candleSeries) return;
    clearPriceLines();
    visibleLevels().forEach(function (lv) {
      const pl = candleSeries.createPriceLine({
        price: lv.price,
        color: lineColor(lv.kind, lv.priority),
        lineWidth: lv.priority <= 1 || lv.kind === 'anchor' ? 2 : 1,
        lineStyle: lv.kind === 'anchor' ? LightweightCharts.LineStyle.Dashed :
          (lv.priority <= 1 ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed),
        axisLabelVisible: lv.priority <= 1 || lv.kind === 'anchor',
        title: KIND_LABEL[lv.kind] + ' ' + lv.price,
      });
      priceLines.push(pl);
    });
    // VRVP structural lines (always when toggle on)
    if (filters.vrvp && DATA.state && DATA.state.vrvp) {
      const v = DATA.state.vrvp;
      [
        { price: v.poc, color: 'rgba(200,16,46,0.95)', w: 2, title: 'POC', style: LightweightCharts.LineStyle.Solid },
        { price: v.vah, color: 'rgba(10,10,10,0.55)', w: 1, title: 'VAH', style: LightweightCharts.LineStyle.Dashed },
        { price: v.val, color: 'rgba(10,10,10,0.55)', w: 1, title: 'VAL', style: LightweightCharts.LineStyle.Dashed },
      ].forEach(function (cfg) {
        if (cfg.price == null) return;
        const pl = candleSeries.createPriceLine({
          price: cfg.price,
          color: cfg.color,
          lineWidth: cfg.w,
          lineStyle: cfg.style,
          axisLabelVisible: true,
          title: cfg.title,
        });
        priceLines.push(pl);
      });
    }
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
    const rows = visibleLevels().slice().sort(function (a, b) { return b.price - a.price; });
    rows.forEach(function (lv) {
      const k = lv.kind === 'resistance' ? 'res' : (lv.kind === 'support' ? 'sup' : 'anc');
      const dist = (lv.dist_pct >= 0 ? '+' : '') + Number(lv.dist_pct).toFixed(1) + '%';
      parts.push('<span class="lg"><span class="sw ' + k + '"></span>' +
        '<span class="px">' + lv.price.toFixed(1) + '</span> ' +
        KIND_LABEL[lv.kind] + ' ' + dist + '</span>');
    });
    el.innerHTML = parts.join('');
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
    if (!filters.vrvp) return;

    const st = DATA.state || {};
    const vrvp = st.vrvp || {};
    const yOf = function (p) {
      try { return candleSeries.priceToCoordinate(p); } catch (e) { return null; }
    };

    // Value area band
    if (vrvp.val != null && vrvp.vah != null) {
      const y1 = yOf(vrvp.vah);
      const y2 = yOf(vrvp.val);
      if (y1 != null && y2 != null) {
        const top = Math.min(y1, y2);
        const bot = Math.max(y1, y2);
        ctx.fillStyle = 'rgba(10,10,10,0.055)';
        ctx.fillRect(0, top, w, bot - top);
        ctx.strokeStyle = 'rgba(10,10,10,0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, top); ctx.lineTo(w, top);
        ctx.moveTo(0, bot); ctx.lineTo(w, bot);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // HVN / LVN horizontal bands from levels
    (DATA.levels || []).forEach(function (lv) {
      const tag = classifyVrvpLevel(lv);
      if (!tag || tag === 'poc' || tag === 'vah' || tag === 'val') return;
      const y = yOf(lv.price);
      if (y == null) return;
      const bandH = 7;
      if (tag === 'hvn') {
        ctx.fillStyle = 'rgba(10,10,10,0.14)';
        ctx.fillRect(0, y - bandH / 2, w, bandH);
      } else if (tag === 'lvn') {
        ctx.fillStyle = 'rgba(200,16,46,0.10)';
        ctx.fillRect(0, y - bandH / 2, w, bandH);
        ctx.strokeStyle = 'rgba(200,16,46,0.35)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Volume profile histogram on the right
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
      ctx.fillStyle = inVA ? 'rgba(10,10,10,0.38)' : 'rgba(10,10,10,0.16)';
      ctx.fillRect(x0 + (profileW - 4 - bw), top, bw, bh);
    }

    // POC marker on profile
    if (vrvp.poc != null) {
      const yp = yOf(vrvp.poc);
      if (yp != null) {
        ctx.strokeStyle = 'rgba(200,16,46,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x0, yp);
        ctx.lineTo(x0 + profileW - 2, yp);
        ctx.stroke();
      }
    }

    // Labels
    ctx.fillStyle = 'rgba(10,10,10,0.55)';
    ctx.font = '9px Helvetica Neue, Helvetica, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('VRVP', w - 6, 12);
  }

  function buildChart() {
    const el = $('#chart');
    if (!el || typeof LightweightCharts === 'undefined') return;
    el.innerHTML = '';
    chart = LightweightCharts.createChart(el, {
      layout: {
        background: { type: 'solid', color: '#fafaf8' },
        textColor: '#5c5c5c',
        fontSize: 11,
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      },
      grid: {
        vertLines: { color: '#e4e4de' },
        horzLines: { color: '#e4e4de' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#0a0a0a', scaleMargins: { top: 0.04, bottom: 0.06 } },
      timeScale: { borderColor: '#0a0a0a', timeVisible: false, rightOffset: 4 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#0a0a0a',
      downColor: '#c8102e',
      borderUpColor: '#0a0a0a',
      borderDownColor: '#c8102e',
      wickUpColor: '#0a0a0a',
      wickDownColor: '#c8102e',
    });

    let candles = [];
    if (DATA.ohlcv && DATA.ohlcv.length) {
      candles = DATA.ohlcv.map(function (b) {
        return { time: toUnix(b.date), open: b.open, high: b.high, low: b.low, close: b.close };
      });
    } else if (DATA.price_series && DATA.price_series.length) {
      candles = DATA.price_series.map(function (b) {
        const c = b.close;
        return { time: toUnix(b.date), open: c, high: c, low: c, close: c };
      });
    }
    candleSeries.setData(candles);
    applyPriceLines();
    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove(function (param) {
      const bar = $('#crossBar');
      if (!bar) return;
      if (!param || !param.time || !param.seriesData) {
        bar.textContent = '十字线 · OHLC';
        return;
      }
      const d = param.seriesData.get(candleSeries);
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

    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlay);
    chart.subscribeCrosshairMove(scheduleOverlay);

    function syncChartSize() {
      if (!chart || !el) return;
      const stack = el.parentElement;
      const w = stack ? stack.clientWidth : el.clientWidth;
      const h = stack ? stack.clientHeight : el.clientHeight;
      if (w > 0 && h > 0) {
        chart.applyOptions({ width: w, height: h });
        scheduleOverlay();
      }
    }
    const ro = new ResizeObserver(function () { syncChartSize(); });
    const stack = el.closest('.chart-stack') || el;
    ro.observe(stack);
    const pane = el.closest('.chart-pane');
    if (pane) ro.observe(pane);
    const obs = el.closest('.obs');
    if (obs) ro.observe(obs);
    window.addEventListener('resize', syncChartSize);
    requestAnimationFrame(function () {
      requestAnimationFrame(syncChartSize);
    });
    syncChartSize();
  }

  function ensureChartSized() {
    if (!chart) return;
    const el = $('#chart');
    const stack = el && el.parentElement;
    const w = stack ? stack.clientWidth : (el && el.clientWidth);
    const h = stack ? stack.clientHeight : (el && el.clientHeight);
    if (w > 0 && h > 0) {
      chart.applyOptions({ width: w, height: h });
      chart.timeScale().fitContent();
      scheduleOverlay();
    } else {
      requestAnimationFrame(function () {
        requestAnimationFrame(ensureChartSized);
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

  /* —— 点位 visuals —— */
  function renderLevelsViz() {
    const rows = visibleLevels().slice().sort(function (a, b) { return b.price - a.price; });
    const maxAbs = Math.max.apply(null, rows.map(function (lv) {
      return Math.abs(Number(lv.dist_pct) || 0);
    }).concat([5]));
    const last = Number(DATA.last_close);

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
        '<div class="mark">' + (tag ? tag.toUpperCase() : (PRI_LABEL(lv.priority))) + '</div>' +
        '</div>';
    }).join('');

    // key bands as layered zones across price range
    const bands = (DATA.key_bands || []).filter(function (b) { return filters.kinds[b.kind]; });
    const st = DATA.state || {};
    const pLo = Number(st.window_low) || (last * 0.8);
    const pHi = Number(st.window_high) || (last * 1.2);
    const span = Math.max(1, pHi - pLo);
    const pxPct = function (p) {
      return Math.max(0, Math.min(100, ((p - pLo) / span) * 100));
    };
    const lastPct = pxPct(last);
    $('#bandsViz').innerHTML = bands.map(function (b) {
      const lo = Math.min(b.lo, b.hi);
      const hi = Math.max(b.lo, b.hi);
      const left = pxPct(lo);
      const right = pxPct(hi);
      const kcls = b.kind === 'resistance' ? 'res' : (b.kind === 'support' ? 'sup' : 'anc');
      const rng = b.lo === b.hi ? String(b.lo) : (b.lo + '–' + b.hi);
      return '<div class="bz ' + kcls + '">' +
        '<div class="lb">' + esc(b.label) + '</div>' +
        '<div class="zone">' +
          '<i style="left:' + left.toFixed(2) + '%;width:' + Math.max(0.6, right - left).toFixed(2) + '%"></i>' +
          '<span class="pxline" style="left:' + lastPct.toFixed(2) + '%"></span>' +
        '</div>' +
        '<div class="rng">' + esc(rng) + '</div></div>';
    }).join('');

    drawLevelsProfile();
  }

  function PRI_LABEL(p) {
    return ({ 0: '现价', 1: '高优', 2: '中', 3: '低' })[p] || String(p);
  }

  function drawLevelsProfile() {
    const canvas = $('#levelsProfile');
    const meta = $('#levelsProfileMeta');
    if (!canvas) return;
    const prof = getProfile();
    const vrvp = (DATA.state && DATA.state.vrvp) || {};
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 152;
    const cssH = Math.max(280, canvas.clientHeight || 420);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padT = 8, padB = 8, padL = 4, padR = 36;
    const plotH = cssH - padT - padB;
    const plotW = cssW - padL - padR;
    if (!prof) {
      ctx.fillStyle = '#5c5c5c';
      ctx.font = '11px Helvetica Neue, Helvetica, Arial';
      ctx.fillText('无剖面', padL, 20);
      return;
    }

    const yOf = function (p) {
      return padT + ((prof.hi - p) / (prof.hi - prof.lo)) * plotH;
    };

    // VA band
    if (vrvp.val != null && vrvp.vah != null) {
      const y1 = yOf(vrvp.vah);
      const y2 = yOf(vrvp.val);
      ctx.fillStyle = 'rgba(10,10,10,0.06)';
      ctx.fillRect(padL, Math.min(y1, y2), plotW, Math.abs(y2 - y1));
    }

    // Histogram bars (left-aligned)
    for (let i = 0; i < prof.bins; i++) {
      const pLo = prof.lo + i * prof.step;
      const pHi = pLo + prof.step;
      const top = yOf(pHi);
      const bot = yOf(pLo);
      const bh = Math.max(1, bot - top);
      const ratio = prof.vol[i] / prof.max;
      const bw = ratio * plotW;
      const mid = (pLo + pHi) / 2;
      const inVA = vrvp.val != null && vrvp.vah != null && mid >= vrvp.val && mid <= vrvp.vah;
      ctx.fillStyle = inVA ? 'rgba(10,10,10,0.45)' : 'rgba(10,10,10,0.18)';
      ctx.fillRect(padL, top, bw, bh);
    }

    // HVN / LVN ticks
    (DATA.levels || []).forEach(function (lv) {
      const tag = classifyVrvpLevel(lv);
      if (tag !== 'hvn' && tag !== 'lvn') return;
      const y = yOf(lv.price);
      ctx.strokeStyle = tag === 'hvn' ? 'rgba(10,10,10,0.7)' : 'rgba(200,16,46,0.7)';
      ctx.lineWidth = tag === 'hvn' ? 2 : 1;
      ctx.setLineDash(tag === 'lvn' ? [3, 2] : []);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = tag === 'hvn' ? '#0a0a0a' : '#c8102e';
      ctx.font = '8px Helvetica Neue, Helvetica, Arial';
      ctx.textAlign = 'left';
      ctx.fillText(tag.toUpperCase(), padL + plotW + 2, y + 3);
    });

    // POC / VAL / VAH labels
    [
      { p: vrvp.poc, lab: 'POC', c: '#c8102e' },
      { p: vrvp.vah, lab: 'VAH', c: '#0a0a0a' },
      { p: vrvp.val, lab: 'VAL', c: '#0a0a0a' },
    ].forEach(function (x) {
      if (x.p == null) return;
      const y = yOf(x.p);
      ctx.strokeStyle = x.c;
      ctx.lineWidth = x.lab === 'POC' ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW + 2, y);
      ctx.stroke();
      ctx.fillStyle = x.c;
      ctx.font = 'bold 9px Helvetica Neue, Helvetica, Arial';
      ctx.textAlign = 'left';
      ctx.fillText(x.lab, padL + plotW + 2, y - 2);
    });

    // last price
    const last = Number(DATA.last_close);
    const yl = yOf(last);
    ctx.strokeStyle = 'rgba(200,16,46,0.55)';
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(padL, yl);
    ctx.lineTo(padL + plotW, yl);
    ctx.stroke();
    ctx.setLineDash([]);

    if (meta) {
      meta.innerHTML = 'POC <strong>' + Number(vrvp.poc).toFixed(1) + '</strong><br>' +
        'VA <strong>' + Number(vrvp.val).toFixed(0) + '–' + Number(vrvp.vah).toFixed(0) + '</strong><br>' +
        (vrvp.price_vs_va === 'inside_va' ? '现价在价值区内' : esc(vrvp.price_vs_va || ''));
    }
  }

  /* —— 触及 visuals —— */
  function renderHoldTab() {
    const bt = DATA.backtest || {};
    const hold = bt.hold || {};
    const def = (bt.definitions && bt.definitions.hold_def_zh) || '';
    const holdDef = $('#holdDef');
    if (holdDef) {
      holdDef.textContent = def.replace(/描述性回测，非交易建议。?$/, '').trim();
    }
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#holdKpi').innerHTML = [
      cell('支撑守住', pct(os.hit_rate), 'n=' + (os.n || 0), barHtml(os.hit_rate, '')),
      cell('压力守住', pct(or_.hit_rate), 'n=' + (or_.n || 0), barHtml(or_.hit_rate, 'res')),
      cell('事件', String(hold.n_events || 0), (bt.definitions && bt.definitions.window) || ''),
    ].join('');

    const ss = $('#holdSideSplit');
    if (ss) {
      ss.innerHTML =
        '<div class="ss"><div class="k">支撑</div><div class="v">' + pct(os.hit_rate) + '</div></div>' +
        '<div class="ss r"><div class="k">压力</div><div class="v">' + pct(or_.hit_rate) + '</div></div>';
    }

    const fam = hold.by_family || {};
    const list = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n > 0; })
      .sort(function (a, b) { return (b.hit_rate || 0) - (a.hit_rate || 0); });

    $('#holdChart').innerHTML = list.map(function (f) {
      const isR = f.side === 'resistance';
      const w = Math.max(0, Math.min(100, (f.hit_rate || 0) * 100));
      return '<div class="hb ' + (isR ? 'r' : '') + '">' +
        '<div class="nm">' + esc(f.family || '') + '</div>' +
        '<div class="sd ' + (isR ? 'r' : '') + '">' + (isR ? '压' : '撑') + '</div>' +
        '<div class="trk"><i style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<div class="rt">' + pct(f.hit_rate) + '</div>' +
        '<div class="n">n=' + f.n + '</div></div>';
    }).join('');
  }

  /* —— 突破 visuals —— */
  function mapRetToPct(v, minR, maxR) {
    if (v == null || Number.isNaN(v)) return 50;
    const span = Math.max(1e-6, maxR - minR);
    return ((v - minR) / span) * 100;
  }

  function renderBreakTab() {
    const bt = DATA.backtest || {};
    const br = bt.breakout || {};
    const def = (bt.definitions && bt.definitions.break_def_zh) || '';
    const breakDef = $('#breakDef');
    if (breakDef) breakDef.textContent = def.trim();

    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};

    // Collect range for IQR scale across all horizons
    let minR = 0, maxR = 0;
    [up, dn].forEach(function (side) {
      [1, 3, 5].forEach(function (h) {
        const s = side[h] || {};
        if (s.p25 != null) minR = Math.min(minR, s.p25, s.median || 0);
        if (s.p75 != null) maxR = Math.max(maxR, s.p75, s.median || 0);
      });
    });
    // pad
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
      hzCard('up', 1), hzCard('up', 3), hzCard('up', 5),
      hzCard('down', 1), hzCard('down', 3), hzCard('down', 5),
    ].join('');

    function hCard(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      return cell(
        (dir === 'up' ? '↑' : '↓') + h + 'd',
        '<span class="' + clsRet(s.median) + '">' + pctPts(s.median) + '</span>',
        '胜 ' + pct(s.win_rate),
        barHtml(s.win_rate, dir === 'down' ? 'res' : '')
      );
    }
    $('#breakKpi').innerHTML = [
      hCard('up', 1), hCard('up', 5),
      hCard('down', 1), hCard('down', 5),
    ].join('');

    const fam = br.by_family_h5 || {};
    const list = Object.keys(fam).map(function (k) { return fam[k]; })
      .filter(function (f) { return f && f.n > 0; })
      .sort(function (a, b) { return (b.median || 0) - (a.median || 0); });

    let fMin = 0, fMax = 0;
    list.forEach(function (f) {
      if (f.p25 != null) fMin = Math.min(fMin, f.p25, f.median || 0);
      if (f.p75 != null) fMax = Math.max(fMax, f.p75, f.median || 0);
    });
    const fPad = Math.max(1, (fMax - fMin) * 0.08);
    fMin -= fPad; fMax += fPad;

    $('#breakChart').innerHTML = list.map(function (f) {
      const isDn = f.dir === 'down';
      const left = mapRetToPct(f.p25, fMin, fMax);
      const right = mapRetToPct(f.p75, fMin, fMax);
      const med = mapRetToPct(f.median, fMin, fMax);
      const zero = mapRetToPct(0, fMin, fMax);
      return '<div class="fc ' + (isDn ? 'dn' : '') + '">' +
        '<div class="nm">' + esc(f.family || '') + '</div>' +
        '<div class="dir ' + (isDn ? 'dn' : '') + '">' + (isDn ? '↓' : '↑') + '</div>' +
        '<div class="axis">' +
          '<span class="zero" style="left:' + zero.toFixed(1) + '%"></span>' +
          '<span class="iqr" style="left:' + left.toFixed(1) + '%;width:' +
            Math.max(1, right - left).toFixed(1) + '%"></span>' +
          '<span class="med" style="left:' + med.toFixed(1) + '%"></span>' +
        '</div>' +
        '<div class="md ' + clsRet(f.median) + '">' + pctPts(f.median) + '</div></div>';
    }).join('');
  }

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
  }

  function refreshLevelDependent() {
    applyPriceLines();
    renderLevelsViz();
  }

  function bindFilters() {
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filters.preset = btn.getAttribute('data-preset');
        syncPresetButtons();
        refreshLevelDependent();
      });
    });
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-kind');
        filters.kinds[k] = !filters.kinds[k];
        syncPresetButtons();
        refreshLevelDependent();
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
      stamp.textContent = ({ observe: '观察', levels: '点位', hold: '触及', break: '突破' })[id] || id;
    }
    if (id === 'observe') {
      requestAnimationFrame(function () { ensureChartSized(); });
    }
    if (id === 'levels') {
      requestAnimationFrame(function () { drawLevelsProfile(); });
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
      $('#app').innerHTML = '<div style="padding:20px;font-family:Helvetica,Arial,sans-serif">无法加载 data.json：' + esc(e.message) + '</div>';
      return;
    }
    profileCache = null;
    renderHeader();
    buildChart();
    renderObsAccuracy();
    renderLevelsViz();
    renderHoldTab();
    renderBreakTab();
    syncPresetButtons();
    bindFilters();
    bindViews();
    switchView('observe');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
