"use strict";

/* ========= utils ========= */
const $ = (id) => document.getElementById(id);
const fmtMoney = n => (n == null ? '-' : '$' + Number(n).toLocaleString());
const fmtNum   = n => (n == null ? '-' : Number(n).toLocaleString());
const fmtDate  = s => (s ? new Date(s).toLocaleDateString() : '-');
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

const DEFAULT_MIN_BUY_USD = Number(
    (typeof process !== 'undefined' && process.env && process.env.MIN_BUY_USD) || 500000
);

function setStatus(msg, isError = false) {
    const el = $('status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = isError ? '#c00' : '#555';
}

function getMinBuyUSD() {
    const el = document.getElementById('minBuy');

    // If input is empty, do NOT coerce to 0
    const raw = el ? String(el.value ?? '').trim() : '';
    if (raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n; // user provided a number (including 0)
    }

    // Next: URL query ?minBuy=...
    const qs = new URLSearchParams(location.search);
    const qRaw = String(qs.get('minBuy') ?? '').trim();
    if (qRaw !== '') {
        const qn = Number(qRaw);
        if (Number.isFinite(qn) && qn >= 0) return qn;
    }

    // Fallback default
    return Number((typeof process !== 'undefined' && process.env && process.env.MIN_BUY_USD) || 500000);
}


// init minBuy input if present
(function initMinBuy() {
    const el = document.getElementById('minBuy');
    if (!el) return;
    const qs = new URLSearchParams(location.search);
    const qRaw = String(qs.get('minBuy') ?? '').trim();
    if (qRaw !== '') {
        el.value = qRaw; // honor URL if provided
    } else {
        // default to 500k
        el.value = String(Number((typeof process !== 'undefined' && process.env && process.env.MIN_BUY_USD) || 500000));
    }
})();

// basic error guards so one failure doesn’t blank the whole page
window.addEventListener('error', e => setStatus(`Error: ${e.message}`, true));
window.addEventListener('unhandledrejection', e => setStatus(`Request failed`, true));

function tradingViewLink(ticker) {
    return `https://www.tradingview.com/symbols/${ticker}/`;
}

/* ========= data fetchers ========= */
async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0,120)}`);
    }
    // in case server sent empty body
    const txt = await res.text();
    if (!txt) return null;
    try {
        return JSON.parse(txt);
    } catch {
        throw new Error('Invalid JSON from server');
    }
}

async function getPricesForTickers(tickers) {
    const unique = [...new Set(tickers)];
    const map = {};
    await Promise.all(unique.map(async t => {
        try {
            const j = await fetchJSON(`/api/price/${encodeURIComponent(t)}?_=${Date.now()}`);
            map[t] = Number(j?.close);
        } catch {
            map[t] = null;
        }
    }));
    return map;
}

async function getScoresForTickers(tickers) {
    const unique = [...new Set(tickers)];
    if (!unique.length) return {};
    const j = await fetchJSON('/api/score-bulk?tickers=' + encodeURIComponent(unique.join(',')) + `&_=${Date.now()}`)
        .catch(() => ({ scores: [] }));
    const map = {};
    for (const s of (j?.scores ?? [])) if (s && s.ticker) map[s.ticker] = s;
    return map;
}

async function fetchTradesList(minBuy) {
    return fetchJSON('/api/trades?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`);
}
async function fetchClustersList(minBuy) {
    return fetchJSON('/api/clusters?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`);
}

function tradesSignature(list, n = 50) {
    return (list || [])
        .slice(0, n)
        .map(r => `${r?.ticker}|${r?.filing_date}|${r?.value_usd}|${r?.insider_name}`)
        .join('||');
}

/* ========= clusters ========= */
async function loadClusters() {
    const minBuy = getMinBuyUSD();
    try {
        const data = await fetchClustersList(minBuy) || [];
        const wrap = $('clusters');
        if (!wrap) return;
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
    } catch (e) {
        setStatus(`Clusters failed: ${e.message}`, true);
    }
}

/* ========= trades ========= */
let tradesCache = [];
let sortPctAsc = true;
let lastTradesSig = '';

function scoreBadge(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return `<span class="score-badge score-neutral">-</span>`;
    let cls = 'score-weak';
    if (n >= 80) cls = 'score-strong';
    else if (n >= 65) cls = 'score-good';
    else if (n >= 50) cls = 'score-neutral';
    return `<span class="score-badge ${cls}" title="Conviction Score">${n}</span>`;
}

function renderTradeRow(t, prices, scores) {
    const curr = prices[t.ticker];
    const buy  = (t.price == null ? null : Number(t.price));
    const pct  = (curr != null && buy != null && buy > 0) ? ((curr - buy) / buy) * 100 : null;

    const scObj = scores[t.ticker];
    const scVal = scObj?.score ?? null;
    const bd    = scObj?.breakdown ?? null;
    const safeNum0 = (x) => (x == null ? '-' : Number(x).toFixed(0));
    const bdTitle = bd
        ? `Insider: ${safeNum0(bd.insider)}
Cluster: ${safeNum0(bd.cluster)}
Valuation: ${safeNum0(bd.valuation)}
Momentum: ${safeNum0(bd.momentum)}
Liquidity: ${safeNum0(bd.liquidity)}`
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

function renderTrades(prices, scores) {
    const tbody = document.querySelector('#trades tbody');
    if (!tbody) return;

    let trades = Array.isArray(tradesCache) ? [...tradesCache] : [];

    trades.sort((a, b) => {
        const currA = prices[a.ticker], buyA = Number(a.price);
        const pctA = (Number.isFinite(currA) && Number.isFinite(buyA) && buyA > 0) ? ((currA - buyA)/buyA)*100 : -Infinity;

        const currB = prices[b.ticker], buyB = Number(b.price);
        const pctB = (Number.isFinite(currB) && Number.isFinite(buyB) && buyB > 0) ? ((currB - buyB)/buyB)*100 : -Infinity;

        return sortPctAsc ? pctA - pctB : pctB - pctA;
    });

    tbody.innerHTML = trades.map(t => renderTradeRow(t, prices, scores)).join('');
}

async function loadTrades() {
    const minBuy = getMinBuyUSD();
    try {
        const list = await fetchTradesList(minBuy);
        tradesCache = Array.isArray(list) ? list : [];
        lastTradesSig = tradesSignature(tradesCache);

        const tickers = tradesCache.map(r => r.ticker);
        const [prices, scores] = await Promise.allSettled([
            getPricesForTickers(tickers),
            getScoresForTickers(tickers)
        ]);

        const priceMap = prices.status === 'fulfilled' ? prices.value : {};
        const scoreMap = scores.status === 'fulfilled' ? scores.value : {};

        renderTrades(priceMap, scoreMap);
    } catch (e) {
        setStatus(`Trades failed: ${e.message}`, true);
        const tbody = document.querySelector('#trades tbody');
        if (tbody) tbody.innerHTML = '';
    }
}

/* ========= interactions ========= */
$('sort-pct')?.addEventListener('click', async () => {
    sortPctAsc = !sortPctAsc;
    try {
        const tickers = tradesCache.map(r => r.ticker);
        const [prices, scores] = await Promise.allSettled([
            getPricesForTickers(tickers),
            getScoresForTickers(tickers)
        ]);
        renderTrades(
            prices.status === 'fulfilled' ? prices.value : {},
            scores.status === 'fulfilled' ? scores.value : {}
        );
    } catch {
        /* no-op */
    }
});

async function loadSummary(ticker) {
    try {
        const j = await fetchJSON(`/api/summary/${ticker}?_=${Date.now()}`);
        if (j?.error) alert(`Error: ${j.error}`);
        else alert(`${ticker} Summary:\n\n${j?.summary || '(empty)'}`);
    } catch (e) {
        console.error(e);
        alert("Failed to load summary");
    }
}
window.loadSummary = loadSummary; // expose for onclick

async function waitForUpdatedTrades(minBuy) {
    // give the backend a moment to write rows
    const maxAttempts = 12;  // ~10s
    const delayMs = 800;

    for (let i = 0; i < maxAttempts; i++) {
        await sleep(delayMs);
        try {
            const fresh = await fetchTradesList(minBuy);
            const sig = tradesSignature(fresh);
            if (sig !== lastTradesSig) {
                tradesCache = Array.isArray(fresh) ? fresh : [];
                lastTradesSig = sig;

                const tickers = tradesCache.map(r => r.ticker);
                const [prices, scores] = await Promise.allSettled([
                    getPricesForTickers(tickers),
                    getScoresForTickers(tickers)
                ]);
                renderTrades(
                    prices.status === 'fulfilled' ? prices.value : {},
                    scores.status === 'fulfilled' ? scores.value : {}
                );

                // refresh clusters too
                const clusters = await fetchClustersList(minBuy).catch(() => []);
                const wrap = $('clusters');
                if (wrap) {
                    wrap.innerHTML = '';
                    for (const c of (clusters || [])) {
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
                return true;
            }
        } catch {
            // keep polling
        }
    }
    return false;
}

$('trigger')?.addEventListener('click', async () => {
    const btn = $('trigger');
    btn.disabled = true; btn.textContent = 'Running…'; setStatus('');
    const minBuy = getMinBuyUSD();

    try {
        await fetchJSON('/api/trigger?minBuy=' + encodeURIComponent(minBuy) + `&_=${Date.now()}`);
    } catch (e) {
        // Even if the trigger endpoint returns before the job finishes (or 500s),
        // we’ll still try to reload what’s available.
        console.warn('Trigger call error:', e.message);
    }

    // Try to detect real data changes, then render
    const updated = await waitForUpdatedTrades(minBuy);
    setStatus(updated ? 'Refreshed.' : 'No new changes.');

    // As a fallback, do a regular refresh too
    await loadClusters();
    await loadTrades();

    btn.disabled = false; btn.textContent = 'Run Now';
    setTimeout(() => setStatus(''), 2500);
});

// Enter in minBuy input triggers reload
$('minBuy')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        loadClusters();
        loadTrades();
    }
});

/* ========= initial load ========= */
(async () => {
    await loadClusters();
    await loadTrades();
})();


fetch('/api/trades?minBuy='   + minBuy + '&_=' + Date.now(), { cache: 'no-store' })
fetch('/api/clusters?minBuy=' + minBuy + '&_=' + Date.now(), { cache: 'no-store' })
fetch('/api/trigger?minBuy='  + minBuy + '&_=' + Date.now(), { cache: 'no-store' })
