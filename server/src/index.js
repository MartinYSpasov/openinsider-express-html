// server/src/index.js
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Pool } from 'pg';
import { runScrapeAndCluster, getPriceCached } from './logic.js';
import { buildScoreForTicker } from './scoring.js';
import { summariseCompany } from "./ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const pool = new Pool({ connectionString: DATABASE_URL });

app.listen(PORT, () => console.log(`Server up on :${PORT}`));


// health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// latest trades
app.get('/api/trades', async (_req, res) => {
    const { rows } = await pool.query(
        `SELECT id, ticker, filing_date, trade_date, insider_name, insider_title,
                transaction, shares, price, value_usd, source_url
         FROM trades
         ORDER BY filing_date DESC
         LIMIT 250`
    );
    res.json(rows);
});

// clusters
app.get('/api/clusters', async (req, res) => {
    const minBuyUSD = Number(req.query.minBuy) || 0;
    const { rows } = await pool.query(
        `SELECT *
       FROM clusters
      WHERE ($1::numeric) = 0 OR total_value_usd >= $1
      ORDER BY window_end DESC
      LIMIT 200`,
        [minBuyUSD]
    );
    res.set('Cache-Control', 'no-store').json(rows);
});

// current price (cached)
app.get('/api/price/:ticker', async (req, res) => {
    try {
        const p = await getPriceCached(pool, req.params.ticker.toUpperCase());
        res.json(p);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// single ticker score
app.get('/api/score/:ticker', async (req, res) => {
    try {
        const out = await buildScoreForTicker(pool, req.params.ticker.toUpperCase());
        res.json(out);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e) });
    }
});

// bulk scores: /api/score-bulk?tickers=AAPL,MSFT,SMMT
app.get('/api/score-bulk', async (req, res) => {
    try {
        const raw = String(req.query.tickers || '').trim();
        if (!raw) return res.json({ scores: [] });

        const tickers = [...new Set(raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
        // limit to avoid abuse
        const limited = tickers.slice(0, 100);

        // Run in parallel, but avoid a stampede with simple batching
        const batchSize = 5;
        const out = [];
        for (let i = 0; i < limited.length; i += batchSize) {
            const batch = limited.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(t =>
                buildScoreForTicker(pool, t).catch(err => ({ ticker: t, error: String(err) }))
            ));
            out.push(...results);
        }
        res.json({ scores: out });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/trigger', async (req, res) => {
    const minBuyUSD = Number(req.query.minBuy) || undefined; // undefined -> default
    runScrapeAndCluster(pool, { minBuyUSD })
        .then(() => res.json({ ok: true }))
        .catch(err => {
            console.error(err);
            res.status(500).json({ error: err.message });
        });
});


// dashboard
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// cron
const cronExpr = process.env.SCRAPE_CRON || '*/15 * * * *';
cron.schedule(cronExpr, async () => {
    try {
        console.log('[cron] scrape + cluster start');
        await runScrapeAndCluster(pool);
        console.log('[cron] done');
    } catch (e) {
        console.error('[cron] error', e);
    }
});




app.get("/api/summary/:ticker", async (req, res) => {
    try {
        const text = await summariseCompany(req.params.ticker);
        res.json({ summary: text });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to summarise" });
    }
});

app.get('/api/trades', async (req, res) => {
    const minBuyUSD = Number(req.query.minBuy) || 0; // dollars
    const { rows } = await pool.query(
        `SELECT *
         FROM trades
         WHERE ($1::numeric) = 0 OR value_usd >= $1
         ORDER BY filing_date DESC
         LIMIT 500`,
        [minBuyUSD]
    );
    res.set('Cache-Control', 'no-store').json(rows);
});

app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
});
