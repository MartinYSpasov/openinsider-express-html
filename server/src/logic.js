// server/src/logic.js
// ESM module (package.json has "type": "module")
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import yf from 'yahoo-finance2';

/* ------------------------- Config helpers ------------------------- */

export function buildScreenerUrl(page = 1) {
    // Your exact CEO+CFO, >=$500k, last 14 days, 100 rows/page, HTTP (not HTTPS)
    return `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=14&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&vl=500&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&isceo=1&iscfo=1&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&page=${page}`;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const toMoney = (s) =>
    s ? Number(String(s).replace(/[+$,]/g, '')) : undefined;

const toInt = (s) =>
    s ? Number(String(s).replace(/[+,]/g, '')) : undefined;

const DEBUG = !!process.env.DEBUG_SCRAPE;
const PAGES = Number(process.env.PAGES || 1);

/* --------------------------- Scraper ------------------------------ */

/**
 * Parse <table class="tinytable"> using header labels instead of column indexes.
 * Pulls: Filing Date (and its SEC link), Trade Date, Ticker, Company Name,
 * Insider Name, Title, Trade Type, Price, Qty, Value.
 */
export async function fetchScreenerPage(url) {
    const ua = process.env.USER_AGENT || 'Mozilla/5.0';
    const res = await fetch(url, { headers: { 'User-Agent': ua } });
    if (!res.ok) throw new Error(`OpenInsider ${res.status} ${res.statusText}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    const table = $('table.tinytable'); // Correct table from your HTML
    if (!table.length) {
        if (DEBUG) console.log('[scrape] tinytable not found');
        return [];
    }

    // Build header -> index map (lowercased, trimmed)
    const headerMap = {};
    table.find('thead tr').first().find('th').each((i, th) => {
        const label = $(th).text().replace(/\s+/g, ' ').trim().toLowerCase();
        if (label) headerMap[label] = i;
    });

    const cell = (tds, label) => {
        const idx = headerMap[label];
        return idx == null ? '' : $(tds.eq(idx)).text().trim();
    };
    // SEC Form 4 anchor is inside "Filing Date" cell
    const linkFrom = (tds, label) => {
        const idx = headerMap[label];
        if (idx == null) return '';
        const href = $(tds.eq(idx)).find('a').attr('href') || '';
        if (!href) return '';
        return /^https?:\/\//i.test(href) ? href : `http://openinsider.com${href}`;
    };

    const rows = [];
    table.find('tbody tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (!tds.length) return;

        const ticker       = cell(tds, 'ticker');
        const company      = cell(tds, 'company name');
        const insiderName  = cell(tds, 'insider name');
        const insiderTitle = cell(tds, 'title');
        const tradeType    = cell(tds, 'trade type'); // ex: "P - Purchase"
        const price        = toMoney(cell(tds, 'price'));
        const shares       = toInt(cell(tds, 'qty'));
        const valueUSD     = toMoney(cell(tds, 'value')) || (price && shares ? price * shares : undefined);

        const tradeDateTxt  = cell(tds, 'trade date');
        const filingDateTxt = cell(tds, 'filing date');
        const tradeDate     = tradeDateTxt  ? new Date(tradeDateTxt)  : null;
        const filingDate    = filingDateTxt ? new Date(filingDateTxt) : new Date();

        const link = linkFrom(tds, 'filing date') || 'http://openinsider.com/';

        // Basic sanity checks
        if (!ticker || !insiderName || !valueUSD) return;

        rows.push({
            ticker,
            company,
            insiderName,
            insiderTitle,
            transaction: tradeType,
            price,
            shares,
            valueUSD,
            tradeDate,
            filingDate,
            link
        });
    });

    if (DEBUG) {
        console.log('[scrape] headers:', headerMap);
        console.log('[scrape] parsed rows:', rows.length);
        console.log('[scrape] sample:', rows.slice(0, 2));
    }

    return rows;
}

/**
 * Scrape N pages. The URL already filters CEO+CFO+Purchases+$500k+, but we also
 * guard with a simple transaction check in code.
 */
export async function scrapeFiltered() {
    let all = [];
    for (let page = 1; page <= PAGES; page++) {
        const url = buildScreenerUrl(page);
        if (DEBUG) console.log('[scrape] GET', url);
        const rows = await fetchScreenerPage(url);
        all = all.concat(rows);
        await delay(1000); // be polite
    }

    // Extra safety: keep purchase-only rows (should already be so)
    const filtered = all.filter((r) =>
        String(r.transaction || '').toLowerCase().includes('purchase')
    );

    if (DEBUG) {
        console.log('[scrape] rawCount:', all.length, 'filteredCount:', filtered.length);
    }
    return filtered;
}

