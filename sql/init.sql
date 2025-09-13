-- Schema for insiders project

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  ticker TEXT UNIQUE NOT NULL,
  name TEXT,
  sector TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  filing_date TIMESTAMP NOT NULL,
  trade_date TIMESTAMP,
  insider_name TEXT NOT NULL,
  insider_title TEXT NOT NULL,
  transaction TEXT NOT NULL,
  shares BIGINT,
  price NUMERIC(18,4),
  value_usd NUMERIC(20,2) NOT NULL,
  source_url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_ticker_filing ON trades(ticker, filing_date);
CREATE INDEX IF NOT EXISTS idx_trades_title ON trades(insider_title);

-- prevent obvious dupes (not perfect)
CREATE UNIQUE INDEX IF NOT EXISTS ux_trade_dedupe ON trades(ticker, insider_name, filing_date, value_usd);

CREATE TABLE IF NOT EXISTS clusters (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  insider_count INTEGER NOT NULL,
  trade_count INTEGER NOT NULL,
  total_value_usd NUMERIC(20,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clusters_ticker_window ON clusters(ticker, window_start, window_end);

CREATE TABLE IF NOT EXISTS prices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  as_of TIMESTAMP NOT NULL,
  close NUMERIC(18,4) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prices_ticker_asof ON prices(ticker, as_of);
