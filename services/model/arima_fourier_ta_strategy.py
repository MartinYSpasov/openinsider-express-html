#!/usr/bin/env python3
"""
ARIMA + Rolling-FFT + Technical Indicators (EMA/RSI/MACD/OBV/ATR)
Ensemble Prediction + Walk-Forward Backtest + Portfolio Construction

This script turns the ARIMA + Fourier + Technical Indicators idea into a
deployable research backtest with leakage-safe features, walk-forward CV,
risk-based sizing, and multiple model options (Linear, MLP, HGB).

------------------------------------------------------------
Quick start:

  pip install numpy pandas scikit-learn statsmodels yfinance matplotlib
  python arima_fourier_ta_strategy.py --tickers SPY AAPL MSFT \
      --start 2015-01-01 --end 2025-09-01 --model hgb \
      --exit_mode oneday --allow_short --top_k 3 --threshold 0.0015

Outputs (in current folder, prefixed by --out_prefix):
  - <prefix>_equity.csv     : daily NAV and returns
  - <prefix>_trades.csv     : trade log
  - <prefix>_weights.csv    : daily portfolio weights by symbol
  - <prefix>_metrics.json   : summary performance metrics
  - <prefix>_cv_<TICKER>.json : per-ticker CV stats
  - <prefix>_equity.png     : equity curve plot

Notes / Assumptions:
  - Signals are generated after the close of day t (using only info up to t).
    Orders are executed at the open of day t+1 (signal is shifted +1 day).
  - Exit modes:
      * oneday: enter at today's open; exit at today's close.
      * swing : ATR-based stop/TP with a max holding period; checks daily.
  - This is educational code. Backtest thoroughly and paper trade first.
"""

import argparse
import warnings
from dataclasses import dataclass
from typing import List, Tuple, Dict, Optional
import numpy as np
import pandas as pd
import math
import json
import copy

# External dependencies
import matplotlib.pyplot as plt

try:
    import yfinance as yf
except Exception:
    yf = None

try:
    import statsmodels.api as sm
    from statsmodels.tsa.arima.model import ARIMA
except Exception:
    sm = None
try:
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LinearRegression
    from sklearn.neural_network import MLPRegressor
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
except Exception:
    pass

warnings.filterwarnings("ignore")

# -----------------------------
# Technical Indicators
# -----------------------------
def ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    ma_up = up.rolling(period).mean()
    ma_down = down.rolling(period).mean()
    rs = ma_up / (ma_down + 1e-12)
    return 100 - (100 / (1 + rs))

