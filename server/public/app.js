const fmtMoney = n => (n==null?'-': '$' + Number(n).toLocaleString());
const fmtNum   = n => (n==null?'-': Number(n).toLocaleString());
const fmtDate  = s => new Date(s).toLocaleDateString();

async function getPricesForTickers(tickers) {
    const unique = [...new Set(tickers)];
    const priceMap = {};
    await Promise.all(unique.map(async (t) => {
        try {
            const res = await fetch(`/api/price/${encodeURIComponent(t)}`);
            if (!res.ok) throw new Error(await res.text());
            const p = await res.json();
            priceMap[t] = Number(p.close);
        } catch {
            priceMap[t] = null;
        }
    }));
    return priceMap;
}

async function getScoresForTickers(tickers) {
    const unique = [...new Set(tickers)];
    if (unique.length === 0) return {};
    const url = '/api/score-bulk?tickers=' + encodeURIComponent(unique.join(','));
    const res = await fetch(url);
    const data = await res.json().catch(() => ({ scores: [] }));
    const map = {};
    for (const s of (data?.scores ?? [])) if (s && s.ticker) map[s.ticker] = s;
    return map;
}

function scoreBadge(score) {
    if (score == null || Number.isNaN(Number(score))) {
        return `<span class="score-badge score-neutral">-</span>`;
    }
    const n = Number(score);
    let cls = 'score-weak';
    if (n >= 80) cls = 'score-strong';
    else if (n >= 65) cls = 'score-good';
    else if (n >= 50) cls = 'score-neutral';
    return `<span class="score-badge ${cls}" title="Conviction Score">${n}</span>`;
}

async function loadTrades() {
    const res = await fetch('/api/trades');
    const data = await res.json();

    const tickers = data.map(r => r.ticker);
    const [prices, scores] = await Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]);

    const tbody = document.querySelector('#trades tbody');
    tbody.innerHTML = '';

    for (const t of data) {
        const curr = prices[t.ticker];
        const buy  = (t.price==null? null : Number(t.price));
        const pct  = (curr!=null && buy!=null && buy>0) ? ((curr - buy) / buy) * 100 : null;

        const scObj = scores[t.ticker];
        const scVal = scObj?.score ?? null;
        const bd    = scObj?.breakdown ?? null;
        const bdTitle = bd
            ? `Insider: ${Number(bd.insider).toFixed?.(0) || bd.insider}
Cluster: ${Number(bd.cluster).toFixed?.(0) || bd.cluster}
Valuation: ${Number(bd.valuation).toFixed?.(0) || bd.valuation}
Momentum: ${Number(bd.momentum).toFixed?.(0) || bd.momentum}
Liquidity: ${Number(bd.liquidity).toFixed?.(0) || bd.liquidity}`
            : 'No breakdown';

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy==null?'-':buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr==null?'-':curr.toFixed(2)}</td>
      <td class="num ${pct==null?'':(pct>=0?'pos':'neg')}">${pct==null?'-':pct.toFixed(1)+'%'}</td>
      <td class="num" title="${bdTitle.replace(/"/g,'&quot;')}">${scoreBadge(scVal)}</td>
      <td><a class="link" href="${t.source_url}" target="_blank" rel="noreferrer">Open Form 4</a></td>
    `;
        tbody.appendChild(tr);
    }
}

// clusters unchanged, but keep here to ensure page loads:
async function loadClusters() {
    const res = await fetch('/api/clusters');
    const data = await res.json();
    const wrap = document.getElementById('clusters');
    wrap.innerHTML = '';
    for (const c of data) {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="ticker">${c.ticker}</div>
          <div class="meta">${fmtDate(c.window_start)} → ${fmtDate(c.window_end)}</div>
        </div>
        <div class="right">
          <div>Insiders: <span class="pill">${c.insider_count}</span></div>
          <div>Trades: ${c.trade_count}</div>
          <div>Total: <b>${fmtMoney(c.total_value_usd)}</b></div>
        </div>
      </div>`;
        wrap.appendChild(card);
    }
}

// Run Now button
document.getElementById('trigger').addEventListener('click', async () => {
    const btn = document.getElementById('trigger');
    const status = document.getElementById('status');
    btn.disabled = true; btn.textContent = 'Running…'; status.textContent = '';
    try {
        const res = await fetch('/api/trigger');
        if (!res.ok) throw new Error(await res.text());
        status.textContent = 'Refreshed.';
    } catch {
        status.textContent = 'Failed.';
    } finally {
        await loadClusters();
        await loadTrades();
        btn.disabled = false; btn.textContent = 'Run Now';
        setTimeout(()=> status.textContent='', 2500);
    }
});

