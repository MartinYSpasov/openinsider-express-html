// server/src/logic.js
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import yf from 'yahoo-finance2';


const DEFAULT_MIN_BUY_USD = Number(process.env.MIN_BUY_USD || 500000);
const dollarsToVl = usd => Math.max(0, Math.floor((Number(usd) || 0) / 1000));

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const toMoney = (s) => (s ? Number(String(s).replace(/[+$,]/g, '')) : undefined);
const toInt   = (s) => (s ? Number(String(s).replace(/[+,]/g,   '')) : undefined);
const DEBUG = !!process.env.DEBUG_SCRAPE;
const PAGES = Number(process.env.PAGES || 1);


// replace your builder with this
export function buildScreenerUrl(page = 1, minBuyUSD = DEFAULT_MIN_BUY_USD) {
    const vl = dollarsToVl(minBuyUSD); // OpenInsider expects thousands (500 -> $500k)
    return `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=30&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&vl=${vl}&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&isceo=1&iscfo=1&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&page=${page}`;
}

// Parse <table class="tinytable"> using header labels
export async function fetchScreenerPage(url) {
    const ua = process.env.USER_AGENT || 'Mozilla/5.0';
    const res = await fetch(url, { headers: { 'User-Agent': ua } });
    if (!res.ok) throw new Error(`OpenInsider ${res.status} ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const table = $('table.tinytable');
    if (!table.length) {
        if (DEBUG) console.log('[scrape] tinytable not found');
        return [];
    }

    const headerMap = {};
    table.find('thead tr').first().find('th').each((i, th) => {
        const label = $(th).text().replace(/\s+/g, ' ').trim().toLowerCase();
        if (label) headerMap[label] = i;
    });

    const cell = (tds, label) => {
        const idx = headerMap[label];
        return idx == null ? '' : $(tds.eq(idx)).text().trim();
    };
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
        const tradeType    = cell(tds, 'trade type'); // "P - Purchase"
        const price        = toMoney(cell(tds, 'price'));
        const shares       = toInt(cell(tds, 'qty'));
        const valueUSD     = toMoney(cell(tds, 'value')) || (price && shares ? price * shares : undefined);

        const tradeDateTxt  = cell(tds, 'trade date');
        const filingDateTxt = cell(tds, 'filing date');
        const tradeDate     = tradeDateTxt  ? new Date(tradeDateTxt)  : null;
        const filingDate    = filingDateTxt ? new Date(filingDateTxt) : new Date();

        const link = linkFrom(tds, 'filing date') || 'http://openinsider.com/';

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

// pass minBuy through every page fetch
export async function scrapeFiltered(minBuyUSD = DEFAULT_MIN_BUY_USD) {
    let all = [];
    for (let page = 1; page <= PAGES; page++) {
        const url = buildScreenerUrl(page, minBuyUSD);
        if (DEBUG) console.log('[scrape] GET', url);
        const rows = await fetchScreenerPage(url);
        all = all.concat(rows);
        await delay(900);
    }
    return all.filter(r => String(r.transaction || '').toLowerCase().includes('purchase'));
}


export async function saveTrades(pool, trades) {
    for (const r of trades) {
        const c = await pool.query(
            `INSERT INTO companies(ticker, name)
             VALUES ($1,$2)
             ON CONFLICT (ticker) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [r.ticker, r.company || null]
        );
        const companyId = c.rows[0].id;

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

export async function detectClusters(pool, { minBuyUSD = 0 } = {}) {
    const windowDays  = Number(process.env.CLUSTER_WINDOW_DAYS || 7);
    const minInsiders = Number(process.env.CLUSTER_MIN_INSIDERS || 2);
    const minTotal    = Number(process.env.CLUSTER_MIN_TOTAL_USD || 500000);

    const { rows } = await pool.query(
        `SELECT *
         FROM trades
         WHERE filing_date >= NOW() - INTERVAL '${windowDays} days'
           AND transaction ILIKE '%purchase%'
           AND ( $1::numeric = 0 OR value_usd >= $1 )`,
        [minBuyUSD]
);

    const byTicker = new Map();
    for (const t of rows) {
        if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
        byTicker.get(t.ticker).push(t);
    }

    for (const [ticker, list] of byTicker) {
        const insiderSet = new Set(list.map(t => t.insider_name));
        const total = list.reduce((s, t) => s + Number(t.value_usd), 0);

        if (insiderSet.size >= minInsiders && total >= Math.max(minTotal, minBuyUSD)) {
            const windowStart = new Date(Math.min(...list.map(t => new Date(t.filing_date).getTime())));
            const windowEnd   = new Date(Math.max(...list.map(t => new Date(t.filing_date).getTime())));

            const comp = await pool.query('SELECT id FROM companies WHERE ticker=$1', [ticker]);
            if (!comp.rowCount) continue;
            const companyId = comp.rows[0].id;

            await pool.query(
                `INSERT INTO clusters(
                    company_id, ticker, window_start, window_end, insider_count, trade_count, total_value_usd
                )
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (ticker, window_start, window_end) DO UPDATE
                     SET insider_count=$5, trade_count=$6, total_value_usd=$7`,
                [companyId, ticker, windowStart, windowEnd, insiderSet.size, list.length, total]
            );
        }
    }
}


// REPLACE your current runScrapeAndCluster signature/body with this:
// allow run() to accept minBuyUSD
export async function runScrapeAndCluster(pool, { minBuyUSD = DEFAULT_MIN_BUY_USD } = {}) {
    const trades = await scrapeFiltered(minBuyUSD);
    if (DEBUG) console.log('[run] saving trades:', trades.length);
    await saveTrades(pool, trades);
    await detectClusters(pool, { minBuyUSD }); // pass to clusters, too
    if (DEBUG) console.log('[run] complete');
}

export async function getPriceCached(pool, ticker) {
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

    const c = await pool.query(
        `INSERT INTO companies(ticker)
         VALUES ($1)
         ON CONFLICT (ticker) DO NOTHING
         RETURNING id`,
        [ticker]
    );
    const companyId = c.rowCount
        ? c.rows[0].id
        : (await pool.query('SELECT id FROM companies WHERE ticker=$1', [ticker])).rows[0].id;

    const { rows } = await pool.query(
        `INSERT INTO prices(company_id, ticker, as_of, close)
         VALUES ($1,$2,NOW(),$3)
         RETURNING *`,
        [companyId, ticker, price]
    );
    return rows[0];
}
