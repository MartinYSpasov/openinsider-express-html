import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { DEBUG, DAYS, DEFAULT_MIN_BUY_USD, PAGES, USER_AGENT } from './config.js';

const toMoney = s => (s ? Number(String(s).replace(/[+$,]/g, '')) : undefined);
const toInt   = s => (s ? Number(String(s).replace(/[+,]/g,   '')) : undefined);
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const dollarsToVl = usd => Math.max(0, Math.floor((Number(usd) || 0) / 1000)); // OI expects thousands

export function buildScreenerUrl(page = 1, minBuyUSD = DEFAULT_MIN_BUY_USD, days = DAYS) {
    const vl = dollarsToVl(minBuyUSD);
    return `http://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=${days}&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&vl=${vl}&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&isceo=1&iscfo=1&isdirector=1&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=100&page=${page}`;
}

export async function fetchScreenerPage(url) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`OpenInsider ${res.status} ${res.statusText}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const table = $('table.tinytable');
    if (!table.length) {
        if (DEBUG) console.log('[scrape] tinytable not found');
        return [];
    }

    // Build header index
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
        const tradeType    = cell(tds, 'trade type'); // “P - Purchase”
        const price        = toMoney(cell(tds, 'price'));
        const shares       = toInt(cell(tds, 'qty'));
        const valueUSD     = toMoney(cell(tds, 'value')) || (price && shares ? price * shares : undefined);

        const tradeDateTxt  = cell(tds, 'trade date');
        const filingDateTxt = cell(tds, 'filing date');
        const tradeDate     = tradeDateTxt  ? new Date(tradeDateTxt)  : null;
        const filingDate    = filingDateTxt ? new Date(filingDateTxt) : new Date();
        const link          = linkFrom(tds, 'filing date') || 'http://openinsider.com/';

        if (!ticker || !insiderName || !valueUSD) return;

        rows.push({
            ticker,
            company,
            insider_name:  insiderName,
            insider_title: insiderTitle,
            transaction:   tradeType,
            price,
            shares,
            value_usd:     valueUSD,
            trade_date:    tradeDate,
            filing_date:   filingDate,
            source_url:    link
        });
    });

    if (DEBUG) console.log('[scrape] parsed rows:', rows.length);
    return rows;
}

export async function scrapePurchases({ minBuyUSD = DEFAULT_MIN_BUY_USD, pages = PAGES, days = DAYS } = {}) {
    let all = [];
    for (let page = 1; page <= pages; page++) {
        const url = buildScreenerUrl(page, minBuyUSD, days);
        if (DEBUG) console.log('[scrape] GET', url);
        const rows = await fetchScreenerPage(url);
        all = all.concat(rows);
        await sleep(900);
    }
    return all.filter(r => String(r.transaction || '').toLowerCase().includes('purchase'));
}
