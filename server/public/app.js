// === utils ===
const fmtMoney = n => (n == null ? '-' : '$' + Number(n).toLocaleString());
const fmtNum   = n => (n == null ? '-' : Number(n).toLocaleString());
const fmtDate  = s => new Date(s).toLocaleDateString();

// Use build-time env if available, otherwise default to $500k in browser
const DEFAULT_MIN_BUY_USD = Number(
    (typeof process !== 'undefined' && process.env && process.env.MIN_BUY_USD) || 500000
);

// Provided for completeness; server should handle vl conversion
const dollarsToVl = (usd) => Math.max(0, Math.floor((Number(usd) || 0) / 1000));

// Sleep util for brief polling
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Read minBuy from input > URL > default
function getMinBuyUSD() {
    const el = document.getElementById('minBuy');
    const fromInput = el ? Number(el.value) : NaN;
    if (Number.isFinite(fromInput) && fromInput >= 0) return fromInput;

    const q = new URLSearchParams(location.search);
    const fromQuery = Number(q.get('minBuy'));
    if (Number.isFinite(fromQuery) && fromQuery >= 0) return fromQuery;

    return DEFAULT_MIN_BUY_USD || 500000;
}

// Initialize the input from URL/default (no-op if input not present)
(function initMinBuy() {
    const el = document.getElementById('minBuy');
    if (!el) return;
    const q = new URLSearchParams(location.search);
    const v = Number(q.get('minBuy'));
    el.value = Number.isFinite(v) && v >= 0 ? String(v) : String(DEFAULT_MIN_BUY_USD || 500000);
})();

function tradingViewLink(ticker) {
    return `https://www.tradingview.com/symbols/${ticker}/`;
}

// === data fetchers ===
async function getPricesForTickers(tickers) {
    const unique = [...new Set(tickers)];
    const priceMap = {};
    await Promise.all(unique.map(async (t) => {
        try {
            const res = await fetch(`/api/price/${encodeURIComponent(t)}?_=${Date.now()}`, { cache: 'no-store' });
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
    const url = '/api/score-bulk?tickers=' + encodeURIComponent(unique.join(',')) + `&_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ scores: [] }));
    const map = {};
    for (const s of (data?.scores ?? [])) if (s && s.ticker) map[s.ticker] = s;
    return map;
}

// Fetch helpers for trades/clusters with cache-busting
async function fetchTradesList(minBuy) {
    const url = '/api/trades?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}
async function fetchClustersList(minBuy) {
    const url = '/api/clusters?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

// Produce a quick signature of trades to detect changes (top N rows)
function tradesSignature(list, n = 30) {
    return (list || [])
        .slice(0, n)
        .map(r => `${r.ticker}|${r.filing_date}|${r.value_usd}`)
        .join('||');
}

// === score badge ===
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

// === clusters ===
async function loadClusters() {
    const minBuy = getMinBuyUSD();
    const data = await fetchClustersList(minBuy);
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

// === trades state + sort ===
let tradesCache = [];
let sortPctAsc = true; // toggle flag for % vs Buy

// Single, canonical row renderer (includes Links + Actions columns)
function renderTradeRow(t, prices, scores) {
    const curr = prices[t.ticker];
    const buy  = (t.price == null ? null : Number(t.price));
    const pct  = (curr != null && buy != null && buy > 0) ? ((curr - buy) / buy) * 100 : null;

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

    return `
    <tr>
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy == null ? '-' : buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr == null ? '-' : curr.toFixed(2)}</td>
      <td class="num ${pct == null ? '' : (pct >= 0 ? 'pos' : 'neg')}">${pct == null ? '-' : pct.toFixed(1) + '%'}</td>
      <td class="num" title="${bdTitle.replace(/"/g,'&quot;')}">${scoreBadge(scVal)}</td>
      <td>
        <a class="link" href="${t.source_url}" target="_blank" rel="noreferrer">Form 4</a> |
        <a class="link" href="${tradingViewLink(t.ticker)}" target="_blank" rel="noreferrer">Chart</a>
      </td>
      <td>
        <button class="btn" onclick="loadSummary('${t.ticker}')">AI Summary</button>
      </td>
    </tr>
  `;
}

// Render with current sort & caches
function renderTrades(prices, scores) {
    const tbody = document.querySelector('#trades tbody');
    let trades = [...tradesCache];

    // apply % vs Buy sort
    trades.sort((a, b) => {
        const currA = prices[a.ticker], buyA = Number(a.price);
        const pctA = (currA && buyA) ? ((currA - buyA)/buyA)*100 : -Infinity;

        const currB = prices[b.ticker], buyB = Number(b.price);
        const pctB = (currB && buyB) ? ((currB - buyB)/buyB)*100 : -Infinity;

        return sortPctAsc ? pctA - pctB : pctB - pctA;
    });

    tbody.innerHTML = trades.map(t => renderTradeRow(t, prices, scores)).join('');
}

// Fetch and render trades
async function loadTrades() {
    const minBuy = getMinBuyUSD();
    tradesCache = await fetchTradesList(minBuy);

    const tickers = tradesCache.map(r => r.ticker);
    const [prices, scores] = await Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]);

    renderTrades(prices, scores);
}

// Click to toggle % vs Buy sort and re-render
document.getElementById('sort-pct')?.addEventListener('click', () => {
    sortPctAsc = !sortPctAsc;
    const tickers = tradesCache.map(r => r.ticker);
    Promise.all([
        getPricesForTickers(tickers),
        getScoresForTickers(tickers)
    ]).then(([prices, scores]) => renderTrades(prices, scores));
});

// AI summary action
async function loadSummary(ticker) {
    try {
        const res = await fetch(`/api/summary/${ticker}?_=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.error) {
            alert(`Error: ${data.error}`);
        } else {
            alert(`${ticker} Summary:\n\n${data.summary}`);
        }
    } catch (err) {
        console.error(err);
        alert("Failed to load summary");
    }
}