def macd(series: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9):
    ema_fast = ema(series, fast)
    ema_slow = ema(series, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist

def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direction = np.sign(close.diff()).fillna(0.0)
    return (direction * volume).fillna(0.0).cumsum()

def true_range(high: pd.Series, low: pd.Series, close: pd.Series) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return tr

def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    tr = true_range(high, low, close)
    return tr.rolling(period).mean()

# -----------------------------
# Rolling FFT features
# -----------------------------
def rolling_fft_features(close: pd.Series, window: int = 256, top_k: int = 5) -> pd.DataFrame:
    """
    Leak-safe FFT features using rolling windows (only past 'window' bars).
    Produces:
      - fft_power_1..K : power of top low-frequency components
      - fft_phase_1..K : phase of those components
      - fft_trend_slope: slope of reconstructed low-frequency series tail
    """
    n = len(close)
    idx = close.index

    cols = {**{f"fft_power_{i+1}": np.full(n, np.nan) for i in range(top_k)},
            **{f"fft_phase_{i+1}": np.full(n, np.nan) for i in range(top_k)},
            "fft_trend_slope": np.full(n, np.nan)}

    # Force 1-D float array
    x = np.asarray(close.astype(float).values, dtype=float).ravel()

    for t in range(window, n):
        seg = x[t - window:t]
        if not np.isfinite(seg).all():
            continue

        seg = seg - seg.mean()

        fft_vals = np.fft.rfft(seg)
        amps = np.abs(fft_vals)
        # remove DC
        if amps.size > 0:
            amps[0] = 0.0

        # focus on low-frequency quarter to avoid noise
        band = max(int(len(amps) * 0.25), top_k + 1)
        band = min(band, len(amps))  # clamp
        if band <= 1:
            continue

        idxs = np.argsort(amps[:band])[::-1]
        idxs = [k for k in idxs if k != 0][:top_k]

        # Reconstruct only selected low-freq components
        recon = np.zeros(fft_vals.shape, dtype=fft_vals.dtype)
        for j, k in enumerate(idxs):
            cols[f"fft_power_{j+1}"][t] = (amps[k] ** 2) / window
            cols[f"fft_phase_{j+1}"][t] = float(np.angle(fft_vals[k]))
            recon[k] = fft_vals[k]

        lowf = np.fft.irfft(recon, n=window).real
        # last 20% of the reconstructed series
        tail = np.asarray(lowf[int(window * 0.8):], dtype=float).ravel()

        if tail.size >= 2:
            xidx = np.arange(tail.size, dtype=float)
            # robust 1-D slope (avoid broadcasting issues)
            slope = np.polyfit(xidx, tail, 1)[0]
            cols["fft_trend_slope"][t] = float(slope)

    return pd.DataFrame(cols, index=idx)


# -----------------------------
# ARIMA rolling forecast
# -----------------------------
def select_arima_order(series: pd.Series,
                       d_choices=(0,1),
                       p_max=3, q_max=3,
                       min_len=200) -> Tuple[int,int,int]:
    """Small AIC grid on early segment to choose (p,d,q)."""
    if sm is None or len(series.dropna()) < min_len:
        return (1,1,1)
    y = series.dropna()
    init_end = max(min_len, int(len(y)*0.5))
    y_init = y.iloc[:init_end]
    best = (1,1,1)
    best_aic = np.inf
    for d in d_choices:
        for p in range(0, p_max+1):
            for q in range(0, q_max+1):
                if p==0 and d==0 and q==0:
                    continue
                try:
                    res = ARIMA(y_init, order=(p,d,q)).fit(method_kwargs={"warn_convergence": False})
                    if res.aic < best_aic:
                        best_aic = res.aic
                        best = (p,d,q)
                except Exception:
                    continue
    return best

def rolling_arima_one_step(close: pd.Series,
                           window: int = 252,
                           refit_every: int = 21,
                           order: Optional[Tuple[int,int,int]] = None) -> pd.Series:
    """1-step-ahead forecasts using rolling ARIMA; refit periodically."""
    n = len(close)
    idx = close.index
    out = np.full(n, np.nan)
    if sm is None:
        return pd.Series(out, index=idx, name="arima_forecast")

    if order is None:
        order = select_arima_order(close)

    i = window
    while i < n:
        j_end = min(i + refit_every, n)
        train = close.iloc[i-window:i].dropna()
        if len(train) < max(32, window//4):
            i = j_end
            continue
        try:
            res = ARIMA(train, order=order).fit(method_kwargs={"warn_convergence": False})
            # Step through the segment and forecast one-step each day
            for j in range(i, j_end):
                # Forecast next step based on data up to j-1
                hist = close.iloc[i-window:j].dropna()
                if len(hist) == 0:
                    continue
                try:
                    f = res.predict(start=hist.index[-1], end=hist.index[-1], dynamic=False)[-1]
                except Exception:
                    f = res.forecast(1).iloc[-1]
                out[j] = f
        except Exception:
            pass
        i = j_end

    return pd.Series(out, index=idx, name="arima_forecast")

# -----------------------------
# Features
# -----------------------------
def build_features(df: pd.DataFrame, fft_window: int = 256, fft_topk: int = 5) -> pd.DataFrame:
    """
    Input df columns: Open, High, Low, Close, Adj Close, Volume
    Output dataframe includes features + 'target_next_logret'
    """
    close = df["Adj Close"].astype(float)
    high  = df["High"].astype(float)
    low   = df["Low"].astype(float)
    vol   = df["Volume"].astype(float)

    feat = pd.DataFrame(index=df.index)

    # ARIMA 1-step forecast
    feat["arima_forecast"] = rolling_arima_one_step(close)

    # Rolling FFT
    fft_df = rolling_fft_features(close, window=fft_window, top_k=fft_topk)
    feat = feat.join(fft_df)

    # Technicals
    feat["ema20"] = ema(close, 20)
    feat["ema50"] = ema(close, 50)
    feat["ema100"] = ema(close, 100)
    feat["rsi14"] = rsi(close, 14)

    macd_line, macd_sig, macd_hist = macd(close)
    feat["macd_line"] = macd_line
    feat["macd_signal"] = macd_sig
    feat["macd_hist"] = macd_hist

    feat["obv"] = obv(close, vol).fillna(0.0)
    feat["atr14"] = atr(high, low, close, 14)

    # Gaps/returns
    feat["ema_gap_20_50"] = feat["ema20"] - feat["ema50"]
    feat["ema_gap_50_100"] = feat["ema50"] - feat["ema100"]
    feat["ret_1"] = np.log(close/close.shift(1))
    feat["ret_5"] = np.log(close/close.shift(5))
    feat["ret_20"] = np.log(close/close.shift(20))

    # Target: next-day log return
    feat["target_next_logret"] = np.log(close.shift(-1) / close)

    return feat

# -----------------------------
# Walk-forward splits
# -----------------------------
def walk_forward_splits(dates: pd.DatetimeIndex,
                        train_min: int = 756,
                        test_size: int = 63,
                        step_size: int = 63,
                        embargo: int = 0) -> List[Tuple[np.ndarray, np.ndarray]]:
    n = len(dates)
    splits = []
    start = 0
    while True:
        train_end = start + train_min
        test_end = min(train_end + embargo + test_size, n)
        if train_end >= n or test_end - (train_end + embargo) <= 0:
            break
        train_idx = np.arange(0, train_end)
        test_idx = np.arange(train_end + embargo, test_end)
        splits.append((train_idx, test_idx))
        if test_end >= n or (start + step_size) >= n:
            break
        start += step_size
    return splits

# -----------------------------
# Models
# -----------------------------
def get_models(random_state=42) -> Dict[str, object]:
    models = {"linear": LinearRegression()}
    try:
        models["mlp"] = MLPRegressor(hidden_layer_sizes=(64, 32),
                                     activation="relu",
                                     alpha=1e-4,
                                     learning_rate_init=1e-3,
                                     max_iter=500,
                                     random_state=random_state,
                                     early_stopping=True,
                                     n_iter_no_change=20)
    except Exception:
        pass
    try:
        models["hgb"] = HistGradientBoostingRegressor(max_depth=6,
                                                      max_iter=500,
                                                      learning_rate=0.05,
                                                      l2_regularization=1e-3,
                                                      random_state=random_state)
    except Exception:
        pass
    return models

# -----------------------------
# Signal & Portfolio config
# -----------------------------
@dataclass
class SignalConfig:
    mode: str = "oneday"         # "oneday" or "swing"
    threshold_long: float = 0.001
    threshold_short: float = 0.001
    allow_short: bool = True
    max_hold_days: int = 5       # for swing
    atr_stop_mult: float = 2.0   # for swing
    atr_tp_mult: float = 3.0     # for swing

@dataclass
class ExecConfig:
    open_slippage_bps: float = 5.0
    close_slippage_bps: float = 5.0
    commission_bps: float = 1.0

@dataclass
class PortfolioConfig:
    top_k: int = 5
    vol_lookback: int = 20
    target_daily_risk: float = 0.02
    max_gross: float = 0.6
    max_net: float = 0.4

# -----------------------------
# Signals
# -----------------------------
def regime_filters(row: pd.Series) -> Tuple[bool, bool]:
    up = (row.get("ema50", np.nan) >= row.get("ema100", np.nan)) and (row.get("fft_trend_slope", -1e9) >= 0)
    down = (row.get("ema50", np.nan) <= row.get("ema100", np.nan)) and (row.get("fft_trend_slope", 1e9) <= 0)
    if row.get("rsi14", 50) >= 70:
        up = False
    if row.get("rsi14", 50) <= 30:
        down = False
    return up, down

def generate_signals(pred: pd.Series, feat: pd.DataFrame, cfg: SignalConfig) -> pd.Series:
    sig = pd.Series(0.0, index=feat.index)
    for t, yhat in pred.items():
        if t not in feat.index or not np.isfinite(yhat):
            continue
        row = feat.loc[t]
        up, down = regime_filters(row)
        if (yhat > cfg.threshold_long) and up:
            sig.loc[t] = 1.0
        elif (yhat < -cfg.threshold_short) and down and cfg.allow_short:
            sig.loc[t] = -1.0
        else:
            sig.loc[t] = 0.0
    # Shift +1 day to trade at next open
    return sig.shift(1)

# -----------------------------
# Portfolio assembly
# -----------------------------
def realized_vol(logret: pd.Series, lookback: int) -> pd.Series:
    return logret.rolling(lookback).std().bfill()

def assemble_portfolio(signals: Dict[str, pd.Series],
                       prices_close: Dict[str, pd.Series],
                       cfg: PortfolioConfig) -> pd.DataFrame:
    dates = sorted(set().union(*[s.dropna().index for s in signals.values()]))
    weights = pd.DataFrame(0.0, index=dates, columns=signals.keys())

    vols = {tic: realized_vol(np.log(pc/pc.shift(1)), cfg.vol_lookback) for tic, pc in prices_close.items()}

    for t in dates:
        # candidates at date t with nonzero signal
        candidates = []
        for tic, sig in signals.items():
            s = sig.get(t, 0.0)
            if s == 0.0 or t not in vols[tic].index:
                continue
          # force scalar for the day's realized vol (avoid Series truth-value errors)
            v = float(vols[tic].reindex([t]).iloc[0])
            if not np.isfinite(v) or v <= 0.0:
                continue
            w_unit = cfg.target_daily_risk / max(v, 1e-12)
            candidates.append((tic, s, w_unit))

        if not candidates:
            continue

        candidates.sort(key=lambda x: abs(x[1]), reverse=True)
        chosen = candidates[:cfg.top_k]

        long_w = sum(w for _, s, w in chosen if s > 0)
        short_w = sum(w for _, s, w in chosen if s < 0)
        gross = long_w + abs(short_w)
        scale_gross = min(1.0, cfg.max_gross / (gross + 1e-12))

        net = long_w - abs(short_w)
        if net > cfg.max_net:
            scale_net = cfg.max_net / (net + 1e-12)
        elif net < -cfg.max_net:
            scale_net = (-cfg.max_net) / (abs(net) + 1e-12)
        else:
            scale_net = 1.0

        scale = min(scale_gross, scale_net)
        for tic, s, w in chosen:
            weights.loc[t, tic] = scale * (w if s > 0 else -w)

    return weights

# -----------------------------
# Model training + predictions
# -----------------------------
def train_predict_walkforward(feat: pd.DataFrame,
                              model_name: str = "hgb",
                              train_min: int = 756,
                              test_size: int = 63,
                              step_size: int = 63,
                              embargo: int = 0) -> Tuple[pd.Series, Dict[str, float]]:
    y = feat["target_next_logret"]
    X = feat.drop(columns=["target_next_logret"])

    # Keep columns that have at least some data
    valid_cols = [c for c in X.columns if X[c].notna().sum() > 0]
    X = X[valid_cols].replace([np.inf, -np.inf], np.nan)

    dates = X.index
    splits = walk_forward_splits(dates, train_min, test_size, step_size, embargo)

    models = get_models()
    if model_name not in models:
        model_name = "linear"
    proto = models[model_name]

    preds = pd.Series(np.nan, index=dates)

    mse_list, mae_list, r2_list = [], [], []

    for train_idx, test_idx in splits:
        X_train = X.iloc[train_idx].copy()
        y_train = y.iloc[train_idx].copy()
        X_test  = X.iloc[test_idx].copy()
        y_test  = y.iloc[test_idx].copy()

        # Impute with train medians
        med = X_train.median(numeric_only=True)
        X_train = X_train.fillna(med)
        X_test  = X_test.fillna(med)

        scaler = StandardScaler()
        X_train_s = pd.DataFrame(scaler.fit_transform(X_train), index=X_train.index, columns=X_train.columns)
        X_test_s  = pd.DataFrame(scaler.transform(X_test),  index=X_test.index,  columns=X_test.columns)

        model = copy.deepcopy(proto)
        model.fit(X_train_s, y_train)

        y_hat = pd.Series(model.predict(X_test_s), index=X_test.index)
        preds.loc[y_hat.index] = y_hat

        mse_list.append(mean_squared_error(y_test, y_hat))
        mae_list.append(mean_absolute_error(y_test, y_hat))
        try:
            r2_list.append(r2_score(y_test, y_hat))
        except Exception:
            r2_list.append(np.nan)

    metrics = {
        "CV_MSE": float(np.nanmean(mse_list)),
        "CV_MAE": float(np.nanmean(mae_list)),
        "CV_R2": float(np.nanmean(r2_list)),
        "Model": model_name,
        "Splits": int(len(splits))
    }
    return preds, metrics

# -----------------------------
# Backtester
# -----------------------------
def backtest_multi(tickers: List[str],
                   data: Dict[str, pd.DataFrame],
                   feats: Dict[str, pd.DataFrame],
                   preds: Dict[str, pd.Series],
                   sig_cfg: SignalConfig,
                   ex_cfg: ExecConfig,
                   port_cfg: PortfolioConfig,
                   exit_mode: str = "oneday"):
    """
    Returns:
      eq_df : equity + returns
      trades_df : trade ledger
      weights_df: daily weights per ticker
    """
    # Signals per ticker (shifted +1 within generate_signals)
    signals = {tic: generate_signals(preds[tic], feats[tic], sig_cfg) for tic in tickers}

    open_px  = {tic: data[tic]["Open"].astype(float) for tic in tickers}
    close_px = {tic: data[tic]["Adj Close"].astype(float) for tic in tickers}
    high_px  = {tic: data[tic]["High"].astype(float) for tic in tickers}
    low_px   = {tic: data[tic]["Low"].astype(float) for tic in tickers}
    atr14    = {tic: feats[tic]["atr14"] for tic in tickers}

    # Align on intersection of dates across all assets
    common = None
    for tic in tickers:
        idx = close_px[tic].dropna().index
        common = idx if common is None else common.intersection(idx)
    for tic in tickers:
        open_px[tic]  = open_px[tic].reindex(common).ffill()
        close_px[tic] = close_px[tic].reindex(common).ffill()
        high_px[tic]  = high_px[tic].reindex(common).ffill()
        low_px[tic]   = low_px[tic].reindex(common).ffill()
        signals[tic]  = signals[tic].reindex(common).fillna(0.0)
        atr14[tic]    = atr14[tic].reindex(common)

    # Portfolio weights computed daily from signals
    weights = assemble_portfolio(signals, close_px, port_cfg)
    weights = weights.reindex(common).fillna(0.0)

    dates = list(weights.index)
    if not dates:
        raise RuntimeError("No dates after alignment; check inputs.")

    equity = pd.Series(1.0, index=dates, dtype=float)
    rets   = pd.Series(0.0, index=dates, dtype=float)
    trades = []
    positions: Dict[str, Dict] = {}

    for i in range(1, len(dates)):
        t_prev = dates[i-1]
        t = dates[i]
        day_weights = weights.loc[t]

        # --- ENTRY at today's open ---
        for tic, w in day_weights.items():
            if w == 0.0:
                continue
            if tic in positions:
                continue
            entry_px = open_px[tic].loc[t]
            side = 1 if w > 0 else -1
            # Entry costs
            entry_cost = (ex_cfg.open_slippage_bps + ex_cfg.commission_bps) * 1e-4
            rets.loc[t] -= abs(w) * entry_cost
            positions[tic] = {
                "qty_w": abs(w),
                "side": side,
                "entry_price": entry_px,
                "entry_date": t
            }

        # --- EXIT / P&L realization ---
        # oneday: exit same day close
        if exit_mode == "oneday":
            for tic in list(positions.keys()):
                pos = positions[tic]
                exit_px = close_px[tic].loc[t]
                gross_ret = (exit_px - pos["entry_price"]) / pos["entry_price"]
                if pos["side"] < 0:
                    gross_ret = -gross_ret
                # Pay close leg costs
                exit_cost = (ex_cfg.close_slippage_bps + ex_cfg.commission_bps) * 1e-4
                pnl_w = pos["qty_w"] * (gross_ret - exit_cost)
                rets.loc[t] += pnl_w
                trades.append({
                    "date": t.strftime("%Y-%m-%d"),
                    "ticker": tic,
                    "side": "LONG" if pos["side"] > 0 else "SHORT",
                    "entry_date": pos["entry_date"].strftime("%Y-%m-%d"),
                    "entry_price": float(pos["entry_price"]),
                    "exit_price": float(exit_px),
                    "qty_weight": float(pos["qty_w"]),
                    "pnl_weight": float(pnl_w)
                })
                del positions[tic]

        elif exit_mode == "swing":
            for tic in list(positions.keys()):
                pos = positions[tic]
                side = pos["side"]
                entry_px = pos["entry_price"]
                atrv = atr14[tic].loc[t]
                # bounds
                if np.isfinite(atrv):
                    stop = entry_px - sig_cfg.atr_stop_mult * atrv if side > 0 else entry_px + sig_cfg.atr_stop_mult * atrv
                    tp   = entry_px + sig_cfg.atr_tp_mult * atrv if side > 0 else entry_px - sig_cfg.atr_tp_mult * atrv
                else:
                    stop, tp = (-np.inf, np.inf) if side > 0 else (np.inf, -np.inf)

                low_t = low_px[tic].loc[t]
                high_t = high_px[tic].loc[t]
                exit_now = False
                exit_px = close_px[tic].loc[t]

                if side > 0:
                    if low_t <= stop:
                        exit_now, exit_px = True, stop
                    elif high_t >= tp:
                        exit_now, exit_px = True, tp
                else:
                    if high_t >= stop:
                        exit_now, exit_px = True, stop
                    elif low_t <= tp:
                        exit_now, exit_px = True, tp

                # time stop
                hold_days = (t - pos["entry_date"]).days
                if not exit_now and hold_days >= sig_cfg.max_hold_days:
                    exit_now = True
                    exit_px = close_px[tic].loc[t]

                if exit_now:
                    gross_ret = (exit_px - entry_px) / entry_px
                    if side < 0:
                        gross_ret = -gross_ret
                    exit_cost = (ex_cfg.close_slippage_bps + ex_cfg.commission_bps) * 1e-4
                    pnl_w = pos["qty_w"] * (gross_ret - exit_cost)
                    rets.loc[t] += pnl_w
                    trades.append({
                        "date": t.strftime("%Y-%m-%d"),
                        "ticker": tic,
                        "side": "LONG" if pos["side"] > 0 else "SHORT",
                        "entry_date": pos["entry_date"].strftime("%Y-%m-%d"),
                        "entry_price": float(pos["entry_price"]),
                        "exit_price": float(exit_px),
                        "qty_weight": float(pos["qty_w"]),
                        "pnl_weight": float(pnl_w)
                    })
                    del positions[tic]

        # --- Update equity ---
        equity.loc[t] = equity.loc[t_prev] * (1.0 + rets.loc[t])

    eq_df = pd.DataFrame({"equity": equity, "returns": rets})
    trades_df = pd.DataFrame(trades)
    return eq_df, trades_df, weights

# -----------------------------
# Performance metrics
# -----------------------------
def perf_metrics(equity_df: pd.DataFrame, freq: int = 252) -> Dict[str, float]:
    r = equity_df["returns"].fillna(0.0).replace([np.inf, -np.inf], 0.0)
    eq = equity_df["equity"].replace([np.inf, -np.inf], np.nan).ffill().fillna(1.0)
    if len(eq) <= 1:
        return {"CAGR": 0.0, "AnnVol": 0.0, "Sharpe": 0.0, "Sortino": 0.0, "MaxDD": 0.0, "Calmar": 0.0, "HitRate": 0.0, "TotalReturn": 0.0}

    ann_ret = (eq.iloc[-1] / eq.iloc[0]) ** (freq / max(len(eq),1)) - 1.0
    ann_vol = r.std() * math.sqrt(freq)
    sharpe = ann_ret / (ann_vol + 1e-12)

    downside = r[r < 0].std() * math.sqrt(freq)
    sortino = ann_ret / (downside + 1e-12)

    roll_max = eq.cummax()
    drawdown = eq / roll_max - 1.0
    max_dd = float(drawdown.min())
    calmar = ann_ret / (abs(max_dd) + 1e-12)

    hit_rate = float((r > 0).mean())
    total_return = float(eq.iloc[-1] - 1.0)

    return {
        "CAGR": float(ann_ret),
        "AnnVol": float(ann_vol),
        "Sharpe": float(sharpe),
        "Sortino": float(sortino),
        "MaxDD": max_dd,
        "Calmar": float(calmar),
        "HitRate": hit_rate,
        "TotalReturn": total_return
    }

# -----------------------------
# Plot
# -----------------------------
def save_equity_plot(equity_df: pd.DataFrame, out_png: str):
    import matplotlib.pyplot as plt
    plt.figure(figsize=(10, 5))
    plt.plot(equity_df.index, equity_df["equity"])
    plt.title("Equity Curve")
    plt.xlabel("Date")
    plt.ylabel("NAV")
    plt.tight_layout()
    plt.savefig(out_png)
    plt.close()

# -----------------------------
# Data
# -----------------------------
def load_data(ticker: str, start: str, end: str) -> pd.DataFrame:
    if yf is None:
        raise RuntimeError("yfinance not installed. Please 'pip install yfinance'.")
    df = yf.download(ticker, start=start, end=end, auto_adjust=False, progress=False)
    if df is None or df.empty:
        raise RuntimeError(f"No data for {ticker}")
    return df

# -----------------------------
# Main
# -----------------------------
def main():
    parser = argparse.ArgumentParser(description="ARIMA + Rolling FFT + TA Ensemble Strategy (Walk-Forward Backtest)")
    parser.add_argument("--tickers", nargs="+", required=True, help="Tickers (e.g., SPY AAPL MSFT)")
    parser.add_argument("--start", type=str, required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", type=str, required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--model", type=str, default="hgb", choices=["linear", "mlp", "hgb"], help="Prediction model")
    parser.add_argument("--train_min", type=int, default=756, help="Min train bars per split (~3y)")
    parser.add_argument("--test_size", type=int, default=63, help="Test size per split (~3m)")
    parser.add_argument("--step_size", type=int, default=63, help="Step per split (~3m)")
    parser.add_argument("--embargo", type=int, default=0, help="Embargo bars between train/test")
    parser.add_argument("--fft_window", type=int, default=256, help="Rolling FFT window")
    parser.add_argument("--fft_topk", type=int, default=5, help="Top-K low-freq components")
    parser.add_argument("--exit_mode", type=str, default="oneday", choices=["oneday", "swing"], help="Exit style")
    parser.add_argument("--threshold", type=float, default=0.001, help="Abs prediction threshold (log-return)")
    parser.add_argument("--allow_short", action="store_true", help="Allow short selling")
    parser.add_argument("--top_k", type=int, default=5, help="Max concurrent assets")
    parser.add_argument("--target_risk", type=float, default=0.02, help="Target daily risk per asset (vol-scaling)")
    parser.add_argument("--max_gross", type=float, default=0.6, help="Max portfolio gross exposure")
    parser.add_argument("--max_net", type=float, default=0.4, help="Max portfolio net exposure")
    parser.add_argument("--open_slip", type=float, default=5.0, help="Open slippage bps")
    parser.add_argument("--close_slip", type=float, default=5.0, help="Close slippage bps")
    parser.add_argument("--comm_bps", type=float, default=1.0, help="Commission per leg bps")
    parser.add_argument("--out_prefix", type=str, default="results", help="Output file prefix")
    args = parser.parse_args()

    # Configs
    sig_cfg = SignalConfig(
        mode=args.exit_mode,
        threshold_long=args.threshold,
        threshold_short=args.threshold,
        allow_short=args.allow_short
    )
    ex_cfg = ExecConfig(
        open_slippage_bps=args.open_slip,
        close_slippage_bps=args.close_slip,
        commission_bps=args.comm_bps
    )
    port_cfg = PortfolioConfig(
        top_k=args.top_k,
        vol_lookback=20,
        target_daily_risk=args.target_risk,
        max_gross=args.max_gross,
        max_net=args.max_net
    )

    # Load data, build features, train/predict per ticker
    data: Dict[str, pd.DataFrame] = {}
    feats: Dict[str, pd.DataFrame] = {}
    preds: Dict[str, pd.Series] = {}
    cv_summaries: Dict[str, Dict] = {}

    for tic in args.tickers:
        print(f"[+] Loading {tic}")
        df = load_data(tic, args.start, args.end)
        data[tic] = df

        print(f"[+] Building features for {tic}")
        f = build_features(df, fft_window=args.fft_window, fft_topk=args.fft_topk)
        # Drop rows with missing target
        f = f.dropna(subset=["target_next_logret"]).copy()
        feats[tic] = f

        print(f"[+] Walk-forward training for {tic} ({args.model})")
        p, m = train_predict_walkforward(f,
                                         model_name=args.model,
                                         train_min=args.train_min,
                                         test_size=args.test_size,
                                         step_size=args.step_size,
                                         embargo=args.embargo)
        preds[tic] = p
        cv_summaries[tic] = m

    # Backtest
    print("[+] Running backtest...")
    eq_df, trades_df, weights_df = backtest_multi(
        tickers=args.tickers,
        data=data,
        feats=feats,
        preds=preds,
        sig_cfg=sig_cfg,
        ex_cfg=ex_cfg,
        port_cfg=port_cfg,
        exit_mode=args.exit_mode
    )

    # Save outputs
    prefix = args.out_prefix
    eq_path = f"{prefix}_equity.csv"
    tr_path = f"{prefix}_trades.csv"
    wt_path = f"{prefix}_weights.csv"
    met_path = f"{prefix}_metrics.json"
    plot_path = f"{prefix}_equity.png"

    eq_df.to_csv(eq_path, index=True)
    trades_df.to_csv(tr_path, index=False)
    weights_df.to_csv(wt_path, index=True)

    # Perf metrics
    metrics = perf_metrics(eq_df)
    with open(met_path, "w") as f:
        json.dump(metrics, f, indent=2)

    # CV summaries
    for tic, summ in cv_summaries.items():
        with open(f"{prefix}_cv_{tic}.json", "w") as f:
            json.dump(summ, f, indent=2)

    save_equity_plot(eq_df, plot_path)

    print("[+] Done.")
    print(f"Saved: {eq_path}, {tr_path}, {wt_path}, {met_path}, {plot_path}")

if __name__ == "__main__":
    main()
