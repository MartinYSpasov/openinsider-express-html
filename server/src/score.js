// src/score.js - Enhanced insider scoring with technical indicators

export async function scoreTicker(pool, ticker) {
    // Recent insider purchases (90d for better signal)
    const { rows: trades } = await pool.query(
        `SELECT insider_name, insider_title, value_usd, price, shares, filing_date, trade_date
       FROM trades
      WHERE ticker = $1
        AND filing_date >= NOW() - INTERVAL '90 days'
        AND transaction ILIKE '%purchase%'
      ORDER BY filing_date DESC
      LIMIT 1000`,
        [ticker]
    );

    if (!trades.length) {
        return { ticker, score: null, breakdown: null };
    }

    // === 1. INSIDER QUALITY & CONSISTENCY ===
    const distinctInsiders = new Set(trades.map(t => t.insider_name)).size;
    const totalValue = trades.reduce((s, t) => s + Number(t.value_usd || 0), 0);

    // Bonus for C-suite (CEO/CFO/COO)
    const cSuiteCount = trades.filter(t =>
        /\b(ceo|chief executive|cfo|chief financial|coo|chief operating)\b/i.test(t.insider_title || '')
    ).length;
    const cSuiteBonus = Math.min(cSuiteCount * 5, 20);

    // Consistency: purchases spread over time (not all same day) = stronger signal
    const uniqueDates = new Set(trades.map(t =>
        (t.filing_date || t.trade_date)?.toISOString().slice(0, 10)
    )).size;
    const consistencyBonus = Math.min((uniqueDates - 1) * 3, 15);

    const baseInsiderScore =
        distinctInsiders >= 5 ? 95 :
        distinctInsiders === 4 ? 88 :
        distinctInsiders === 3 ? 80 :
        distinctInsiders === 2 ? 65 :
        50;

    const insiderScore = Math.min(baseInsiderScore + cSuiteBonus + consistencyBonus, 100);

    // === 2. CLUSTER STRENGTH ===
    const { rows: cRows } = await pool.query(
        `SELECT insider_count, total_value_usd, window_end, trade_count
       FROM clusters
      WHERE ticker = $1
      ORDER BY window_end DESC
      LIMIT 1`,
        [ticker]
    );
    const latestCluster = cRows[0] || null;

    const clusterTotal = Number(latestCluster?.total_value_usd || totalValue);
    const clusterDensity = latestCluster ? latestCluster.trade_count / latestCluster.insider_count : 1;
    const densityBonus = clusterDensity > 2 ? 10 : clusterDensity > 1.5 ? 5 : 0;

    const baseClusterScore =
        clusterTotal >= 10_000_000 ? 100 :
        clusterTotal >= 5_000_000 ? 90 + (clusterTotal - 5_000_000) * (10 / 5_000_000) :
        clusterTotal >= 2_000_000 ? 75 + (clusterTotal - 2_000_000) * (15 / 3_000_000) :
        clusterTotal >= 500_000 ? 50 + (clusterTotal - 500_000) * (25 / 1_500_000) :
        30 + (clusterTotal) * (20 / 500_000);

    const clusterScore = Math.min(baseClusterScore + densityBonus, 100);

    // === 3. TIMING (Recency) ===
    const mostRecentMs = Math.max(...trades.map(t =>
        new Date(t.filing_date || t.trade_date || 0).getTime()
    ));
    const daysSinceLast = (Date.now() - mostRecentMs) / (1000 * 60 * 60 * 24);

    const timingScore =
        daysSinceLast <= 7 ? 95 :
        daysSinceLast <= 14 ? 85 :
        daysSinceLast <= 30 ? 70 :
        daysSinceLast <= 60 ? 50 :
        30;

    // === 4. SIZE (avg dollars per insider) ===
    const avgPerInsider = totalValue / distinctInsiders;
    const sizeScore =
        avgPerInsider >= 2_000_000 ? 95 :
        avgPerInsider >= 1_000_000 ? 80 + (avgPerInsider - 1_000_000) * (15 / 1_000_000) :
        avgPerInsider >= 500_000 ? 60 + (avgPerInsider - 500_000) * (20 / 500_000) :
        40 + (avgPerInsider) * (20 / 500_000);

    // === 5. CONCENTRATION (large single buys = conviction) ===
    const maxSingleBuy = Math.max(...trades.map(t => Number(t.value_usd || 0)));
    const concentrationRatio = maxSingleBuy / totalValue;
    const concentrationScore =
        concentrationRatio >= 0.8 ? 85 :  // one huge buy
        concentrationRatio >= 0.5 ? 75 :
        concentrationRatio >= 0.3 ? 60 :
        50;

    // === WEIGHTED COMPOSITE ===
    const weights = {
        insider: 0.25,
        cluster: 0.25,
        timing: 0.20,
        size: 0.15,
        concentration: 0.15
    };

    const score =
        insiderScore * weights.insider +
        clusterScore * weights.cluster +
        timingScore * weights.timing +
        sizeScore * weights.size +
        concentrationScore * weights.concentration;

    return {
        ticker,
        score: Math.round(score),
        breakdown: {
            insider: Math.round(insiderScore),
            cluster: Math.round(clusterScore),
            timing: Math.round(timingScore),
            size: Math.round(sizeScore),
            concentration: Math.round(concentrationScore),
        },
        meta: {
            total_value: totalValue,
            num_insiders: distinctInsiders,
            num_trades: trades.length,
            c_suite_count: cSuiteCount,
            days_since_last: Math.round(daysSinceLast),
            avg_per_insider: Math.round(avgPerInsider),
            max_single_buy: maxSingleBuy,
        }
    };
}

export async function scoreBulk(pool, tickers = []) {
    const uniq = Array.from(new Set((tickers || []).map(t => String(t).trim().toUpperCase()))).slice(0, 100);
    const out = [];
    for (const t of uniq) {
        try {
            out.push(await scoreTicker(pool, t));
        } catch (e) {
            console.error(`[score] ${t}:`, e.message);
            out.push({ ticker: t, score: null, breakdown: null, meta: null });
        }
    }
    return out;
}
