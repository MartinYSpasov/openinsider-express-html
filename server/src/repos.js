// All DB IO in one place.
export async function upsertCompany(pool, ticker, name = null) {
    const c = await pool.query(
        `INSERT INTO companies(ticker, name)
     VALUES ($1,$2)
     ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
        [ticker, name]
    );
    return c.rows[0].id;
}

export async function saveTrades(pool, trades) {
    for (const r of trades) {
        const companyId = await upsertCompany(pool, r.ticker, r.company || null);
        await pool.query(
            `INSERT INTO trades(
        company_id, ticker, filing_date, trade_date, insider_name, insider_title,
        transaction, shares, price, value_usd, source_url
      )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (ticker, insider_name, filing_date, value_usd) DO NOTHING`,
            [
                companyId, r.ticker, r.filing_date, r.trade_date, r.insider_name, r.insider_title,
                r.transaction, r.shares || null, r.price || null, r.value_usd, r.source_url
            ]
        );
    }
}

export async function listTrades(pool, { minBuyUSD = 0, limit = 500 } = {}) {
    const { rows } = await pool.query(
        `SELECT * FROM trades
      WHERE ( $1::numeric = 0 OR value_usd >= $1 )
      ORDER BY filing_date DESC
      LIMIT $2`,
        [minBuyUSD, limit]
    );
    return rows;
}

export async function upsertCluster(pool, companyId, { ticker, windowStart, windowEnd, insiders, count, total }) {
    await pool.query(
        `INSERT INTO clusters(
       company_id, ticker, window_start, window_end, insider_count, trade_count, total_value_usd
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (ticker, window_start, window_end) DO UPDATE
       SET insider_count=$5, trade_count=$6, total_value_usd=$7`,
        [companyId, ticker, windowStart, windowEnd, insiders, count, total]
    );
}

export async function listClusters(pool, { minTotalUSD = 0, limit = 200 } = {}) {
    const { rows } = await pool.query(
        `SELECT * FROM clusters
      WHERE ( $1::numeric = 0 OR total_value_usd >= $1 )
      ORDER BY window_end DESC
      LIMIT $2`,
        [minTotalUSD, limit]
    );
    return rows;
}

export async function getCompanyId(pool, ticker) {
    const r = await pool.query('SELECT id FROM companies WHERE ticker=$1', [ticker]);
    return r.rowCount ? r.rows[0].id : null;
}

export async function insertPrice(pool, companyId, ticker, asOf, close) {
    const { rows } = await pool.query(
        `INSERT INTO prices(company_id, ticker, as_of, close)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
        [companyId, ticker, asOf, close]
    );
    return rows[0];
}

export async function lastPrice(pool, ticker) {
    const { rows } = await pool.query(
        `SELECT * FROM prices WHERE ticker=$1 ORDER BY as_of DESC LIMIT 1`,
        [ticker]
    );
    return rows[0] || null;
}
