// src/score.js
export async function scoreTicker(pool, ticker) {
    // recent insider purchases (60d)
    const { rows: trades } = await pool.query(
        `SELECT insider_name, value_usd, price, shares, filing_date
       FROM trades
      WHERE ticker = $1
        AND filing_date >= NOW() - INTERVAL '60 days'
        AND transaction ILIKE '%purchase%'
      ORDER BY filing_date DESC
      LIMIT 1000`,
        [ticker]
    );

    if (!trades.length) {
        return { ticker, score: null, breakdown: null };
    }

    const distinctInsiders = new Set(trades.map(t => t.insider_name)).size;
    const totalValue = trades.reduce((s, t) => s + Number(t.value_usd || 0), 0);

    // latest cluster for this ticker (optional)
    const { rows: cRows } = await pool.query(
        `SELECT insider_count, total_value_usd, window_end
       FROM clusters
      WHERE ticker = $1
      ORDER BY window_end DESC
      LIMIT 1`,
        [ticker]
    );
    const latestCluster = cRows[0] || null;

    // --- subscores 0..100 (simple, defendable) ---
    const insiderScore =
        distinctInsiders >= 5 ? 98 :
            distinctInsiders === 4 ? 95 :
                distinctInsiders === 3 ? 88 :
                    distinctInsiders === 2 ? 75 :
                        distinctInsiders === 1 ? 60 : 40;

    const clusterTotal = Number(latestCluster?.total_value_usd || totalValue);
    const clusterScore =
        clusterTotal >= 5_000_000 ? 100 :
            clusterTotal >= 2_000_000 ? 85 + (clusterTotal - 2_000_000) * (15 / 3_000_000) :
                clusterTotal >=   500_000 ? 60 + (clusterTotal -   500_000) * (25 / 1_500_000) :
                    40 + (clusterTotal) * (20 / 500_000);

    const valuationScore = 50; // neutral for now (can wire in price later)
    const momentumScore  = 50; // neutral
    const liquidityScore =
        totalValue >= 3_000_000 ? 90 :
            totalValue >= 1_000_000 ? 75 + (totalValue - 1_000_000) * (15 / 2_000_000) :
                totalValue >=   250_000 ? 55 + (totalValue -   250_000) * (20 / 750_000) :
                    40 + (totalValue) * (15 / 250_000);

    const weights = { insider: 0.30, cluster: 0.35, valuation: 0.25, momentum: 0.05, liquidity: 0.05 };
    const score =
        insiderScore  * weights.insider  +
        clusterScore  * weights.cluster  +
        valuationScore* weights.valuation+
        momentumScore * weights.momentum+
        liquidityScore* weights.liquidity;

    return {
        ticker,
        score: Math.round(score),
        breakdown: {
            insider:   Math.round(insiderScore),
            cluster:   Math.round(clusterScore),
            valuation: Math.round(valuationScore),
            momentum:  Math.round(momentumScore),
            liquidity: Math.round(liquidityScore),
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
            out.push({ ticker: t, score: null, breakdown: null });
        }
    }
    return out;
}
