import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';

import { scrapePurchases } from './openinsider.js';
import { saveTrades, listTrades, listClusters } from './repos.js';
import { detectClusters } from './clusters.js';
import { getPriceCached } from './prices.js';
import { scoreBulk } from './score.js';

const port = process.env.PORT || 4000;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_MIN_BUY_USD = Number(process.env.MIN_BUY_USD || 500000);
const parseMinBuy = (q) => {
    const s = String(q ?? '').trim();
    if (s === '') return DEFAULT_MIN_BUY_USD;          // blank -> default 500k
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_BUY_USD;
};

app.use(cors());
app.use(express.json());
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store, max-age=0'); next(); });

app.use(express.static('public'));

app.listen(port, () => console.log(`Server on http://localhost:${port}`));



// --- API ---
app.get('/api/trades', async (req, res) => {
    const minBuyUSD = parseMinBuy(req.query.minBuy);
    const { rows } = await pool.query(
        `SELECT *
       FROM trades
      WHERE ( $1::numeric = 0 OR value_usd >= $1 )
      ORDER BY filing_date DESC
      LIMIT 500`,
        [minBuyUSD]
    );
    res.set('Cache-Control', 'no-store').json(rows);
});

app.get('/api/clusters', async (req, res) => {
    const minBuyUSD = parseMinBuy(req.query.minBuy);
    const { rows } = await pool.query(
        `SELECT *
       FROM clusters
      WHERE ( $1::numeric = 0 OR total_value_usd >= $1 )
      ORDER BY window_end DESC
      LIMIT 200`,
        [minBuyUSD]
    );
    res.set('Cache-Control', 'no-store').json(rows);
});

app.get('/api/trigger', async (req, res) => {
    const minBuyUSD = parseMinBuy(req.query.minBuy);
    try {
        const trades = await scrapePurchases({ minBuyUSD });
        await saveTrades(pool, trades);
        await detectClusters(pool, { minBuyUSD });
        res.json({ ok: true, inserted: trades.length, minBuyUSD });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/api/price/:ticker', async (req, res) => {
    try {
        const r = await getPriceCached(pool, req.params.ticker.toUpperCase());
        res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/score-bulk', async (req, res) => {
    try {
        const raw = String(req.query.tickers || '');
        const tickers = raw.split(',').map(s => s.trim()).filter(Boolean);
        const scores = await scoreBulk(pool, tickers);
        res.set('Cache-Control', 'no-store').json({ scores });
    } catch (e) {
        console.error('[score-bulk]', e);
        res.status(500).json({ error: e.message, scores: [] });
    }
});




