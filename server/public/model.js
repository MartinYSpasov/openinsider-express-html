import { } from './utils.js'; // (optional if you add utilities later)

// Helpers
const $ = (sel) => document.querySelector(sel);
const qs = (key, def) => new URLSearchParams(location.search).get(key) ?? def;
const fmtPct = (x) => (x == null ? '—' : (x*100).toFixed(2) + '%');
const today = () => new Date().toISOString().slice(0,10);

// Elements
const form = $('#form');
const elTicker = $('#ticker');
const elStart  = $('#start');
const elEnd    = $('#end');
const elBack   = $('#backtest');

const elSignal = $('#signalValue');
const elBadge  = $('#signalBadge');
const elAsof   = $('#asof');
const elModel  = $('#modelName');
const elCvS    = $('#cvSplits');
const elCvMAE  = $('#cvMAE');
const elCvMSE  = $('#cvMSE');
const elCvR2   = $('#cvR2');

const elBt    = $('#backtestPanel');
const elCAGR  = $('#btCAGR');
const elSharpe= $('#btSharpe');
const elMaxDD = $('#btMaxDD');
const elTradesTbl = $('#tradesTbl').querySelector('tbody');

let priceChart, predChart;

function colorBadge(v, thr=0.0015){
    elBadge.classList.remove('long','short','neutral');
    if (v == null) { elBadge.classList.add('neutral'); elBadge.textContent='NEUTRAL'; return; }
    if (v >= thr) { elBadge.classList.add('long'); elBadge.textContent='LONG BIAS'; return; }
    if (v <= -thr) { elBadge.classList.add('short'); elBadge.textContent='SHORT BIAS'; return; }
    elBadge.classList.add('neutral'); elBadge.textContent='FLAT/UNCLEAR';
}

async function fetchJSON(url, opts){
    const r = await fetch(url, opts);
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
}

async function run(){
    const ticker = (elTicker.value || 'AAPL').toUpperCase();
    const start = elStart.value || '2016-01-01';
    const end   = elEnd.value   || today();
    const backtest = elBack.checked;

    // Model predict
    const pred = await fetchJSON(`/api/model/predict/${ticker}?start=${start}&end=${end}&backtest=${backtest}`);
    // OHLC for overlay
    const ohlc = await fetchJSON(`/api/ohlc/${ticker}?start=${start}&end=${end}&interval=1d`);

    // Header + signal
    document.title = `Model — ${ticker}`;
    $('#title').textContent = `Model: ${ticker}`;
    elSignal.textContent = fmtPct(pred.next_day_pred_logret);
    colorBadge(pred.next_day_pred_logret);
    elAsof.textContent = pred.asof || '—';
    elModel.textContent = pred?.cv?.Model || '—';

    elCvS.textContent   = pred?.cv?.Splits ?? '—';
    elCvMAE.textContent = (pred?.cv?.CV_MAE != null) ? (+pred.cv.CV_MAE).toFixed(4) : '—';
    elCvMSE.textContent = (pred?.cv?.CV_MSE != null) ? (+pred.cv.CV_MSE).toFixed(6) : '—';
    elCvR2.textContent  = (pred?.cv?.CV_R2  != null) ? (+pred.cv.CV_R2).toFixed(3)  : '—';

    // Charts
    const priceLabels = ohlc.rows.map(r => r.date);
    const closes = ohlc.rows.map(r => r.close);

    const predLabels = (pred.recent_predictions ?? []).map(p => p.date);
    const preds = (pred.recent_predictions ?? []).map(p => p.pred);

    // Price vs prediction (two y-axes)
    if (priceChart) priceChart.destroy();
    const ctx1 = document.getElementById('priceChart').getContext('2d');
    priceChart = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: priceLabels,
            datasets: [
                { label: `${ticker} Close`, data: closes, yAxisID: 'y', borderWidth: 1, tension: 0.2 },
                // map predictions onto the right axis, aligning labels where possible:
                { label: 'Pred (next-day logret)', data: priceLabels.map(d => {
                        const i = predLabels.indexOf(d);
                        return i >= 0 ? preds[i] : null;
                    }),
                    yAxisID: 'y1', borderWidth: 1, pointRadius: 0, tension: 0
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { type: 'linear', position: 'left', ticks: { callback: v => v.toFixed(2) } },
                y1:{ type: 'linear', position: 'right', grid:{ drawOnChartArea:false }, ticks: { callback: v => (v*100).toFixed(2)+'%' } },
                x: { ticks: { maxTicksLimit: 10 } }
            },
            plugins: { legend: { display: true } }
        }
    });

    // Recent pred chart
    if (predChart) predChart.destroy();
    const ctx2 = document.getElementById('predChart').getContext('2d');
    predChart = new Chart(ctx2, {
        type: 'bar',
        data: { labels: predLabels, datasets: [{ label:'Pred logret', data: preds }] },
        options: {
            responsive: true,
            plugins:{ legend:{ display:false } },
            scales:{
                y:{ ticks:{ callback: v => (v*100).toFixed(1)+'%' }, zero: true },
                x:{ ticks:{ maxTicksLimit: 10 } }
            }
        }
    });

    // Backtest
    if (backtest && pred.backtest?.metrics) {
        elBt.style.display = '';
        const m = pred.backtest.metrics;
        elCAGR.textContent  = fmtPct(m.CAGR);
        elSharpe.textContent= m.Sharpe?.toFixed?.(2) ?? '—';
        elMaxDD.textContent = fmtPct(m.MaxDrawdown);
        const trades = (pred.backtest.trades ?? []).slice(-20);
        elTradesTbl.innerHTML = trades.map(t => `
      <tr><td>${t.date || t.entry_date || ''}</td>
          <td>${t.side || ''}</td>
          <td>${t.price?.toFixed?.(2) ?? ''}</td>
          <td>${fmtPct(t.pnl || t.ret)}</td></tr>
    `).join('');
    } else {
        elBt.style.display = 'none';
    }
}

// Init with query params
(function init(){
    const t = (qs('ticker','AAPL') || 'AAPL').toUpperCase();
    elTicker.value = t;
    elStart.value = qs('start','2016-01-01');
    elEnd.value   = qs('end', new Date().toISOString().slice(0,10));
    elBack.checked = String(qs('backtest','false')).toLowerCase() === 'true';

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const params = new URLSearchParams({
            ticker: elTicker.value.toUpperCase(),
            start: elStart.value,
            end: elEnd.value,
            backtest: String(elBack.checked)
        });
        history.replaceState(null,'',`/model.html?${params.toString()}`);
        run().catch(err => alert(err.message));
    });

    run().catch(err => alert(err.message));
})();
