/* AVGO levels — Swiss observation dashboard */
(function () {
  'use strict';

  const KIND_LABEL = { resistance: '压力', support: '支撑', anchor: '锚点' };
  const KIND_CLASS = { resistance: 'kind-res', support: 'kind-sup', anchor: 'kind-anc' };
  const PRI_LABEL = { 0: '现价', 1: '高优', 2: '中', 3: '低' };

  const filters = {
    kinds: { resistance: true, support: true, anchor: true },
    preset: 'priority',
  };

  let DATA = null;
  let chart = null;
  let candleSeries = null;
  let priceLines = [];

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

  function renderHeader() {
    $('#title').textContent = DATA.symbol;
    const close = Number(DATA.last_close).toFixed(2);
    $('#asof').innerHTML = '截至 <strong>' + esc(DATA.as_of) + '</strong> · 末收 <strong>' +
      close + '</strong>';
  }

  function renderState() {
    const st = DATA.state || {};
    const ma = st.ma_stack || {};
    const boll = st.boll || {};
    const macd = st.macd || {};
    const vrvp = st.vrvp || {};
    const items = [
      ['窗口', st.window || '—'],
      ['高 / 低', (st.window_high != null ? st.window_high : '—') + ' / ' + (st.window_low != null ? st.window_low : '—')],
      ['ATR14', st.atr14 != null ? Number(st.atr14).toFixed(2) : '—'],
      ['RSI14', st.rsi14 != null ? String(st.rsi14) : '—'],
      ['布林', boll.mid != null ? (boll.lo + ' · ' + boll.mid + ' · ' + boll.up) : '—'],
      ['MACD', macd.macd != null ? (macd.macd + ' / ' + macd.signal) : '—'],
      ['EMA', [ma.ema20, ma.ema50, ma.ema200].map(function (x) { return x ? x.val : '—'; }).join(' / ')],
      ['POC', vrvp.poc != null ? (vrvp.poc + ' · ' + vrvp.val + '–' + vrvp.vah) : '—'],
    ];
    $('#stateGrid').innerHTML = items.map(function (it) {
      return '<div class="si"><div class="k">' + esc(it[0]) + '</div><div class="v">' + esc(it[1]) + '</div></div>';
    }).join('');
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
    renderLegend();
  }

  function renderLegend() {
    const el = $('#levelLegend');
    if (!el) return;
    const rows = visibleLevels().slice().sort(function (a, b) { return b.price - a.price; });
    if (!rows.length) { el.innerHTML = ''; return; }
    el.innerHTML = rows.map(function (lv) {
      const k = lv.kind === 'resistance' ? 'res' : (lv.kind === 'support' ? 'sup' : 'anc');
      const dist = (lv.dist_pct >= 0 ? '+' : '') + Number(lv.dist_pct).toFixed(1) + '%';
      return '<span class="lg"><span class="sw ' + k + '"></span>' +
        '<span class="px">' + lv.price.toFixed(1) + '</span> ' +
        KIND_LABEL[lv.kind] + ' ' + dist + '</span>';
    }).join('');
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

    const ro = new ResizeObserver(function () {
      if (chart && el.clientWidth > 0 && el.clientHeight > 0) {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    });
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight || 400 });
  }

  function ensureChartSized() {
    if (!chart) return;
    const el = $('#chart');
    if (el && el.clientWidth > 0 && el.clientHeight > 0) {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      chart.timeScale().fitContent();
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

  function renderLevelsTable() {
    const rows = visibleLevels().slice().sort(function (a, b) { return b.price - a.price; });
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>价</th><th>距</th><th>类</th><th>优</th><th>来源</th>',
      '</tr></thead><tbody>'];
    rows.forEach(function (lv) {
      const dist = lv.dist_pct;
      const distStr = (dist >= 0 ? '+' : '') + Number(dist).toFixed(1) + '%';
      html.push('<tr>',
        '<td><strong>' + lv.price.toFixed(2) + '</strong></td>',
        '<td class="' + (dist >= 0 ? 'pos' : 'neg') + '">' + distStr + '</td>',
        '<td class="' + KIND_CLASS[lv.kind] + '">' + KIND_LABEL[lv.kind] + '</td>',
        '<td><span class="badge p' + lv.priority + '">' + (PRI_LABEL[lv.priority] || lv.priority) + '</span></td>',
        '<td>' + esc(lv.role) +
          (lv.sources && lv.sources.length ? '<div class="muted" style="margin-top:1px;font-size:10px">' + esc(lv.sources.join(' · ')) + '</div>' : '') +
        '</td></tr>');
    });
    html.push('</tbody></table></div>');
    $('#levelsTable').innerHTML = html.join('');

    const bands = (DATA.key_bands || []).filter(function (b) { return filters.kinds[b.kind]; });
    const bh = ['<div class="table-wrap"><table><thead><tr>',
      '<th>带</th><th>区间</th><th>类</th></tr></thead><tbody>'];
    bands.forEach(function (b) {
      const rng = b.lo === b.hi ? String(b.lo) : (b.lo + '–' + b.hi);
      bh.push('<tr><td>' + esc(b.label) + '</td><td>' + esc(rng) + '</td>',
        '<td class="' + KIND_CLASS[b.kind] + '">' + KIND_LABEL[b.kind] + '</td></tr>');
    });
    bh.push('</tbody></table></div>');
    $('#bandsTable').innerHTML = bh.join('');
  }

  function renderHoldTab() {
    const bt = DATA.backtest || {};
    const hold = bt.hold || {};
    const def = (bt.definitions && bt.definitions.hold_def_zh) || '';
    $('#holdDef').textContent = def.replace(/描述性回测，非交易建议。?$/, '').trim();
    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#holdKpi').innerHTML = [
      cell('支撑守住', pct(os.hit_rate), 'n=' + (os.n || 0), barHtml(os.hit_rate, '')),
      cell('压力守住', pct(or_.hit_rate), 'n=' + (or_.n || 0), barHtml(or_.hit_rate, 'res')),
      cell('事件', String(hold.n_events || 0), (bt.definitions && bt.definitions.window) || ''),
    ].join('');

    const fam = hold.by_family || {};
    const keys = Object.keys(fam).sort();
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>族</th><th>侧</th><th>n</th><th>守</th><th>率</th><th></th></tr></thead><tbody>'];
    keys.forEach(function (k) {
      const f = fam[k];
      const w = Math.max(0, Math.min(100, (f.hit_rate || 0) * 100));
      const isR = f.side === 'resistance';
      html.push('<tr><td>' + esc(f.family || k) + '</td>',
        '<td class="' + (isR ? 'kind-res' : 'kind-sup') + '">' + (isR ? '压' : '撑') + '</td>',
        '<td>' + f.n + '</td><td>' + f.held + '</td>',
        '<td><strong>' + pct(f.hit_rate) + '</strong></td>',
        '<td style="width:72px;padding-top:10px"><div class="bar ' + (isR ? 'res' : '') + '"><i style="width:' + w.toFixed(1) + '%"></i></div></td></tr>');
    });
    html.push('</tbody></table></div>');
    $('#holdTable').innerHTML = html.join('');
  }

  function renderBreakTab() {
    const bt = DATA.backtest || {};
    const br = bt.breakout || {};
    const def = (bt.definitions && bt.definitions.break_def_zh) || '';
    $('#breakDef').textContent = def.trim();
    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};
    function hCard(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      return cell(
        (dir === 'up' ? '↑' : '↓') + h + 'd 中位',
        '<span class="' + clsRet(s.median) + '">' + pctPts(s.median) + '</span>',
        '均 ' + pctPts(s.mean) + ' · 胜 ' + pct(s.win_rate) + ' · n=' + (s.n || 0),
        barHtml(s.win_rate, dir === 'down' ? 'res' : '')
      );
    }
    $('#breakKpi').innerHTML = [
      hCard('up', 1), hCard('up', 3), hCard('up', 5),
      hCard('down', 1), hCard('down', 3), hCard('down', 5),
    ].join('');

    const fam = br.by_family_h5 || {};
    const keys = Object.keys(fam).sort();
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>族</th><th>向</th><th>n</th><th>中位</th><th>均</th><th>胜</th><th>P25–75</th>',
      '</tr></thead><tbody>'];
    keys.forEach(function (k) {
      const f = fam[k];
      html.push('<tr><td>' + esc(f.family || k) + '</td>',
        '<td>' + (f.dir === 'up' ? '↑' : '↓') + '</td>',
        '<td>' + f.n + '</td>',
        '<td class="' + clsRet(f.median) + '"><strong>' + pctPts(f.median) + '</strong></td>',
        '<td class="' + clsRet(f.mean) + '">' + pctPts(f.mean) + '</td>',
        '<td>' + pct(f.win_rate) + '</td>',
        '<td class="muted">' + pctPts(f.p25) + '–' + pctPts(f.p75) + '</td></tr>');
    });
    html.push('</tbody></table></div>');
    $('#breakTable').innerHTML = html.join('');

    function exTable(list, title) {
      if (!list || !list.length) return '';
      let h = '<div class="ex-h">' + esc(title) + '</div><div class="table-wrap"><table><thead><tr>' +
        '<th>日</th><th>族</th><th>价</th><th>收</th><th>+1</th><th>+3</th><th>+5</th></tr></thead><tbody>';
      list.forEach(function (ex) {
        const r = ex.rets || {};
        h += '<tr><td>' + esc(ex.date) + '</td><td>' + esc(ex.family) + '</td><td>' +
          Number(ex.level).toFixed(2) + '</td><td>' + Number(ex.close).toFixed(2) + '</td>' +
          '<td class="' + clsRet(r['1']) + '">' + pctPts(r['1']) + '</td>' +
          '<td class="' + clsRet(r['3']) + '">' + pctPts(r['3']) + '</td>' +
          '<td class="' + clsRet(r['5']) + '">' + pctPts(r['5']) + '</td></tr>';
      });
      h += '</tbody></table></div>';
      return h;
    }
    $('#breakExamples').innerHTML =
      exTable(br.examples_up, '近期 ↑ 突破') +
      exTable(br.examples_down, '近期 ↓ 突破');
  }

  function syncPresetButtons() {
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-preset') === filters.preset);
    });
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      const k = btn.getAttribute('data-kind');
      btn.classList.toggle('on', !!filters.kinds[k]);
    });
  }

  function bindFilters() {
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        filters.preset = btn.getAttribute('data-preset');
        syncPresetButtons();
        applyPriceLines();
        renderLevelsTable();
      });
    });
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-kind');
        filters.kinds[k] = !filters.kinds[k];
        syncPresetButtons();
        applyPriceLines();
        renderLevelsTable();
      });
    });
    const fit = $('#btnFit');
    if (fit) {
      fit.addEventListener('click', function () {
        if (chart) chart.timeScale().fitContent();
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
    if (id === 'observe') {
      requestAnimationFrame(function () { ensureChartSized(); });
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
    renderHeader();
    renderState();
    buildChart();
    renderObsAccuracy();
    renderLevelsTable();
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
