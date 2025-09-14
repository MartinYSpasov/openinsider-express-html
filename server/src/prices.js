import yf from 'yahoo-finance2';
import { getCompanyId, insertPrice, lastPrice, upsertCompany } from './repos.js';

export async function getPriceCached(pool, ticker) {
    const recent = await lastPrice(pool, ticker);
    if (recent) {
        const ageMs = Date.now() - new Date(recent.as_of).getTime();
        if (ageMs < 5 * 60 * 1000) return recent;
    }

    const q = await yf.quote(ticker);
    const price = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice;
    if (!price) throw new Error(`No price for ${ticker}`);

    let companyId = await getCompanyId(pool, ticker);
    if (!companyId) companyId = await upsertCompany(pool, ticker);

    return insertPrice(pool, companyId, ticker, new Date(), price);
}
