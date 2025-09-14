import OpenAI from "openai";

import {Pool} from "pg";
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: DATABASE_URL });

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function summariseCompany(ticker) {
    // 1. Fetch insider trades & score
    const { rows: trades } = await pool.query(
        `SELECT * FROM trades WHERE ticker=$1 ORDER BY filing_date DESC LIMIT 5`, [ticker]
    );
    const { rows: clusters } = await pool.query(
        `SELECT * FROM clusters WHERE ticker=$1 ORDER BY window_end DESC LIMIT 1`, [ticker]
    );

    // TODO: fetch fundamentals & news here from external API

    const prompt = `
You are a financial analyst. Summarise whether ${ticker} is a good buy based on:
- Insider trades (CEO/CFO, amounts, timing)
- Cluster signals
- Recent price performance
- Valuation and financial health (if data provided)
- Risks

Data:
Insider trades: ${JSON.stringify(trades, null, 2)}
Clusters: ${JSON.stringify(clusters, null, 2)}

Write a concise, professional summary (max 300 words).
`;

    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
    });

    return completion.choices[0].message.content;
}
