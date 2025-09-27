"use strict";

/* ========= tiny helpers ========= */
const $  = (id) => document.getElementById(id);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fmtMoney = (n) => (n == null ? "-" : "$" + Number(n).toLocaleString());
const fmtNum   = (n) => (n == null ? "-" : Number(n).toLocaleString());
const fmtDate  = (s) => (s ? new Date(s).toLocaleDateString() : "-");

function setStatus(msg, isError = false) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#c00" : "#555";
}

function tradingViewLink(ticker) {
    return `https://www.tradingview.com/symbols/${ticker}/`;
}

/* ========= min buy utils ========= */
function getMinBuyUSD() {
    const el = $("minBuy");
    const raw = el ? String(el.value ?? "").trim() : "";
    if (raw !== "") {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
    }
    const qs = new URLSearchParams(location.search);
    const qRaw = String(qs.get("minBuy") ?? "").trim();
    if (qRaw !== "") {
        const qn = Number(qRaw);
        if (Number.isFinite(qn) && qn >= 0) return qn;
    }
    return 500000; // default fallback
}

// init input from URL or default
(function initMinBuy() {
    const el = $("minBuy");
    if (!el) return;
    const qs = new URLSearchParams(location.search);
    const qRaw = String(qs.get("minBuy") ?? "").trim();
    el.value = qRaw !== "" ? qRaw : "500000";
})();

/* ========= global guards ========= */
window.addEventListener("error", (e) => setStatus(`Error: ${e.message}`, true));
window.addEventListener("unhandledrejection", (e) => {
    console.error(e.reason || e);
    setStatus("Request failed", true);
});

/* ========= generic fetcher ========= */
async function fetchJSON(url, opts) {
    const res = await fetch(url, { cache: "no-store", ...(opts||{}) });
    const txt = await res.text(); // handle empty
    if (!res.ok) {
        console.error("[fetchJSON]", url, "→", res.status, res.statusText, txt);
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${txt.slice(0, 160)}`);
    }
    if (!txt) return null;
    try { return JSON.parse(txt); }
    catch { throw new Error("Invalid JSON from server"); }
}

/* ========= backend calls ========= */
async function fetchTradesList(minBuy) {
    return fetchJSON(`/api/trades?minBuy=${encodeURIComponent(minBuy)}&_=${Date.now()}`);
}
async function fetchClustersList(minBuy) {
    return fetchJSON(`/api/clusters?minBuy=${encodeURIComponent(minBuy)}&_=${Date.now()}`);
}
async function getPricesForTickers(tickers) {
    const unique = [...new Set(tickers)];
    const map = {};
    await Promise.all(unique.map(async (t) => {
        try {
            const j = await fetchJSON(`/api/price/${encodeURIComponent(t)}?_=${Date.now()}`);
            map[t] = Number(j?.close);
        } catch { map[t] = null; }
    }));
    return map;
}
async function getScoresForTickers(tickers) {
    const unique = [...new Set(tickers)];
    if (!unique.length) return {};
    const j = await fetchJSON(`/api/score-bulk?tickers=${encodeURIComponent(unique.join(","))}&_=${Date.now()}`)
        .catch(() => ({ scores: [] }));
    const map = {};
    for (const s of (j?.scores ?? [])) if (s && s.ticker) map[s.ticker] = s;
    return map;
}

/* ========= clusters ========= */
/** Normalize row shape from DB to UI-friendly names */
function normalizeClusterRow(r = {}) {
    // ticker / symbol
    const ticker =
        r.ticker ?? r.symbol ?? r.sym ?? r.Ticker ?? r.Symbol ?? null;

    // window start / end
    const window_start =
        r.window_start ?? r.windowStart ?? r.start ?? r.window_begin ?? null;
    const window_end =
        r.window_end ?? r.windowEnd ?? r.end ?? r.window_finish ?? null;

    // counts
    const insider_count =
        r.insider_count ?? r.insiders ?? r.n_insiders ?? r.insidercnt ?? r.insiderCnt ?? null;
    const trade_count =
        r.trade_count ?? r.trades ?? r.n_trades ?? r.tradecnt ?? r.tradeCnt ?? null;

    // total dollars
    const total_value_usd =
        r.total_value_usd ?? r.total_usd ?? r.total_value ?? r.sum_value_usd ?? r.total ?? null;

    return { ticker, window_start, window_end, insider_count, trade_count, total_value_usd };
}

async function loadClusters() {
    const wrap = $("clusters");
    if (!wrap) return; // not on this page
    const minBuy = getMinBuyUSD();

    try {
        const raw = (await fetchClustersList(minBuy)) || [];
        // Accept {rows:[...]} or [...]
        const rows = Array.isArray(raw) ? raw : (Array.isArray(raw.rows) ? raw.rows : []);
        const data = rows.map(normalizeClusterRow).filter(c => !!c.ticker);

        wrap.innerHTML = "";

        if (!data.length) {
            // Friendly placeholder so it doesn't look "broken"
            const empty = document.createElement("div");
            empty.className = "card";
            empty.innerHTML = `
        <div class="card-head">
          <div>
            <div class="ticker">No cluster signals</div>
            <div class="meta">Try lowering the min buy filter or click “Run Now”.</div>
          </div>
        </div>`;
            wrap.appendChild(empty);
            return;
        }

        for (const c of data) {
            const card = document.createElement("div");
            card.className = "card";
            card.innerHTML = `
        <div class="card-head">
          <div>
            <div class="ticker">${c.ticker}</div>
            <div class="meta">${fmtDate(c.window_start)} → ${fmtDate(c.window_end)}</div>
          </div>
          <div class="right">
            <div>Insiders: <span class="pill">${fmtNum(c.insider_count)}</span></div>
            <div>Trades: ${fmtNum(c.trade_count)}</div>
            <div>Total: <b>${fmtMoney(c.total_value_usd)}</b></div>
          </div>
        </div>`;
            wrap.appendChild(card);
        }
    } catch (e) {
        console.error("[clusters] fetch/render failed:", e);
        setStatus(`Clusters failed: ${e.message}`, true);
        wrap.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <div class="ticker">Cluster load error</div>
            <div class="meta">Check /api/clusters in your browser console.</div>
          </div>
        </div>
      </div>`;
    }
}

