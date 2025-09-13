// server/src/scoring.js
import yf from 'yahoo-finance2';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Simple SMA */
function sma(arr, n) {
    if (!arr || arr.length < n) return null;
    let s = 0;
    for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
    return s / n;
}

// ----- Component Scores -----
function scoreInsider(recentTrades, now = new Date(), currentPrice = null) {
    if (!recentTrades?.length) return 0;
    const top = [...recentTrades]
        .sort((a, b) => Number(b.value_usd) - Number(a.value_usd))
        .slice(0, 3);

    const roleWeight = (title = '') =>
        /CEO/i.test(title) ? 1.0 : /CFO/i.test(title) ? 0.9 : 0.8;

    const subs = top.map((t) => {
        const depth = clamp(Number(t.value_usd) / 2_000_000, 0, 1);
        const role = roleWeight(t.insider_title);
        const buy = t.price ? Number(t.price) : null;
        const curr = currentPrice ?? buy ?? 0;
        const adv = buy && curr ? clamp((buy - curr) / buy, -0.4, 0.4) : 0;
        const adv01 = (adv + 0.4) / 0.8;
        const ageDays = (now - new Date(t.filing_date)) / (1000 * 3600 * 24);
        const rec = Math.exp(-ageDays / 60);
        return 100 * (0.45 * depth + 0.20 * adv01 + 0.15 * role + 0.20 * rec);
    });

    return subs.reduce((a, b) => a + b, 0) / subs.length;
}

function scoreCluster(c) {
    if (!c) return 0;
    const insiders01 = clamp((c.insider_count - 1) / 4, 0, 1);
    const relCap01 = c.marketCap
        ? clamp((Number(c.total_value_usd) / Number(c.marketCap)) / 0.01, 0, 1)
        : 0;
    const windowDays =
        (new Date(c.window_end) - new Date(c.window_start)) / (1000 * 3600 * 24);
    const tight = clamp(1 - windowDays / 14, 0, 1);
    return 100 * (0.45 * insiders01 + 0.35 * relCap01 + 0.20 * tight);
}

function scoreValuation({ pe, ps, sectorPE, sectorPS, peg, debtToEquity }) {
    let peOrPs = 0;
    if (pe && sectorPE) peOrPs = clamp((sectorPE / pe) / 2, 0, 1);
    else if (ps && sectorPS) peOrPs = clamp((sectorPS / ps) / 2, 0, 1);
    else if (pe) peOrPs = clamp((20 / pe) / 2, 0, 1); // fallback bands
    else if (ps) peOrPs = clamp((4 / ps) / 2, 0, 1);

    const pegScore = peg ? clamp((2 / peg) / 2, 0, 1) : 0.5;
    const deScore =
        debtToEquity != null
            ? clamp(1 / (1 + Number(debtToEquity) / 100), 0, 1)
            : 0.5;

    return 100 * (0.5 * peOrPs + 0.3 * pegScore + 0.2 * deScore);
}

function scoreMomentum({ close, sma20, sma60, volume, avgVol20 }) {
    if (!close) return 50;
    const m1 = clamp((close - (sma20 || close)) / (sma20 || close), -0.2, 0.2);
    const m3 = clamp((close - (sma60 || close)) / (sma60 || close), -0.3, 0.3);
    const m1_ = (m1 + 0.2) / 0.4;
    const m3_ = (m3 + 0.3) / 0.6;
    const vol = avgVol20 ? clamp((volume || avgVol20) / avgVol20, 0.5, 2) : 1;
    const vol_ = (vol - 0.5) / 1.5;
    return 100 * (0.45 * m3_ + 0.35 * m1_ + 0.20 * vol_);
}

function scoreLiquidity({ marketCap, shortFloat, price }) {
    const cap01 = marketCap ? clamp((Math.log10(marketCap) - 8) / 2, 0, 1) : 0.3;
    const short01 = shortFloat != null ? 1 - clamp(shortFloat, 0, 0.25) / 0.25 : 0.5;
    const price01 = price != null ? clamp((price - 5) / 20, 0, 1) : 0.5;
    return 100 * (0.5 * cap01 + 0.3 * short01 + 0.2 * price01);
}

