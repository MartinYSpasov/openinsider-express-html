-- Minimal, clean PostgreSQL init (no extensions)

-- =====================
-- Tables
-- =====================

-- Companies (needed by repos upsertCompany/saveTrades)
CREATE TABLE IF NOT EXISTS companies (
                                         id         bigserial PRIMARY KEY,
                                         ticker     text NOT NULL UNIQUE,
                                         name       text,
                                         created_at timestamptz NOT NULL DEFAULT now(),
                                         updated_at timestamptz NOT NULL DEFAULT now()
);

-- Clusters (repos upsertCluster references company_id)
CREATE TABLE IF NOT EXISTS clusters (
                                        id                bigserial PRIMARY KEY,
                                        company_id        bigint REFERENCES companies(id) ON DELETE SET NULL,
                                        ticker            text        NOT NULL,
                                        window_start      timestamptz NOT NULL,
                                        window_end        timestamptz NOT NULL,
                                        insider_count     integer     NOT NULL,
                                        trade_count       integer     NOT NULL,
                                        total_value_usd   numeric     NOT NULL,
                                        created_at        timestamptz NOT NULL DEFAULT now(),
                                        updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
                                      id              bigserial PRIMARY KEY,
                                      company_id      bigint REFERENCES companies(id) ON DELETE SET NULL,
                                      ticker          text        NOT NULL,
                                      company         text,
                                      insider_name    text        NOT NULL,
                                      insider_title   text,
                                      transaction     text,
                                      price           numeric,
                                      shares          bigint,
                                      value_usd       numeric,
                                      trade_date      timestamptz,
                                      filing_date     timestamptz,
                                      source_url      text,
                                      filing_id       text,
                                      created_at      timestamptz NOT NULL DEFAULT now(),
                                      updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'companies_set_updated_at') THEN
            CREATE TRIGGER companies_set_updated_at
                BEFORE UPDATE ON companies
                FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
        END IF;
    END $$;


DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trades_set_updated_at') THEN
            CREATE TRIGGER trades_set_updated_at
                BEFORE UPDATE ON trades
                FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
        END IF;
    END $$;

DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'clusters_set_updated_at') THEN
            CREATE TRIGGER clusters_set_updated_at
                BEFORE UPDATE ON clusters
                FOR EACH ROW
            EXECUTE FUNCTION set_updated_at();
        END IF;
    END $$;

-- Keep dedupe simple and portable
CREATE UNIQUE INDEX IF NOT EXISTS trades_filing_id_uq ON trades (filing_id) WHERE filing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trades_dedupe_uq ON trades (ticker, insider_name, filing_date, value_usd);
CREATE INDEX IF NOT EXISTS trades_filing_date_idx ON trades (filing_date);
CREATE INDEX IF NOT EXISTS trades_ticker_idx      ON trades (ticker);

CREATE UNIQUE INDEX IF NOT EXISTS clusters_key_uq
    ON clusters (ticker, window_start, window_end);

CREATE INDEX IF NOT EXISTS clusters_window_end_idx  ON clusters (window_end);
CREATE INDEX IF NOT EXISTS clusters_total_value_idx ON clusters (total_value_usd);

-- =====================
-- Views (optional)
-- =====================

CREATE OR REPLACE VIEW v_latest_trades AS
SELECT t.*
FROM trades t
ORDER BY t.filing_date DESC NULLS LAST;