/* --------------------------- Persistence -------------------------- */

export async function saveTrades(pool, trades) {
    for (const r of trades) {
        // upsert company
        const c = await pool.query(
            `INSERT INTO companies(ticker, name)
       VALUES ($1,$2)
       ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
            [r.ticker, r.company || null]
        );
        const companyId = c.rows[0].id;

        // Insert trade; use a *column* conflict target (not a named index)
        await pool.query(
            `INSERT INTO trades(
         company_id, ticker, filing_date, trade_date, insider_name, insider_title,
         transaction, shares, price, value_usd, source_url
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (ticker, insider_name, filing_date, value_usd) DO NOTHING`,
            [
                companyId,
                r.ticker,
                r.filingDate,
                r.tradeDate,
                r.insiderName,
                r.insiderTitle,
                r.transaction,
                r.shares || null,
                r.price || null,
                r.valueUSD,
                r.link
            ]
        );
    }
}

/* ------------------------- Cluster detection ---------------------- */

export async function detectClusters(pool) {
    const windowDays  = Number(process.env.CLUSTER_WINDOW_DAYS || 7);
    const minInsiders = Number(process.env.CLUSTER_MIN_INSIDERS || 2);
    const minTotal    = Number(process.env.CLUSTER_MIN_TOTAL_USD || 500000);

    const { rows } = await pool.query(
        `SELECT *
     FROM trades
     WHERE filing_date >= NOW() - INTERVAL '${windowDays} days'
       AND transaction ILIKE '%purchase%'`
    );

    const byTicker = new Map();
    for (const t of rows) {
        if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
        byTicker.get(t.ticker).push(t);
    }

    for (const [ticker, list] of byTicker) {
        const insiderSet = new Set(list.map((t) => t.insider_name));
        const total = list.reduce((s, t) => s + Number(t.value_usd), 0);

        if (insiderSet.size >= minInsiders && total >= minTotal) {
            const windowStart = new Date(Math.min(...list.map((t) => new Date(t.filing_date).getTime())));
            const windowEnd   = new Date(Math.max(...list.map((t) => new Date(t.filing_date).getTime())));

            const comp = await pool.query('SELECT id FROM companies WHERE ticker=$1', [ticker]);
            if (!comp.rowCount) continue;
            const companyId = comp.rows[0].id;

            // Basic dedupe on same window/ticker sum. If you need stricter dedupe, add a UNIQUE.
            await pool.query(
                `INSERT INTO clusters(
                    company_id, ticker, window_start, window_end,
                    insider_count, trade_count, total_value_usd
                )
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (ticker, window_start, window_end) DO UPDATE
                     SET insider_count   = EXCLUDED.insider_count,
                         trade_count     = EXCLUDED.trade_count,
                         total_value_usd = EXCLUDED.total_value_usd`,
                [
                    companyId,
                    ticker,
                    windowStart,
                    windowEnd,
                    insiderSet.size,
                    list.length,
                    total
                ]
            );
        }
    }
}

/* ---------------------------- Orchestration ----------------------- */

export async function runScrapeAndCluster(pool) {
    const trades = await scrapeFiltered();
    if (DEBUG) console.log('[run] saving trades:', trades.length);
    await saveTrades(pool, trades);
    await detectClusters(pool);
    if (DEBUG) console.log('[run] complete');
}

/* --------------------------- Price caching ------------------------ */

export async function getPriceCached(pool, ticker) {
    // 5-minute cache in DB
    const { rows: recent } = await pool.query(
        `SELECT *
     FROM prices
     WHERE ticker=$1
     ORDER BY as_of DESC
     LIMIT 1`,
        [ticker]
    );
    if (recent.length) {
        const last = recent[0];
        const ageMs = Date.now() - new Date(last.as_of).getTime();
        if (ageMs < 5 * 60 * 1000) return last;
    }

    const q = await yf.quote(ticker);
    const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice;
    if (!price) throw new Error(`No price for ${ticker}`);

    // Ensure company row
    const c = await pool.query(
        `INSERT INTO companies(ticker)
     VALUES ($1)
     ON CONFLICT (ticker) DO NOTHING
     RETURNING id`,
        [ticker]
    );
    const companyId =
        c.rowCount ? c.rows[0].id
            : (await pool.query('SELECT id FROM companies WHERE ticker=$1', [ticker])).rows[0].id;

    const { rows } = await pool.query(
        `INSERT INTO prices(company_id, ticker, as_of, close)
     VALUES ($1,$2,NOW(),$3)
     RETURNING *`,
        [companyId, ticker, price]
    );
    return rows[0];
}