/* ========= trades ========= */
let tradesCache = [];
let lastTradesSig = "";

const sortState = {
    key: "date",   // 'date' | 'pct'
    dateAsc: false,
    pctAsc: true,
};

function tradesSignature(list, n = 50) {
    return (list || [])
        .slice(0, n)
        .map(r => `${r?.ticker}|${r?.filing_date}|${r?.value_usd}|${r?.insider_name}`)
        .join("||");
}

function scoreBadge(score) {
    const n = Number(score);
    if (!Number.isFinite(n)) return `<span class="score-badge score-neutral">-</span>`;
    let cls = "score-weak";
    if (n >= 80) cls = "score-strong";
    else if (n >= 65) cls = "score-good";
    else if (n >= 50) cls = "score-neutral";
    return `<span class="score-badge ${cls}" title="Conviction Score">${n}</span>`;
}

function renderTradeRow(t, prices, scores) {
    const curr = prices[t.ticker];
    const buy  = (t.price == null ? null : Number(t.price));
    const pct  = (curr != null && buy != null && buy > 0) ? ((curr - buy) / buy) * 100 : null;

    const scObj = scores[t.ticker];
    const scVal = scObj?.score ?? null;
    const bd    = scObj?.breakdown ?? null;
    const safeNum0 = (x) => (x == null ? "-" : Number(x).toFixed(0));
    const bdTitle = bd
        ? `Insider: ${safeNum0(bd.insider)}
Cluster: ${safeNum0(bd.cluster)}
Valuation: ${safeNum0(bd.valuation)}
Momentum: ${safeNum0(bd.momentum)}
Liquidity: ${safeNum0(bd.liquidity)}`
        : "No breakdown";

    return `
    <tr>
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy == null ? "-" : buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr == null ? "-" : curr.toFixed(2)}</td>
      <td class="num ${pct == null ? "" : (pct >= 0 ? "pos" : "neg")}">${pct == null ? "-" : pct.toFixed(1) + "%"}</td>
      <td class="num" title="${bdTitle.replace(/"/g,"&quot;")}">${scoreBadge(scVal)}</td>
      <td>
        <a class="link" href="${tradingViewLink(t.ticker)}" target="_blank" rel="noreferrer">Chart</a>
      </td>
      <td>
        <button class="btn" onclick="loadSummary('${t.ticker}')">AI Summary</button>
        <button class="btn btn-secondary" onclick="predictTicker('${t.ticker}')">Predict</button>
      </td>
    </tr>
  `;
}

