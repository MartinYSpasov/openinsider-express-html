from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import List, Dict, Any
import pandas as pd
import numpy as np
import os
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
import io
import requests

from arima_fourier_ta_strategy import (
    build_features,
    train_predict_walkforward,
    SignalConfig,
    ExecConfig,
    PortfolioConfig,
    backtest_multi,
    load_data,
    perf_metrics,
)

app = FastAPI(title="ARIMA+FFT+TA Stock Predictor & Screener")

# ----------------------
# Caching helpers
# ----------------------
def sanitize_ticker(t: str) -> str:
    return t.replace("/", "_").replace("\\", "_").replace(" ", "_")

def cache_path(cache_dir: str, ticker: str, start: str, end: str) -> str:
    t = sanitize_ticker(ticker)
    return os.path.join(cache_dir, f"prices_{t}_{start}_{end}.csv")

def is_fresh(path: str, hours: float) -> bool:
    if not os.path.exists(path):
        return False
    age = time.time() - os.path.getmtime(path)
    return age <= hours * 3600.0

def load_data_cached(
        ticker: str,
        start: str,
        end: str,
        cache_dir: str = ".cache",
        cache_hours: float = 20.0,
) -> pd.DataFrame:
    os.makedirs(cache_dir, exist_ok=True)
    p = cache_path(cache_dir, ticker, start, end)
    if is_fresh(p, cache_hours):
        try:
            df = pd.read_csv(p, parse_dates=True, index_col=0)
            if not df.empty:
                return df
        except Exception:
            pass
    df = load_data(ticker, start, end)
    try:
        df.to_csv(p)
    except Exception:
        pass
    return df

# --- lightweight HTML fetch with UA & retries ---
_SCRAPER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

def _fetch_html(url: str, timeout: int = 10, retries: int = 3, backoff: float = 0.75) -> str:
    last_exc = None
    for i in range(retries):
        try:
            r = requests.get(
                url,
                headers={"User-Agent": _SCRAPER_UA, "Accept-Language": "en-US,en;q=0.9"},
                timeout=timeout,
            )
            if r.status_code == 200:
                return r.text
            last_exc = RuntimeError(f"HTTP {r.status_code} on {url}")
        except Exception as e:
            last_exc = e
        time.sleep(backoff * (i + 1))
    raise last_exc or RuntimeError(f"failed to fetch {url}")

# --- 24h in-memory cache for universes ---
_UNI_CACHE: Dict[str, Any] = {}  # key -> (expires_epoch, list[str])

def _cache_get(key: str):
    exp_val = _UNI_CACHE.get(key)
    if not exp_val:
        return None
    exp, val = exp_val
    if time.time() < exp:
        return val
    _UNI_CACHE.pop(key, None)
    return None

def _cache_set(key: str, val, ttl_sec: int = 24 * 3600):
    _UNI_CACHE[key] = (time.time() + ttl_sec, val)

def _extract_symbols(tables) -> List[str]:
    # Find the first table that has a ticker-ish column and return symbols
    for df in tables:
        for col in ("Symbol", "Ticker", "Ticker symbol"):
            if col in df.columns:
                syms = (
                    df[col]
                    .dropna()
                    .astype(str)
                    .map(lambda s: s.strip().upper().replace(".", "-"))
                    .tolist()
                )
                if syms:
                    return syms
    return []

# ----------------------
# Universes
# ----------------------
def universe_sp500() -> List[str]:
    key = "sp500"
    cached = _cache_get(key)
    if cached:
        return cached
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    html = _fetch_html(url)
    tables = pd.read_html(io.StringIO(html))
    syms = _extract_symbols(tables)
    if not syms:
        raise RuntimeError("Could not extract SP500 symbols")
    _cache_set(key, syms)
    return syms

def universe_nasdaq100() -> List[str]:
    key = "nasdaq100"
    cached = _cache_get(key)
    if cached:
        return cached
    url = "https://en.wikipedia.org/wiki/NASDAQ-100"
    html = _fetch_html(url)
    tables = pd.read_html(io.StringIO(html))
    syms = _extract_symbols(tables)
    if not syms:
        raise RuntimeError("Could not extract NASDAQ-100 symbols")
    _cache_set(key, syms)
    return syms

def universe_dow30() -> List[str]:
    key = "dow30"
    cached = _cache_get(key)
    if cached:
        return cached
    url = "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average"
    html = _fetch_html(url)
    tables = pd.read_html(io.StringIO(html))
    syms = _extract_symbols(tables)
    if not syms:
        raise RuntimeError("Could not extract Dow 30 symbols")
    _cache_set(key, syms)
    return syms

