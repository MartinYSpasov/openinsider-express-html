import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';

import { scrapePurchases } from './openinsider.js';
import { saveTrades, listTrades, listClusters } from './repos.js';
import { detectClusters } from './clusters.js';
import { getPriceCached } from './prices.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store, max-age=0'); next(); });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// --- API ---
app.get('/api/trades', async (req, res) => {
    try {
        const minBuyUSD = Number(req.query.minBuy) || 0;
        const rows = await listTrades(pool, { minBuyUSD, limit: 500 });
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clusters', async (req, res) => {
    try {
        const minBuyUSD = Number(req.query.minBuy) || 0;
        const rows = await listClusters(pool, { minTotalUSD: minBuyUSD, limit: 200 });
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trigger', async (req, res) => {
    try {
        const minBuyUSD = Number(req.query.minBuy) || undefined;
        const trades = await scrapePurchases({ minBuyUSD });
        await saveTrades(pool, trades);
        await detectClusters(pool, { minBuyUSD: minBuyUSD || 0 });
        res.json({ ok: true, inserted: trades.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/price/:ticker', async (req, res) => {
    try {
        const r = await getPriceCached(pool, req.params.ticker.toUpperCase());
        res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// static files (unchanged)
app.use(express.static('public'));

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Server on http://localhost:${port}`));