// Poll until trades change after trigger (handles async backend jobs)
async function refreshAfterTrigger(minBuy) {
    const before = await fetchTradesList(minBuy);
    const beforeSig = tradesSignature(before);

    // Try up to 10 times with 800ms delay (~8s max)
    for (let i = 0; i < 10; i++) {
        await sleep(800);
        const now = await fetchTradesList(minBuy);
        const nowSig = tradesSignature(now);
        if (nowSig !== beforeSig) {
            tradesCache = now;
            const tickers = tradesCache.map(r => r.ticker);
            const [prices, scores] = await Promise.all([
                getPricesForTickers(tickers),
                getScoresForTickers(tickers)
            ]);
            renderTrades(prices, scores);
            // also refresh clusters
            const clusters = await fetchClustersList(minBuy);
            const wrap = document.getElementById('clusters');
            wrap.innerHTML = '';
            for (const c of clusters) {
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
            return true;
        }
    }
    // Fallback: hard refresh if no diff detected
    await loadClusters();
    await loadTrades();
    return false;
}

// Run Now button
document.getElementById('trigger')?.addEventListener('click', async () => {
    const btn = document.getElementById('trigger');
    const status = document.getElementById('status');
    const minBuy = getMinBuyUSD();

    btn.disabled = true; btn.textContent = 'Running…'; status.textContent = '';

    try {
        // Kick off server job with minBuy and cache-bust param
        const res = await fetch('/api/trigger?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(await res.text());

        // Poll until trades actually change, then render
        const updated = await refreshAfterTrigger(minBuy);
        status.textContent = updated ? 'Refreshed.' : 'No changes.';
    } catch (e) {
        console.error(e);
        status.textContent = 'Failed.';
    } finally {
        btn.disabled = false; btn.textContent = 'Run Now';
        setTimeout(()=> status.textContent='', 2500);
    }
});

// Enter-to-refresh for minBuy input if present
document.getElementById('minBuy')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        loadClusters();
        loadTrades();
    }
});

// initial load
(async () => {
    await loadClusters();
    await loadTrades();
})();