def get_universe(name: str) -> List[str]:
    n = (name or "").lower()
    try:
        if n in ("sp500", "s&p500", "s&p 500"):
            return universe_sp500()
        if n in ("nasdaq100", "ndx", "nas100"):
            return universe_nasdaq100()
        if n in ("dow30", "djia", "dow"):
            return universe_dow30()
        # small ETF shorthands
        if n == "qqq":
            return universe_nasdaq100()
        if n == "spy":
            return universe_sp500()
    except Exception as e:
        # Keep the API alive with a compact fallback set; also log
        print(f"[universe] failed to fetch '{name}': {e}")
        return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "BRK-B", "JPM", "XOM", "JNJ"]

    raise ValueError(f"Unknown universe: {name}")

# ----------------------
# Request models
# ----------------------
class PredictRequest(BaseModel):
    ticker: str = Field(..., description="e.g., AAPL")
    start: str = Field(..., description="YYYY-MM-DD")
    end: str = Field(..., description="YYYY-MM-DD")
    model: str = Field("hgb", description="linear|mlp|hgb")
    threshold: float = Field(0.0015, description="log-return threshold")
    exit_mode: str = Field("oneday", description="oneday|swing")
    allow_short: bool = Field(True, description="allow shorts")
    backtest: bool = Field(False, description="run a backtest")
    cache_dir: str = ".cache"
    cache_hours: float = 20.0

class ScreenRequest(BaseModel):
    tickers: List[str]
    start: str
    end: str
    model: str = "hgb"
    threshold: float = 0.0015
    allow_short: bool = True
    exit_mode: str = "oneday"
    open_slip: float = 5.0
    close_slip: float = 5.0
    comm_bps: float = 1.0
    top_k: int = 3
    target_risk: float = 0.02
    min_years: float = 3.0
    min_dollar_vol: float = 5e7
    top_n: int = 20
    jobs: int = 4
    cache_dir: str = ".cache"
    cache_hours: float = 20.0

class ScreenUniverseRequest(BaseModel):
    universe: str
    start: str
    end: str
    model: str = "hgb"
    threshold: float = 0.0015
    allow_short: bool = True
    exit_mode: str = "oneday"
    open_slip: float = 5.0
    close_slip: float = 5.0
    comm_bps: float = 1.0
    top_k: int = 3
    target_risk: float = 0.02
    min_years: float = 3.0
    min_dollar_vol: float = 5e7
    top_n: int = 20
    jobs: int = 4
    cache_dir: str = ".cache"
    cache_hours: float = 20.0

# ----------------------
# JSON sanitization (avoid NaN/Inf in responses)
# ----------------------
def _is_finite_number(x) -> bool:
    try:
        return np.isfinite(float(x))
    except Exception:
        return False

def _to_iso_date(x):
    try:
        return pd.Timestamp(x).strftime("%Y-%m-%d")
    except Exception:
        return str(x)

def json_sanitize(obj):
    """Recursively make objects JSON-safe for Starlette (no NaN/Inf)."""
    if obj is None:
        return None
    if isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (int,)):
        return obj
    if isinstance(obj, (np.floating, float)):
        return float(obj) if _is_finite_number(obj) else None
    if isinstance(obj, (pd.Timestamp, np.datetime64)):
        return _to_iso_date(obj)
    if isinstance(obj, pd.Series):
        if isinstance(obj.index, pd.DatetimeIndex):
            return [{"date": _to_iso_date(ix), "value": json_sanitize(val)} for ix, val in obj.items()]
        return json_sanitize(obj.to_dict())
    if isinstance(obj, pd.DataFrame):
        return [json_sanitize(rec) for rec in obj.to_dict(orient="records")]
    if isinstance(obj, dict):
        return {str(k): json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_sanitize(v) for v in obj]
    try:
        return float(obj) if _is_finite_number(obj) else str(obj)
    except Exception:
        return str(obj)

# ----------------------
# Metrics helpers
# ----------------------
def info_coeff(y_true: pd.Series, y_pred: pd.Series) -> float:
    idx = y_true.index.intersection(y_pred.index)
    a = y_true.loc[idx].astype(float)
    b = y_pred.loc[idx].astype(float)
    if len(a) < 5:
        return float("nan")
    return float(a.corr(b, method="spearman"))