// Initial load
(async () => {
    await loadClusters();
    await loadTrades();
})();


function tradingViewLink(ticker) {
    return `https://www.tradingview.com/symbols/${ticker}/`;
}

function renderTradeRow(t, prices, scores) {
    const curr = prices[t.ticker];
    const buy  = (t.price==null? null : Number(t.price));
    const pct  = (curr!=null && buy!=null && buy>0) ? ((curr - buy) / buy) * 100 : null;

    const scObj = scores[t.ticker];
    const scVal = scObj?.score ?? null;
    const bd    = scObj?.breakdown ?? null;
    const bdTitle = bd
        ? `Insider: ${bd.insider}\nCluster: ${bd.cluster}\nValuation: ${bd.valuation}\nMomentum: ${bd.momentum}\nLiquidity: ${bd.liquidity}`
        : 'No breakdown';

    return `
    <tr>
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy==null?'-':buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr==null?'-':curr.toFixed(2)}</td>
      <td class="num ${pct==null?'':(pct>=0?'pos':'neg')}">${pct==null?'-':pct.toFixed(1)+'%'}</td>
      <td class="num" title="${bdTitle.replace(/"/g,'&quot;')}">${scoreBadge(scVal)}</td>
      <td><a class="link" href="${t.source_url}" target="_blank" rel="noreferrer">Open Form 4</a></td>
      <td><a class="link" href="${tradingViewLink(t.ticker)}" target="_blank" rel="noreferrer">View Chart</a></td>
    </tr>
  `;
}

async function loadTrades() {
    const res = await fetch('/api/trades');
    const data = await res.json();

    const tickers = data.map(r => r.ticker);
    const [prices, scores] = await Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]);

    const tbody = document.querySelector('#trades tbody');
    tbody.innerHTML = data.map(t => renderTradeRow(t, prices, scores)).join('');
}

let tradesCache = [];
let sortPctAsc = true; // toggle flag

function renderTradeRow(t, prices, scores) {
    const curr = prices[t.ticker];
    const buy  = (t.price==null? null : Number(t.price));
    const pct  = (curr!=null && buy!=null && buy>0) ? ((curr - buy) / buy) * 100 : null;

    const scObj = scores[t.ticker];
    const scVal = scObj?.score ?? null;
    const bd    = scObj?.breakdown ?? null;
    const bdTitle = bd
        ? `Insider: ${bd.insider}\nCluster: ${bd.cluster}\nValuation: ${bd.valuation}\nMomentum: ${bd.momentum}\nLiquidity: ${bd.liquidity}`
        : 'No breakdown';

    return `
    <tr>
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy==null?'-':buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr==null?'-':curr.toFixed(2)}</td>
      <td class="num ${pct==null?'':(pct>=0?'pos':'neg')}">${pct==null?'-':pct.toFixed(1)+'%'}</td>
      <td class="num" title="${bdTitle.replace(/"/g,'&quot;')}">${scoreBadge(scVal)}</td>
      <td><a class="link" href="${t.source_url}" target="_blank" rel="noreferrer">Open Form 4</a></td>
      <td><a class="link" href="${tradingViewLink(t.ticker)}" target="_blank" rel="noreferrer">View Chart</a></td>
    </tr>
  `;
}

async function loadTrades() {
    const res = await fetch('/api/trades');
    tradesCache = await res.json();

    const tickers = tradesCache.map(r => r.ticker);
    const [prices, scores] = await Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]);

    renderTrades(prices, scores);
}

function renderTrades(prices, scores) {
    const tbody = document.querySelector('#trades tbody');

    // Sort if requested
    let trades = [...tradesCache];
    if (sortPctAsc != null) {
        trades.sort((a, b) => {
            const currA = prices[a.ticker], buyA = Number(a.price);
            const pctA = (currA && buyA) ? ((currA - buyA)/buyA)*100 : -Infinity;

            const currB = prices[b.ticker], buyB = Number(b.price);
            const pctB = (currB && buyB) ? ((currB - buyB)/buyB)*100 : -Infinity;

            return sortPctAsc ? pctA - pctB : pctB - pctA;
        });
    }

    tbody.innerHTML = trades.map(t => renderTradeRow(t, prices, scores)).join('');
}

// Event handler for sorting
document.getElementById('sort-pct').addEventListener('click', () => {
    sortPctAsc = !sortPctAsc;
    // reload with current cached data
    const tickers = tradesCache.map(r => r.ticker);
    Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]).then(([prices, scores]) => {
        renderTrades(prices, scores);
    });
});

