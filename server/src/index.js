import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { Pool } from 'pg';
import { runScrapeAndCluster, getPriceCached } from './logic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const pool = new Pool({ connectionString: DATABASE_URL });

// Simple health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// List trades
app.get('/api/trades', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, ticker, filing_date, trade_date, insider_name, insider_title, transaction, shares, price, value_usd, source_url
     FROM trades
     ORDER BY filing_date DESC
     LIMIT 250`
  );
  res.json(rows);
});

// List clusters
app.get('/api/clusters', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, ticker, window_start, window_end, insider_count, trade_count, total_value_usd
     FROM clusters
     ORDER BY window_start DESC
     LIMIT 100`
  );
  res.json(rows);
});

// Get (and cache) price
app.get('/api/price/:ticker', async (req, res) => {
  try {
    const p = await getPriceCached(pool, req.params.ticker.toUpperCase());
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Manual trigger
app.get('/api/trigger', async (req, res) => {
  try {
    await runScrapeAndCluster(pool);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Schedule cron
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

app.listen(PORT, () => {
  console.log(`Server up on :${PORT}`);
});