def avg_dollar_vol(df: pd.DataFrame) -> float:
    px = df["Adj Close"].astype(float)
    vol = df["Volume"].astype(float)
    return float((px * vol).rolling(20).mean().dropna().mean())

def turnover(weights_df: pd.DataFrame) -> float:
    if weights_df.empty:
        return 0.0
    dw = weights_df.diff().abs().sum(axis=1)
    return float((0.5 * dw).mean())

# ----------------------
# Core processing
# ----------------------
def process_one(tic: str, start: str, end: str, req) -> Dict[str, Any]:
    try:
        df = load_data_cached(tic, start, end, cache_dir=req.cache_dir, cache_hours=req.cache_hours)
        years = (df.index[-1] - df.index[0]).days / 365.25
        if years < req.min_years:
            return {"ticker": tic, "status": "too_short", "years": years}
        adv = avg_dollar_vol(df)
        if not np.isfinite(adv) or adv < req.min_dollar_vol:
            return {"ticker": tic, "status": "illiquid", "avg_dollar_vol": adv, "years": years}

        feat = build_features(df).dropna(subset=["target_next_logret"]).copy()
        preds, cv = train_predict_walkforward(
            feat, model_name=req.model,
            train_min=504, test_size=63, step_size=63, embargo=0
        )
        ic = info_coeff(feat["target_next_logret"], preds.dropna())

        sig_cfg = SignalConfig(
            mode=req.exit_mode,
            threshold_long=req.threshold,
            threshold_short=req.threshold,
            allow_short=req.allow_short
        )
        ex_cfg = ExecConfig(
            open_slippage_bps=req.open_slip,
            close_slippage_bps=req.close_slip,
            commission_bps=req.comm_bps
        )
        port_cfg = PortfolioConfig(top_k=req.top_k, target_daily_risk=req.target_risk)

        eq, trades, weights = backtest_multi(
            [tic], {tic: df}, {tic: feat}, {tic: preds},
            sig_cfg, ex_cfg, port_cfg, exit_mode=req.exit_mode
        )
        metrics = perf_metrics(eq)
        turo = turnover(weights)

        return {
            "ticker": tic,
            "status": "ok",
            "CV_MSE": cv.get("CV_MSE"),
            "CV_MAE": cv.get("CV_MAE"),
            "CV_R2": cv.get("CV_R2"),
            "IC": ic,
            "Sharpe": metrics.get("Sharpe"),
            "Sortino": metrics.get("Sortino"),
            "CAGR": metrics.get("CAGR"),
            "MaxDD": metrics.get("MaxDD"),
            "Calmar": metrics.get("Calmar"),
            "HitRate": metrics.get("HitRate"),
            "TotalReturn": metrics.get("TotalReturn"),
            "Turnover": turo,
            "Trades": int(len(trades)),
            "avg_dollar_vol": float(adv),
        }
    except Exception as e:
        return {"ticker": tic, "status": "error", "error": str(e)}

def rank_rows(rows: List[Dict[str, Any]], top_n: int) -> List[Dict[str, Any]]:
    df = pd.DataFrame(rows)
    ok = df[df["status"] == "ok"].copy()
    if ok.empty:
        return []
    for col in ["Sharpe", "IC", "CAGR", "CV_R2"]:
        ok[col + "_z"] = (ok[col] - ok[col].mean()) / (ok[col].std() + 1e-12)
    ok["Turnover_z"] = (ok["Turnover"] - ok["Turnover"].mean()) / (ok["Turnover"].std() + 1e-12)
    ok["Score"] = (
            0.5 * ok["Sharpe_z"]
            + 0.2 * ok["CAGR_z"]
            + 0.2 * ok["IC_z"]
            + 0.1 * ok["CV_R2_z"]
            - 0.2 * ok["Turnover_z"]
    )
    ok = ok.sort_values("Score", ascending=False).drop(
        columns=[c for c in ok.columns if c.endswith("_z")]
    )
    return ok.head(top_n).to_dict(orient="records")

# ----------------------
# Routes
# ----------------------
@app.get("/health")
def health():
    return JSONResponse(content={"status": "ok"})