const scoreSentiment = (avgSentiment = null) =>
    avgSentiment == null ? 50 : 50 + 50 * clamp(avgSentiment, -0.6, 0.6) / 0.6;

/**
 * Build a conviction score for a ticker by pulling:
 * - recent insider trades from DB (last 90d, purchases)
 * - latest cluster (and compute rel to mkt cap)
 * - valuation/momentum/risk inputs from Yahoo (cached by your app as needed)
 */
export async function buildScoreForTicker(pool, ticker) {
    // recent insider trades (90d)
    const tradesQ = await pool.query(
        `SELECT *
     FROM trades
     WHERE ticker = $1
       AND transaction ILIKE '%purchase%'
       AND filing_date >= NOW() - INTERVAL '90 days'
     ORDER BY value_usd DESC
     LIMIT 10`,
        [ticker]
    );
    const trades = tradesQ.rows;

    // latest cluster (if any)
    const clQ = await pool.query(
        `SELECT *
     FROM clusters
     WHERE ticker=$1
     ORDER BY window_end DESC
     LIMIT 1`,
        [ticker]
    );
    const cluster = clQ.rows[0] || null;

    // Yahoo fundamentals + price history
    const [quote, keyStats, hist] = await Promise.all([
        yf.quote(ticker),
        yf.quoteSummary(ticker, { modules: ['defaultKeyStatistics', 'financialData', 'price', 'summaryDetail'] }),
        yf.historical(ticker, { period1: '2024-01-01' }) // enough to compute SMA20/60
    ]);

    const close = quote.regularMarketPrice ?? quote.postMarketPrice ?? quote.preMarketPrice ?? null;
    const marketCap = quote.marketCap ?? keyStats?.price?.marketCap ?? null;
    const pe = quote.trailingPE ?? keyStats?.summaryDetail?.trailingPE ?? null;
    const ps = keyStats?.summaryDetail?.priceToSalesTrailing12Months ?? null;
    const peg = keyStats?.defaultKeyStatistics?.pegRatio ?? null;
    const debtToEquity = keyStats?.financialData?.debtToEquity ?? null;
    const shortFloat = keyStats?.defaultKeyStatistics?.shortPercentOfFloat ?? null;
    const sectorPE = null; // optional: plug your sector baseline here
    const sectorPS = null; // optional: plug your sector baseline here

    const closes = hist.map(h => h.close).filter(Boolean);
    const volArr = hist.map(h => h.volume).filter(Boolean);
    const sma20 = sma(closes, 20);
    const sma60 = sma(closes, 60);
    const avgVol20 = sma(volArr, 20);
    const volume = quote.regularMarketVolume ?? null;

    // Component scores
    const insider = scoreInsider(trades, new Date(), close);
    const clusterEnriched = cluster ? { ...cluster, marketCap } : null;
    const clusterScore = scoreCluster(clusterEnriched);
    const valuation = scoreValuation({ pe, ps, sectorPE, sectorPS, peg, debtToEquity });
    const momentum = scoreMomentum({ close, sma20, sma60, volume, avgVol20 });
    const liquidity = scoreLiquidity({ marketCap, shortFloat, price: close });
    const sentiment = scoreSentiment(null); // plug in a news sentiment if you add it

    const weights = { insider: 0.30, cluster: 0.25, valuation: 0.20, momentum: 0.15, liquidity: 0.05, sentiment: 0.05 };
    const score = Math.round(
        Math.max(0, Math.min(100,
            weights.insider  * insider +
            weights.cluster  * clusterScore +
            weights.valuation* valuation +
            weights.momentum * momentum +
            weights.liquidity* liquidity +
            weights.sentiment* sentiment
        ))
    );

    return {
        ticker,
        score,
        breakdown: { insider, cluster: clusterScore, valuation, momentum, liquidity, sentiment },
        inputs: {
            price: close, marketCap, pe, ps, peg, debtToEquity, shortFloat,
            sma20, sma60, avgVol20
        }
    };
}