function renderTrades(prices, scores) {
    const tbody = document.querySelector("#trades tbody");
    if (!tbody) return;

    const trades = [...(Array.isArray(tradesCache) ? tradesCache : [])];

    trades.sort((a, b) => {
        if (sortState.key === "date") {
            const da = new Date(a.filing_date).getTime() || 0;
            const db = new Date(b.filing_date).getTime() || 0;
            return sortState.dateAsc ? (da - db) : (db - da);
        }
        // sort by % vs Buy
        const currA = prices[a.ticker], buyA = Number(a.price);
        const pctA = (Number.isFinite(currA) && Number.isFinite(buyA) && buyA > 0) ? ((currA - buyA)/buyA)*100 : -Infinity;
        const currB = prices[b.ticker], buyB = Number(b.price);
        const pctB = (Number.isFinite(currB) && Number.isFinite(buyB) && buyB > 0) ? ((currB - buyB)/buyB)*100 : -Infinity;
        return sortState.pctAsc ? (pctA - pctB) : (pctB - pctA);
    });

    tbody.innerHTML = trades.map(t => renderTradeRow(t, prices, scores)).join("");
}

async function loadTrades() {
    const table = $("#trades");
    if (!table) return; // not on this page
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

        const priceMap = prices.status === "fulfilled" ? prices.value : {};
        const scoreMap = scores.status === "fulfilled" ? scores.value : {};
        renderTrades(priceMap, scoreMap);
    } catch (e) {
        console.error("[trades] fetch/render failed:", e);
        setStatus(`Trades failed: ${e.message}`, true);
        const tbody = document.querySelector("#trades tbody");
        if (tbody) tbody.innerHTML = "";
    }
}

/* ========= interactions ========= */
$("sort-pct")?.addEventListener("click", async () => {
    sortState.key = "pct";
    sortState.pctAsc = !sortState.pctAsc;
    try {
        const tickers = tradesCache.map(r => r.ticker);
        const [prices, scores] = await Promise.allSettled([
            getPricesForTickers(tickers),
            getScoresForTickers(tickers)
        ]);
        renderTrades(
            prices.status === "fulfilled" ? prices.value : {},
            scores.status === "fulfilled" ? scores.value : {}
        );
    } catch { /* no-op */ }
});

// optional: sort by date if you wire a header id="sort-date"
$("sort-date")?.addEventListener("click", async () => {
    sortState.key = "date";
    sortState.dateAsc = !sortState.dateAsc;
    try {
        const tickers = tradesCache.map(r => r.ticker);
        const [prices, scores] = await Promise.allSettled([
            getPricesForTickers(tickers),
            getScoresForTickers(tickers)
        ]);
        renderTrades(
            prices.status === "fulfilled" ? prices.value : {},
            scores.status === "fulfilled" ? scores.value : {}
        );
    } catch { /* no-op */ }
});

async function loadSummary(ticker) {
    try {
        const j = await fetchJSON(`/api/summary/${encodeURIComponent(ticker)}?_=${Date.now()}`);
        if (j?.error) alert(`Error: ${j.error}`);
        else alert(`${ticker} Summary:\n\n${j?.summary || "(empty)"}`);
    } catch (e) {
        console.error(e);
        alert("Failed to load summary");
    }
}
window.loadSummary = loadSummary; // expose for onclick

async function waitForUpdatedTrades(minBuy) {
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
                    prices.status === "fulfilled" ? prices.value : {},
                    scores.status === "fulfilled" ? scores.value : {}
                );

                // refresh clusters too
                await loadClusters();
                return true;
            }
        } catch { /* keep polling */ }
    }
    return false;
}

