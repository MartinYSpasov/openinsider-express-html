# OpenInsider Cluster Buys — Node.js/Express + Postgres + HTML (Docker)

Scrapes **OpenInsider** for **CEO/CFO purchases ≥ $500k**, stores them in **Postgres**, detects **cluster buys**, and serves a **simple HTML dashboard** showing *current price vs insider buys*.

**Stack:** Node.js (Express), node-postgres (`pg`), Cheerio scraper, Yahoo Finance for quotes, Docker Compose.

> Respect OpenInsider's robots.txt / ToS. Keep requests modest and cached.

## Quick start

```bash
# 1) Copy env and edit if needed
cp .env.example .env

# 2) Build & run everything (Postgres + app)
docker compose up --build
```

- App (API + dashboard): http://localhost:4000
- PGAdmin (optional): http://localhost:5050  (email: admin@example.com / password: admin)

### Data flow
- A cron job runs every 15 minutes:
  1. Scrapes OpenInsider screener pages.
  2. Keeps only **Purchase** by **CEO/CFO** with **Value ≥ $500,000**.
  3. Stores into Postgres (`trades`, `companies`).
  4. Detects cluster buys into `clusters`.
- Prices fetched on demand and cached into `prices` table.

### Tables
- `companies(id, ticker, name, sector)`
- `trades(id, company_id, ticker, filing_date, trade_date, insider_name, insider_title, transaction, shares, price, value_usd, source_url)`
- `clusters(id, company_id, ticker, window_start, window_end, insider_count, trade_count, total_value_usd)`
- `prices(id, company_id, ticker, as_of, close)`

### Manual endpoints
- `GET /api/trigger` — run a scrape + cluster pass immediately
- `GET /api/trades` — latest qualifying trades
- `GET /api/clusters` — cluster events
- `GET /api/price/:ticker` — current price (cached)

### Change schedule
Edit `SCRAPE_CRON` in `.env`. Default: every 15 minutes.
