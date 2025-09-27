// server/src/modelClient.js
// ESM module (your package.json uses "type": "module")
// Node 20+ has global fetch + AbortController

const BASE = process.env.PY_MODEL_URL || "http://model:8000";

const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 25000);
const TIMEOUT_MS_PREDICT = Number(
    process.env.MODEL_TIMEOUT_MS_PREDICT ?? TIMEOUT_MS
);
const TIMEOUT_MS_SCREEN = Number(
    process.env.MODEL_TIMEOUT_MS_SCREEN ?? TIMEOUT_MS
);
const RETRIES = Number(process.env.MODEL_RETRIES ?? 1);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function pickTimeout(path, override) {
    if (typeof override === "number" && override > 0) return override;
    if (path === "/predict") return TIMEOUT_MS_PREDICT;
    if (path === "/screen" || path === "/screen_universe") return TIMEOUT_MS_SCREEN;
    return TIMEOUT_MS;
}

async function httpPostJson(path, body = {}, { timeoutMs } = {}) {
    const url = `${BASE}${path}`;
    let lastErr;

    for (let attempt = 0; attempt <= RETRIES; attempt++) {
        const budget = pickTimeout(path, timeoutMs);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), budget);

        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            clearTimeout(timer);

            if (!res.ok) {
                // Try to read JSON error body if present
                let details = "";
                try {
                    const j = await res.json();
                    if (j && j.error) details = `: ${j.error}`;
                } catch {
                    /* ignore */
                }
                throw new Error(`Model ${path} HTTP ${res.status}${details}`);
            }

            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;

            // If aborted due to timeout, surface a clearer message
            if (err?.name === "AbortError") {
                const e = new Error(
                    `This operation was aborted (timeout ${pickTimeout(path, timeoutMs)} ms)`
                );
                e.name = "AbortError";
                throw e;
            }

            // If out of retries, rethrow
            if (attempt === RETRIES) throw err;

            // Small exponential-ish backoff
            await sleep(300 * (attempt + 1));
        }
    }

    throw lastErr;
}

async function httpGetJson(path, { timeoutMs } = {}) {
    const url = `${BASE}${path}`;
    const budget = pickTimeout(path, timeoutMs);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Model ${path} HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        clearTimeout(timer);
        if (err?.name === "AbortError") {
            const e = new Error(`This operation was aborted (timeout ${budget} ms)`);
            e.name = "AbortError";
            throw e;
        }
        throw err;
    }
}

// === Public API ===

/**
 * Predict next-day log return for a ticker.
 * env timeouts:
 *  - MODEL_TIMEOUT_MS_PREDICT (fallback to MODEL_TIMEOUT_MS)
 */
export async function predictOne({
                                     ticker,
                                     start,
                                     end,
                                     backtest = false,
                                     model = "hgb",
                                     threshold = 0.0015,
                                     allow_short = true,
                                     exit_mode = "oneday",
                                     timeoutMs, // optional per-call override
                                 }) {
    return httpPostJson(
        "/predict",
        { ticker, start, end, backtest, model, threshold, allow_short, exit_mode },
        { timeoutMs }
    );
}

/**
 * Screen an explicit list of symbols.
 * env timeouts:
 *  - MODEL_TIMEOUT_MS_SCREEN (fallback to MODEL_TIMEOUT_MS)
 */
export async function screenSymbols(payload, { timeoutMs } = {}) {
    // payload: { tickers:[], start, end, model, threshold, ... }
    return httpPostJson("/screen", payload, { timeoutMs });
}

/**
 * Screen a known universe (e.g., sp500, nasdaq100, dow30).
 * env timeouts:
 *  - MODEL_TIMEOUT_MS_SCREEN (fallback to MODEL_TIMEOUT_MS)
 */
export async function screenUniverse(payload, { timeoutMs } = {}) {
    // payload: { universe:'sp500'|'nasdaq100'|'dow30', start, end, ... }
    return httpPostJson("/screen_universe", payload, { timeoutMs });
}

/** Optional: simple health check for debugging */
export async function pingModel({ timeoutMs } = {}) {
    return httpGetJson("/health", { timeoutMs });
}
