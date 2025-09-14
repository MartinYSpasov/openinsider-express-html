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
app.get('/api/clusters', async (_req, res) => {
    const { rows } = await pool.query(
        `SELECT id, ticker, window_start, window_end, insider_count, trade_count, total_value_usd
         FROM clusters
         ORDER BY window_start DESC
         LIMIT 100`
    );
    res.json(rows);
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

// manual run
app.get('/api/trigger', async (_req, res) => {
    try {
        await runScrapeAndCluster(pool);
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: String(e) });
    }
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

app.listen(PORT, () => console.log(`Server up on :${PORT}`));



app.get("/api/summary/:ticker", async (req, res) => {
    try {
        const text = await summariseCompany(req.params.ticker);
        res.json({ summary: text });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to summarise" });
    }
});
