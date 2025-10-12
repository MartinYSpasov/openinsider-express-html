// server/src/server.js
// ESM module (package.json has "type": "module")

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import yahooFinance from 'yahoo-finance2';

import { scrapePurchases } from './openinsider.js';
import { saveTrades } from './repos.js';
import { detectClusters } from './clusters.js';
import { getPriceCached } from './prices.js';
import { scoreBulk } from './score.js';
import { predictOne, screenSymbols, screenUniverse, pingModel } from './modelClient.js';

const PORT = process.env.PORT || 4000;
const app = express();

// ---- Database ----
const pool = new Pool(
    process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.PGHOST || 'db',
            port: Number(process.env.PGPORT || 5432),
            user: process.env.PGUSER || 'app',
            password: process.env.PGPASSWORD || 'app',
            database: process.env.PGDATABASE || 'insiders',
        }
);

// ---- Utils ----
const DEFAULT_MIN_BUY_USD = Number(process.env.MIN_BUY_USD || 500000);
const parseMinBuy = (q) => {
    const s = String(q ?? '').trim();
    if (s === '') return DEFAULT_MIN_BUY_USD; // blank -> default 500k
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_BUY_USD;
};

// ---- Middleware ----
app.use(cors());
app.use(express.json());
app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
});
app.use(express.static('public'));

// ---- Root ----
app.get('/', (_req, res) => {
    res.type('text/plain').send('openinsider-express-html API. See /api/*');
});

// ---- Health (checks app + db + model) ----
app.get('/api/health', async (_req, res) => {
    const out = { ok: true, db: false, model: false };
    const t0 = Date.now();
    try {
        const r = await pool.query('SELECT 1 AS one');
        out.db = r?.rows?.[0]?.one === 1;
    } catch {
        out.db = false;
    }
    try {
        const r = await pingModel().catch(() => null);
        out.model = !!(r && r.status === 'ok');
    } catch {
        out.model = false;
    }
    out.ms = Date.now() - t0;
    res.status(out.db && out.model ? 200 : 503).json(out);
});

// =====================
// === Core features ===
// =====================

// Trades
app.get('/api/trades', async (req, res) => {
    try {
        const minBuyUSD = parseMinBuy(req.query.minBuy);
        const { rows } = await pool.query(
            `SELECT *
         FROM trades
        WHERE ($1::numeric = 0 OR value_usd >= $1)
        ORDER BY filing_date DESC
        LIMIT 500`,
            [minBuyUSD]
        );
        res.json(rows);
    } catch (e) {
        console.error('[trades]', e);
        res.status(500).json({ error: e.message });
    }
});

// Clusters
app.get('/api/clusters', async (req, res) => {
    try {
        const minBuyUSD = parseMinBuy(req.query.minBuy);
        const { rows } = await pool.query(
            `SELECT *
         FROM clusters
        WHERE ($1::numeric = 0 OR total_value_usd >= $1)
        ORDER BY window_end DESC
        LIMIT 200`,
            [minBuyUSD]
        );
        res.json(rows);
    } catch (e) {
        console.error('[clusters]', e);
        res.status(500).json({ error: e.message });
    }
});

// Trigger scrape + detect
app.get('/api/trigger', async (req, res) => {
    const minBuyUSD = parseMinBuy(req.query.minBuy);
    try {
        const trades = await scrapePurchases({ minBuyUSD });
        await saveTrades(pool, trades);
        await detectClusters(pool, { minBuyUSD });
        res.json({ ok: true, inserted: trades.length, minBuyUSD });
    } catch (e) {
        console.error('[trigger]', e);
        res.status(500).json({ error: e.message });
    }
});

// Price cache
app.get('/api/price/:ticker', async (req, res) => {
    try {
        const r = await getPriceCached(pool, req.params.ticker.toUpperCase());
        res.json(r);
    } catch (e) {
        console.error('[price]', e);
        res.status(500).json({ error: e.message });
    }
});

// Score bulk
app.get('/api/score-bulk', async (req, res) => {
    try {
        const raw = String(req.query.tickers || '');
        const tickers = raw.split(',').map((s) => s.trim()).filter(Boolean);
        const scores = await scoreBulk(pool, tickers);
        res.json({ scores });
    } catch (e) {
        console.error('[score-bulk]', e);
        res.status(500).json({ error: e.message, scores: [] });
    }
});

// =====================
// === Chart support ===
// =====================

// OHLC for charts (price overlay)
app.get('/api/ohlc/:ticker', async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const start = String(req.query.start ?? '2016-01-01');
        const end = String(req.query.end ?? new Date().toISOString().slice(0, 10));
        const interval = String(req.query.interval ?? '1d');

        const chart = await yahooFinance.chart(ticker, {
            period1: new Date(start),
            period2: new Date(end),
            interval,
        });

        const rows = (chart?.quotes ?? []).map((q) => ({
            date: new Date(q.date).toISOString().slice(0, 10),
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            volume: q.volume,
        }));

        res.json({ ticker, start, end, interval, rows });
    } catch (e) {
        console.error('[ohlc]', e);
        res.status(500).json({ error: e.message });
    }
});

// =====================
// === Model proxying ===
// =====================

// Predict passthrough
app.get('/api/model/predict/:ticker', async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();

        // Default to last 2 years for speed (not 10 years)
        const defaultStart = new Date(Date.now() - 730*24*60*60*1000).toISOString().slice(0, 10);
        const start = String(req.query.start ?? defaultStart);
        const end = String(req.query.end ?? new Date().toISOString().slice(0, 10));

        // Default backtest OFF for quick predictions
        const backtest = String(req.query.backtest ?? 'false').toLowerCase() === 'true';
        const model = String(req.query.model ?? 'hgb');
        const threshold = Number(req.query.threshold ?? 0.0015);
        const allow_short = String(req.query.allow_short ?? 'true').toLowerCase() === 'true';
        const exit_mode = String(req.query.exit_mode ?? 'oneday');

        const payload = { ticker, start, end, backtest, model, threshold, allow_short, exit_mode };

        const t0 = Date.now();
        const data = await predictOne(payload);
        const ms = Date.now() - t0;

        res.set('Cache-Control', 'no-store').json({ ...data, server_ms: ms });
    } catch (e) {
        console.error('[predict]', e);
        res.status(502).json({ error: e.message || 'model error' });
    }
});

// Screen explicit tickers
app.post('/api/model/screen', async (req, res) => {
    try {
        const data = await screenSymbols(req.body || {});
        res.set('Cache-Control', 'no-store').json(data);
    } catch (e) {
        console.error('[screen]', e);
        res.status(502).json({ error: e.message || 'model error' });
    }
});

// Screen a universe
app.post('/api/model/screen/universe', async (req, res) => {
    try {
        const data = await screenUniverse(req.body || {});
        res.set('Cache-Control', 'no-store').json(data);
    } catch (e) {
        console.error('[screen_universe]', e);
        res.status(502).json({ error: e.message || 'model error' });
    }
});

// ---- Error handler ----
app.use((err, _req, res, _next) => {
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'internal error' });
});

// ---- Start ----
const server = app.listen(PORT, () => {
    console.log(`Server on http://localhost:${PORT}`);
});

// ---- Graceful shutdown ----
const shutdown = async (signal) => {
    try {
        console.log(`\n${signal} received, shutting down...`);
        server.close(() => console.log('HTTP server closed.'));
        await pool.end();
        console.log('DB pool closed.');
    } catch (e) {
        console.error('Error during shutdown:', e);
    } finally {
        process.exit(0);
    }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