$("trigger")?.addEventListener("click", async () => {
    const btn = $("trigger");
    if (!btn) return;
    btn.disabled = true; btn.textContent = "Running…"; setStatus("");
    const minBuy = getMinBuyUSD();

    try {
        await fetchJSON(`/api/trigger?minBuy=${encodeURIComponent(minBuy)}&_=${Date.now()}`);
    } catch (e) {
        console.warn("Trigger call error:", e.message);
    }

    const updated = await waitForUpdatedTrades(minBuy);
    setStatus(updated ? "Refreshed." : "No new changes.");

    // Fallback refresh
    await loadClusters();
    await loadTrades();

    btn.disabled = false; btn.textContent = "Run Now";
    setTimeout(() => setStatus(""), 2500);
});

$("minBuy")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        loadClusters();
        loadTrades();
    }
});

/* ========= model hooks (used by buttons on this page) ========= */
async function predictTicker(ticker) {
    try {
        setStatus(`Predicting ${ticker}...`);
        const end = new Date().toISOString().slice(0,10);
        const url = `/api/model/predict/${encodeURIComponent(ticker)}?start=2016-01-01&end=${end}&backtest=true`;
        const res = await fetch(url, { cache: "no-store" });
        const j   = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Predict failed");

        const p = j.next_day_pred_logret;
        const m = j.backtest?.metrics || {};
        const safe = (x, d=2) => (typeof x === "number" && isFinite(x) ? x.toFixed(d) : "n/a");

        alert(
            `Ticker: ${j.ticker}\n` +
            `As of: ${j.asof ?? "n/a"}\n` +
            `Next-day predicted log return: ${p == null ? "n/a" : Number(p).toFixed(5)}\n\n` +
            `Backtest:\n` +
            `  Sharpe: ${safe(m.Sharpe)}  CAGR: ${safe(m.CAGR)}  MaxDD: ${safe(m.MaxDD)}`
        );
        setStatus(`Prediction ready for ${ticker}`);
    } catch (e) {
        console.error(e);
        setStatus(`Prediction failed: ${e.message}`, true);
        alert(`Prediction failed: ${e.message}`);
    }
}
window.predictTicker = predictTicker; // ensure onclick works

async function runScreen() {
    const uniSel = $("screenUniverse");
    const nSel   = $("screenTopN");
    if (!uniSel || !nSel) return; // not on this page

    const universe = uniSel.value;
    const top_n    = Number(nSel.value || 20);
    setStatus(`Screening ${universe}...`);
    try {
        const payload = {
            universe,
            start: "2016-01-01",
            end: new Date().toISOString().slice(0,10),
            top_n
        };
        const res = await fetch("/api/model/screen/universe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Screen failed");
        renderScreenResults(j.ranking || []);
        setStatus(`Screen complete: ${universe}`);
    } catch (e) {
        console.error(e);
        setStatus(`Screen failed: ${e.message}`, true);
    }
}
window.runScreen = runScreen; // ensure onclick works

function renderScreenResults(rows) {
    const el = $("screenResults");
    if (!el) return;
    if (!rows?.length) { el.innerHTML = "<p>No results.</p>"; return; }
    const th = `<tr>
    <th>#</th><th>Ticker</th><th>Score</th><th>Sharpe</th><th>CAGR</th><th>IC</th><th>Turnover</th><th>Trades</th>
  </tr>`;
    const trs = rows.map((r,i)=>`<tr>
    <td>${i+1}</td>
    <td><strong>${r.ticker}</strong></td>
    <td>${r.Score?.toFixed?.(2) ?? "-"}</td>
    <td>${r.Sharpe?.toFixed?.(2) ?? "-"}</td>
    <td>${r.CAGR?.toFixed?.(2) ?? "-"}</td>
    <td>${r.IC?.toFixed?.(2) ?? "-"}</td>
    <td>${r.Turnover?.toFixed?.(3) ?? "-"}</td>
    <td>${r.Trades ?? "-"}</td>
  </tr>`).join("");
    el.innerHTML = `<table class="table">${th}${trs}</table>`;
}

/* ========= initial load (only if elements exist) ========= */
(async () => {
    if ($("clusters")) await loadClusters();
    if ($("trades"))   await loadTrades();
})();