@app.post("/predict")
def predict(req: PredictRequest):
    """
    Return next-day prediction (log return) and optional backtest summary.
    Robust to empty/NaN predictions and cold starts (no NaT indexing).
    """
    # --- Load & build features (lighter settings for speed on /predict) ---
    df = load_data_cached(
        req.ticker, req.start, req.end,
        cache_dir=req.cache_dir, cache_hours=req.cache_hours
    )

    feat = build_features(df, fft_window=128, fft_topk=3)
    feat = feat.dropna(subset=["target_next_logret"]).copy()

    # If we can't make features/targets, return a graceful payload
    if feat.empty:
        payload = {
            "ticker": req.ticker,
            "asof": None,
            "next_day_pred_logret": None,
            "cv": {"Model": req.model, "Splits": 0, "CV_MSE": None, "CV_MAE": None, "CV_R2": None},
            "recent_predictions": [],
            "note": "No sufficient feature/target rows after preprocessing."
        }
        return JSONResponse(content=json_sanitize(payload))

    # --- Walk-forward train/predict (trimmed CV for responsiveness) ---
    preds, cv = train_predict_walkforward(
        feat, model_name=req.model,
        train_min=252, test_size=21, step_size=21, embargo=0
    )

    # --- Robust extraction of last prediction (avoid KeyError: NaT) ---
    last_idx = preds.last_valid_index()  # None if all-NaN
    if last_idx is not None:
        try:
            val = preds.loc[last_idx]
            last_pred = float(val) if pd.notna(val) else None
            asof = last_idx.strftime("%Y-%m-%d") if hasattr(last_idx, "strftime") else str(last_idx)
        except Exception:
            last_pred, asof = None, None
    else:
        last_pred, asof = None, None

    result: Dict[str, Any] = {
        "ticker": req.ticker,
        "asof": asof,
        "next_day_pred_logret": last_pred,
        "cv": cv,
    }

    # --- Optional backtest (uses same preds/features; safe if preds are NaN) ---
    if req.backtest:
        sig_cfg = SignalConfig(
            mode=req.exit_mode,
            threshold_long=req.threshold,
            threshold_short=req.threshold,
            allow_short=req.allow_short
        )
        ex_cfg = ExecConfig()  # default bps costs
        port_cfg = PortfolioConfig(top_k=1, target_daily_risk=0.02)

        eq_df, trades_df, weights_df = backtest_multi(
            tickers=[req.ticker],
            data={req.ticker: df},
            feats={req.ticker: feat},
            preds={req.ticker: preds},
            sig_cfg=sig_cfg,
            ex_cfg=ex_cfg,
            port_cfg=port_cfg,
            exit_mode=req.exit_mode
        )
        metrics = perf_metrics(eq_df)
        result["backtest"] = {
            "metrics": metrics,
            "trades": trades_df.tail(50).to_dict(orient="records")
        }

    # --- Recent predictions preview for UI/debugging ---
    preview = preds.dropna().tail(30)
    result["recent_predictions"] = [
        {"date": (d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)), "pred": float(v)}
        for d, v in preview.items()
    ]

    return JSONResponse(content=json_sanitize(result))

@app.post("/screen")
def screen(req: ScreenRequest):
    jobs = [(tic, req.start, req.end, req) for tic in req.tickers]
    rows: List[Dict[str, Any]] = []
    if req.jobs <= 1:
        for j in jobs:
            rows.append(process_one(*j))
    else:
        with ProcessPoolExecutor(max_workers=req.jobs) as ex:
            futs = [ex.submit(process_one, *j) for j in jobs]
            for fut in as_completed(futs):
                rows.append(fut.result())
    ranking = rank_rows(rows, req.top_n)
    return JSONResponse(content=json_sanitize({"results": rows, "ranking": ranking}))

@app.post("/screen_universe")
def screen_universe(req: ScreenUniverseRequest):
    tickers = get_universe(req.universe)
    if not tickers:
        return JSONResponse(content=json_sanitize({
            "results": [],
            "ranking": [],
            "error": f"Unknown or empty universe: {req.universe}"
        }))
    # Build a valid ScreenRequest (field names must match exactly)
    subreq = ScreenRequest(
        tickers=tickers,
        start=req.start,
        end=req.end,
        model=req.model,
        threshold=req.threshold,
        allow_short=req.allow_short,
        exit_mode=req.exit_mode,
        open_slip=req.open_slip,
        close_slip=req.close_slip,
        comm_bps=req.comm_bps,
        top_k=req.top_k,
        target_risk=req.target_risk,
        min_years=req.min_years,
        min_dollar_vol=req.min_dollar_vol,
        top_n=req.top_n,
        jobs=req.jobs,
        cache_dir=req.cache_dir,
        cache_hours=req.cache_hours,
    )
    # Reuse the /screen logic
    resp = screen(subreq)  # returns a JSONResponse
    return resp
