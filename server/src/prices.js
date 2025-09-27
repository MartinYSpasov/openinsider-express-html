// server/src/prices.js (ESM)
import yahooFinance from 'yahoo-finance2';

// TTL for cached quotes (ms)
const TTL_MS = Number(process.env.PRICE_TTL_MS || 15 * 60 * 1000); // 15 minutes

let ASOF_COL = null; // 'asof' or 'as_of', detected lazily

async function ensurePricesTable(pool) {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS prices (
      ticker TEXT PRIMARY KEY,
      close  NUMERIC,
      asof   TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function detectAsofColumn(pool) {
    if (ASOF_COL) return ASOF_COL;

    // Ensure table exists (creates 'asof' if it's a new table)
    await ensurePricesTable(pool);

    // Check which column is present
    const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'prices'
      AND column_name IN ('asof', 'as_of')
  `);

    const cols = rows.map(r => r.column_name);
    if (cols.includes('asof')) {
        ASOF_COL = 'asof';
    } else if (cols.includes('as_of')) {
        ASOF_COL = 'as_of';
    } else {
        // Neither exists (very unlikely) — add 'asof'
        await pool.query(`ALTER TABLE prices ADD COLUMN asof TIMESTAMPTZ DEFAULT now()`);
        ASOF_COL = 'asof';
    }
    return ASOF_COL;
}

async function fetchQuoteSafe(ticker) {
    try {
        const q = await yahooFinance.quote(ticker);
        if (!q || typeof q !== 'object') return { close: null, asof: null };

        const close =
            (typeof q.regularMarketPrice === 'number' ? q.regularMarketPrice : null) ??
            (typeof q.regularMarketPreviousClose === 'number' ? q.regularMarketPreviousClose : null) ??
            null;

        const tSec = (typeof q.regularMarketTime === 'number' ? q.regularMarketTime : null);
        const asof = tSec ? new Date(tSec * 1000).toISOString() : new Date().toISOString();

        return { close, asof };
    } catch {
        // Fallback to quoteSummary
        try {
            const qs = await yahooFinance.quoteSummary(ticker, { modules: ['price'] });
            const p = qs?.price || {};
            const close =
                (typeof p.regularMarketPrice?.raw === 'number' ? p.regularMarketPrice.raw : null) ??
                (typeof p.regularMarketPreviousClose?.raw === 'number' ? p.regularMarketPreviousClose.raw : null) ??
                null;
            const asof = new Date().toISOString();
            return { close, asof };
        } catch {
            return { close: null, asof: null };
        }
    }
}

export async function getPriceCached(pool, ticker) {
    ticker = String(ticker || '').trim().toUpperCase();
    if (!ticker) return { ticker, close: null, asof: null };

    const asofCol = await detectAsofColumn(pool);

    // 1) Try cache
    const { rows } = await pool.query(
        `SELECT close, ${asofCol} AS asof FROM prices WHERE ticker = $1`,
        [ticker]
    );
    if (rows.length) {
        const { close, asof } = rows[0];
        const age = Date.now() - new Date(asof).getTime();
        if (Number.isFinite(age) && age < TTL_MS) {
            return { ticker, close: close == null ? null : Number(close), asof };
        }
    }

    // 2) Fetch fresh
    const { close, asof } = await fetchQuoteSafe(ticker);

    // 3) Upsert (avoid hammering on repeated failures; still store nulls with timestamp)
    await pool.query(
        `INSERT INTO prices (ticker, close, ${asofCol})
         VALUES ($1, $2, $3)
         ON CONFLICT (ticker) DO UPDATE
             SET close = EXCLUDED.close,
                 ${asofCol} = EXCLUDED.${asofCol}`,
        [ticker, close, asof]
    );

    return { ticker, close, asof };
}
