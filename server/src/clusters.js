import {
    CLUSTER_MIN_INSIDERS, CLUSTER_MIN_TOTAL_USD, CLUSTER_WINDOW_DAYS
} from './config.js';
import { getCompanyId, upsertCompany, upsertCluster } from './repos.js';

export async function detectClusters(pool, { minBuyUSD = 0 } = {}) {
    const { rows } = await pool.query(
        `SELECT *
       FROM trades
      WHERE filing_date >= NOW() - INTERVAL '${CLUSTER_WINDOW_DAYS} days'
        AND transaction ILIKE '%purchase%'
        AND ( $1::numeric = 0 OR value_usd >= $1 )`,
        [minBuyUSD]
    );

    const byTicker = new Map();
    for (const t of rows) {
        if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
        byTicker.get(t.ticker).push(t);
    }

    for (const [ticker, list] of byTicker) {
        const insiderSet = new Set(list.map(t => t.insider_name));
        const total = list.reduce((s, t) => s + Number(t.value_usd), 0);

        if (insiderSet.size >= CLUSTER_MIN_INSIDERS && total >= Math.max(CLUSTER_MIN_TOTAL_USD, minBuyUSD)) {
            const windowStart = new Date(Math.min(...list.map(t => new Date(t.filing_date).getTime())));
            const windowEnd   = new Date(Math.max(...list.map(t => new Date(t.filing_date).getTime())));

            let companyId = await getCompanyId(pool, ticker);
            if (!companyId) companyId = await upsertCompany(pool, ticker);

            await upsertCluster(pool, companyId, {
                ticker, windowStart, windowEnd,
                insiders: insiderSet.size, count: list.length, total
            });
        }
    }
}
