/* AVGO daily key-levels dashboard */
(function () {
  'use strict';

  const KIND_LABEL = { resistance: '压力', support: '支撑', anchor: '锚点' };
  const KIND_CLASS = { resistance: 'kind-res', support: 'kind-sup', anchor: 'kind-anc' };
  const PRI_LABEL = { 0: '现价', 1: '高优', 2: '中优', 3: '低优' };

  const filters = {
    kinds: { resistance: true, support: true, anchor: true },
    priorities: { 0: true, 1: true, 2: true, 3: false },
  };

  let DATA = null;
  let chart = null;
  let candleSeries = null;
  let priceLines = [];

  function $(sel) { return document.querySelector(sel); }
  function pct(x, digits) {
    if (x == null || Number.isNaN(x)) return '—';
    return (x * 100).toFixed(digits == null ? 1 : digits) + '%';
  }
  function pctPts(x, digits) {
    if (x == null || Number.isNaN(x)) return '—';
    const n = Number(x);
    const s = (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits) + '%';
    return s;
  }
  function clsRet(x) {
    if (x == null || Number.isNaN(x)) return 'muted';
    return Number(x) >= 0 ? 'pos' : 'neg';
  }
  function toUnix(dateStr) {
    // UTC midnight for Lightweight Charts time
    const [y, m, d] = dateStr.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 1000);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function visibleLevels() {
    return (DATA.levels || []).filter(function (lv) {
      return filters.kinds[lv.kind] && filters.priorities[lv.priority] !== false;
    });
  }

  function renderHeader() {
    $('#title').textContent = DATA.symbol + ' 日线关键价位';
    $('#asof').innerHTML = '截至 <strong>' + esc(DATA.as_of) + '</strong> · 末收 <strong>' +
      Number(DATA.last_close).toFixed(2) + '</strong>';
    $('#gen').textContent = '生成 ' + (DATA.generated_at || '—') + ' · ' + (DATA.source || '');
  }

  function renderState() {
    const st = DATA.state || {};
    const ma = st.ma_stack || {};
    const boll = st.boll || {};
    const macd = st.macd || {};
    const vrvp = st.vrvp || {};
    const items = [
      ['窗口', st.window || '—'],
      ['区间高/低', (st.window_high != null ? st.window_high : '—') + ' / ' + (st.window_low != null ? st.window_low : '—')],
      ['ATR14', st.atr14 != null ? st.atr14.toFixed(2) : '—'],
      ['RSI14', st.rsi14 != null ? String(st.rsi14) : '—'],
      ['布林', boll.mid != null ? ('中 ' + boll.mid + ' · 上 ' + boll.up + ' · 下 ' + boll.lo) : '—'],
      ['MACD', macd.macd != null ? (macd.macd + ' / 信号 ' + macd.signal + ' · ' + (macd.vs_signal || '')) : '—'],
      ['EMA20/50/200', [ma.ema20, ma.ema50, ma.ema200].map(function (x) {
        return x ? x.val : '—';
      }).join(' / ')],
      ['VRVP POC', vrvp.poc != null ? (vrvp.poc + ' · VA ' + vrvp.val + '–' + vrvp.vah) : '—'],
    ];
    $('#stateGrid').innerHTML = items.map(function (it) {
      return '<div class="state-item"><div class="k">' + esc(it[0]) + '</div><div class="v">' + esc(it[1]) + '</div></div>';
    }).join('');
  }

  function lineColor(kind, priority) {
    if (kind === 'resistance') return priority <= 1 ? 'rgba(240,113,120,0.95)' : 'rgba(240,113,120,0.45)';
    if (kind === 'support') return priority <= 1 ? 'rgba(127,217,154,0.95)' : 'rgba(127,217,154,0.45)';
    return 'rgba(240,198,116,0.9)';
  }

  function clearPriceLines() {
    if (!candleSeries) return;
    priceLines.forEach(function (pl) {
      try { candleSeries.removePriceLine(pl); } catch (e) { /* ignore */ }
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
        lineStyle: lv.kind === 'anchor' ? LightweightCharts.LineStyle.Solid :
          (lv.priority <= 1 ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed),
        axisLabelVisible: lv.priority <= 1 || lv.kind === 'anchor',
        title: KIND_LABEL[lv.kind] + ' ' + lv.price,
      });
      priceLines.push(pl);
    });
  }

  function buildChart() {
    const el = $('#chart');
    el.innerHTML = '';
    chart = LightweightCharts.createChart(el, {
      layout: {
        background: { type: 'solid', color: '#0e141c' },
        textColor: '#8b9bb0',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(36,48,65,0.6)' },
        horzLines: { color: 'rgba(36,48,65,0.6)' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#243041' },
      timeScale: {
        borderColor: '#243041',
        timeVisible: false,
        rightOffset: 4,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: '#7fd99a',
      downColor: '#f07178',
      borderUpColor: '#7fd99a',
      borderDownColor: '#f07178',
      wickUpColor: '#7fd99a',
      wickDownColor: '#f07178',
    });

    let candles = [];
    if (DATA.ohlcv && DATA.ohlcv.length) {
      candles = DATA.ohlcv.map(function (b) {
        return {
          time: toUnix(b.date),
          open: b.open, high: b.high, low: b.low, close: b.close,
        };
      });
    } else if (DATA.price_series && DATA.price_series.length) {
      // close-only fallback as flat candles
      candles = DATA.price_series.map(function (b) {
        const c = b.close;
        return { time: toUnix(b.date), open: c, high: c, low: c, close: c };
      });
    }
    candleSeries.setData(candles);
    applyPriceLines();
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(function () {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }

  function renderLevelsTable() {
    const rows = visibleLevels().slice().sort(function (a, b) { return b.price - a.price; });
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>价位</th><th>距现价</th><th>类型</th><th>优先级</th><th>角色 / 来源</th>',
      '</tr></thead><tbody>'];
    rows.forEach(function (lv) {
      const dist = lv.dist_pct;
      const distStr = (dist >= 0 ? '+' : '') + Number(dist).toFixed(2) + '%';
      html.push('<tr>',
        '<td><strong>' + lv.price.toFixed(2) + '</strong></td>',
        '<td class="' + (dist >= 0 ? 'pos' : 'neg') + '">' + distStr + '</td>',
        '<td class="' + KIND_CLASS[lv.kind] + '">' + KIND_LABEL[lv.kind] + '</td>',
        '<td><span class="badge p' + lv.priority + '">' + (PRI_LABEL[lv.priority] || lv.priority) + '</span></td>',
        '<td>' + esc(lv.role) +
          (lv.sources && lv.sources.length ? '<div class="muted" style="margin-top:2px">' + esc(lv.sources.join(' · ')) + '</div>' : '') +
        '</td>',
        '</tr>');
    });
    html.push('</tbody></table></div>');
    $('#levelsTable').innerHTML = html.join('');

    // bands
    const bands = (DATA.key_bands || []).filter(function (b) {
      return filters.kinds[b.kind];
    });
    const bh = ['<div class="table-wrap" style="margin-top:10px"><table><thead><tr>',
      '<th>关键带</th><th>区间</th><th>类型</th></tr></thead><tbody>'];
    bands.forEach(function (b) {
      const rng = b.lo === b.hi ? String(b.lo) : (b.lo + ' – ' + b.hi);
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
    $('#holdDef').textContent = def;

    const os = hold.overall_support || {};
    const or_ = hold.overall_resistance || {};
    $('#holdKpi').innerHTML = [
      kpi('支撑守住率', pct(os.hit_rate), 'n=' + (os.n || 0) + ' · 守住 ' + (os.held || 0)),
      kpi('压力守住率', pct(or_.hit_rate), 'n=' + (or_.n || 0) + ' · 守住 ' + (or_.held || 0)),
      kpi('事件总数', String(hold.n_events || 0), (bt.definitions && bt.definitions.window) || ''),
    ].join('');

    const fam = hold.by_family || {};
    const keys = Object.keys(fam).sort();
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>族</th><th>侧</th><th>n</th><th>守住</th><th>命中率</th></tr></thead><tbody>'];
    keys.forEach(function (k) {
      const f = fam[k];
      html.push('<tr><td>' + esc(f.family || k) + '</td>',
        '<td class="' + (f.side === 'support' ? 'kind-sup' : 'kind-res') + '">' +
          (f.side === 'support' ? '支撑' : '压力') + '</td>',
        '<td>' + f.n + '</td><td>' + f.held + '</td>',
        '<td><strong>' + pct(f.hit_rate) + '</strong></td></tr>');
    });
    html.push('</tbody></table></div>');
    $('#holdTable').innerHTML = html.join('');
  }

  function kpi(label, value, sub) {
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' +
      value + '</div><div class="sub">' + esc(sub || '') + '</div></div>';
  }

  function renderBreakTab() {
    const bt = DATA.backtest || {};
    const br = bt.breakout || {};
    const def = (bt.definitions && bt.definitions.break_def_zh) || '';
    $('#breakDef').textContent = def;
    const sum = br.summary || {};
    const up = sum.up || {};
    const dn = sum.down || {};
    function hCard(dir, h) {
      const s = (dir === 'up' ? up : dn)[h] || {};
      return kpi(
        (dir === 'up' ? '向上突破' : '向下突破') + ' +' + h + 'd 中位',
        '<span class="' + clsRet(s.median) + '">' + pctPts(s.median) + '</span>',
        '均值 ' + pctPts(s.mean) + ' · 胜率 ' + pct(s.win_rate) + ' · n=' + (s.n || 0)
      );
    }
    $('#breakKpi').innerHTML = [
      hCard('up', 1), hCard('up', 3), hCard('up', 5),
      hCard('down', 1), hCard('down', 3), hCard('down', 5),
    ].join('');

    const fam = br.by_family_h5 || {};
    const keys = Object.keys(fam).sort();
    const html = ['<div class="table-wrap"><table><thead><tr>',
      '<th>族</th><th>方向</th><th>n</th><th>中位+5d</th><th>均值</th><th>胜率</th><th>P25–P75</th>',
      '</tr></thead><tbody>'];
    keys.forEach(function (k) {
      const f = fam[k];
      html.push('<tr><td>' + esc(f.family || k) + '</td>',
        '<td>' + (f.dir === 'up' ? '向上' : '向下') + '</td>',
        '<td>' + f.n + '</td>',
        '<td class="' + clsRet(f.median) + '"><strong>' + pctPts(f.median) + '</strong></td>',
        '<td class="' + clsRet(f.mean) + '">' + pctPts(f.mean) + '</td>',
        '<td>' + pct(f.win_rate) + '</td>',
        '<td class="muted">' + pctPts(f.p25) + ' ~ ' + pctPts(f.p75) + '</td></tr>');
    });
    html.push('</tbody></table></div>');
    $('#breakTable').innerHTML = html.join('');

    function exTable(list, title) {
      if (!list || !list.length) return '';
      let h = '<h2 style="margin-top:14px">' + esc(title) + '</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>日期</th><th>族</th><th>价位</th><th>收盘</th><th>+1d</th><th>+3d</th><th>+5d</th></tr></thead><tbody>';
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
      exTable(br.examples_up, '近期向上突破样例') +
      exTable(br.examples_down, '近期向下突破样例');
  }

  function bindToggles() {
    document.querySelectorAll('[data-kind]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.getAttribute('data-kind');
        filters.kinds[k] = !filters.kinds[k];
        btn.classList.toggle('on', filters.kinds[k]);
        applyPriceLines();
        renderLevelsTable();
      });
    });
    document.querySelectorAll('[data-pri]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const p = Number(btn.getAttribute('data-pri'));
        filters.priorities[p] = !filters.priorities[p];
        btn.classList.toggle('on', !!filters.priorities[p]);
        applyPriceLines();
        renderLevelsTable();
      });
    });
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const id = tab.getAttribute('data-tab');
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
        document.querySelectorAll('.tab-pane').forEach(function (p) {
          p.classList.toggle('active', p.id === 'pane-' + id);
        });
      });
    });
  }

  async function main() {
    try {
      DATA = await loadData();
    } catch (e) {
      $('#app').innerHTML = '<div class="disclaimer">无法加载 data.json：' + esc(e.message) + '</div>';
      return;
    }
    renderHeader();
    renderState();
    buildChart();
    renderLevelsTable();
    renderHoldTab();
    renderBreakTab();
    bindToggles();
    bindTabs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
