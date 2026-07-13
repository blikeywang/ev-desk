#!/usr/bin/env python3
"""Normalize local teacher/market files for leakage-safe coach calibration.

Raw files stay outside Git. Only temporary canonical bars and de-identified
quality/teacher summaries are produced for the publishable calibration step.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SKILL = Path.home() / ".codex/skills/paul-wei-style-trading"
KLINE_COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "count", "taker_buy_volume",
    "taker_buy_quote_volume", "ignore",
]
TF_RULES = {"15m": "15min", "1h": "1h", "4h": "4h"}
REQUIRED_FILES = {
    "paul": "BTC-Trading-Since-2020-main.zip",
    "nq": "Dataset_NQ_1min_2022_2025.csv",
    "es": "mes11-23.csv",
    "btc_futures_early": "EventEdge_futures_BTC_2021_2023.zip",
    "btc_futures_late": "EventEdge_futures_BTC_2024_2026H1.zip",
    "eth_futures_early": "EventEdge_futures_ETH_2021_2023.zip",
    "eth_futures_late": "EventEdge_futures_ETH_2024_2026H1.zip",
    "btc_index": "EventEdge_index_BTC_2021_2026H1.zip",
    "eth_index": "EventEdge_index_ETH_2021_2026H1.zip",
    "btc_metrics": "EventEdge_metrics_BTC_2021_2026H1.zip",
    "eth_metrics": "EventEdge_metrics_ETH_2021_2026H1.zip",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def iso(value):
    if value is None or pd.isna(value):
        return None
    return pd.Timestamp(value).isoformat()


def number(value, digits=8):
    value = float(value)
    return round(value, digits) if np.isfinite(value) else None


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def locate_files(data_root):
    found = {}
    for key, filename in REQUIRED_FILES.items():
        matches = sorted(data_root.rglob(filename), key=lambda path: (len(path.parts), str(path)))
        if not matches:
            raise FileNotFoundError(f"Missing {filename} under {data_root}")
        found[key] = matches[0]
    return found


def fingerprint(path, data_root, source_id, role):
    try:
        label = str(path.relative_to(data_root))
    except ValueError:
        label = path.name
    return {
        "id": source_id,
        "file": label,
        "role": role,
        "size_bytes": path.stat().st_size,
        "sha256": sha256(path),
    }


def invalid_ohlc_mask(frame):
    return (
        (frame["high"] < frame[["open", "close"]].max(axis=1))
        | (frame["low"] > frame[["open", "close"]].min(axis=1))
        | (frame["high"] < frame["low"])
        | (frame[["open", "high", "low", "close"]] <= 0).any(axis=1)
    )


def resample_ohlcv(frame, rule, origin="epoch"):
    result = frame.resample(rule, label="left", closed="left", origin=origin).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
        source_rows=("close", "count"),
    )
    return result.dropna(subset=["open", "high", "low", "close"])


def normalize_binance_kline(handle):
    raw = pd.read_csv(handle, header=None, names=KLINE_COLUMNS, low_memory=False)
    raw_rows = len(raw)
    open_time = pd.to_numeric(raw["open_time"], errors="coerce")
    header_rows = int(open_time.isna().sum())
    raw = raw.loc[open_time.notna()].copy()
    raw["open_time"] = open_time.loc[open_time.notna()].astype("int64")
    for column in ("open", "high", "low", "close", "volume"):
        raw[column] = pd.to_numeric(raw[column], errors="coerce")
    null_rows = int(raw[["open", "high", "low", "close", "volume"]].isna().any(axis=1).sum())
    raw = raw.dropna(subset=["open", "high", "low", "close", "volume"]).sort_values("open_time")
    duplicate_times = int(raw.duplicated("open_time", keep="last").sum())
    raw = raw.drop_duplicates("open_time", keep="last")
    invalid_rows = int(invalid_ohlc_mask(raw).sum())
    raw = raw.loc[~invalid_ohlc_mask(raw)]
    index = pd.to_datetime(raw["open_time"], unit="ms", utc=True)
    frame = raw.set_index(index)[["open", "high", "low", "close", "volume"]]
    return frame, {
        "rows_raw": raw_rows,
        "header_rows": header_rows,
        "numeric_null_rows": null_rows,
        "duplicate_timestamps": duplicate_times,
        "invalid_ohlc_rows": invalid_rows,
    }


def merge_parts(parts):
    frame = pd.concat(parts).sort_index()
    return frame.loc[~frame.index.duplicated(keep="last")]


def load_nested_klines(paths, label, timeframes):
    parts = {timeframe: [] for timeframe in timeframes}
    counters = {
        "rows_raw": 0,
        "rows_clean": 0,
        "header_rows": 0,
        "numeric_null_rows": 0,
        "duplicate_timestamps": 0,
        "invalid_ohlc_rows": 0,
        "gap_events_over_1m": 0,
        "missing_minutes": 0,
        "inner_archives": 0,
    }
    first_time = last_time = None
    previous_ms = None
    for path in paths:
        with zipfile.ZipFile(path) as outer:
            members = sorted(name for name in outer.namelist() if name.endswith(".zip"))
            for member in members:
                with zipfile.ZipFile(io.BytesIO(outer.read(member))) as inner:
                    csv_names = [name for name in inner.namelist() if name.lower().endswith(".csv")]
                    if len(csv_names) != 1:
                        raise ValueError(f"Expected one CSV in {member}; found {csv_names}")
                    frame, stats = normalize_binance_kline(inner.open(csv_names[0]))
                counters["inner_archives"] += 1
                for key in ("rows_raw", "header_rows", "numeric_null_rows", "duplicate_timestamps", "invalid_ohlc_rows"):
                    counters[key] += stats[key]
                counters["rows_clean"] += len(frame)
                milliseconds = frame.index.as_unit("ms").asi8
                if len(milliseconds):
                    diffs = np.diff(milliseconds)
                    counters["gap_events_over_1m"] += int((diffs > 60_000).sum())
                    counters["missing_minutes"] += int(np.maximum(diffs // 60_000 - 1, 0).sum())
                    if previous_ms is not None and milliseconds[0] - previous_ms > 60_000:
                        boundary = int(milliseconds[0] - previous_ms)
                        counters["gap_events_over_1m"] += 1
                        counters["missing_minutes"] += max(0, boundary // 60_000 - 1)
                    previous_ms = int(milliseconds[-1])
                    first_time = frame.index[0] if first_time is None else min(first_time, frame.index[0])
                    last_time = frame.index[-1] if last_time is None else max(last_time, frame.index[-1])
                for timeframe in timeframes:
                    parts[timeframe].append(resample_ohlcv(frame, TF_RULES[timeframe]))
    return (
        {timeframe: merge_parts(items) for timeframe, items in parts.items()},
        {
            "label": label,
            **counters,
            "from": iso(first_time),
            "through": iso(last_time),
            "grain": "1m",
        },
    )


def load_metrics(path, label):
    hourly_parts = []
    rows_raw = rows_unique = exact_duplicates = time_duplicates = invalid_times = 0
    with zipfile.ZipFile(path) as outer:
        members = sorted(name for name in outer.namelist() if name.endswith(".zip"))
        for member in members:
            with zipfile.ZipFile(io.BytesIO(outer.read(member))) as inner:
                csv_names = [name for name in inner.namelist() if name.lower().endswith(".csv")]
                if len(csv_names) != 1:
                    raise ValueError(f"Expected one metrics CSV in {member}")
                frame = pd.read_csv(inner.open(csv_names[0]), low_memory=False)
            rows_raw += len(frame)
            exact_duplicates += int(frame.duplicated().sum())
            frame = frame.drop_duplicates()
            stamp = pd.to_datetime(frame["create_time"], errors="coerce", utc=True)
            invalid_times += int(stamp.isna().sum())
            frame = frame.loc[stamp.notna()].copy()
            frame.index = stamp.loc[stamp.notna()]
            time_duplicates += int(frame.index.duplicated(keep="last").sum())
            frame = frame.loc[~frame.index.duplicated(keep="last")]
            rows_unique += len(frame)
            numeric = [column for column in frame.columns if column not in {"create_time", "symbol"}]
            for column in numeric:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
            hourly_parts.append(frame[numeric].resample("1h", label="left", closed="left").last().dropna(how="all"))
    hourly = merge_parts(hourly_parts)
    diffs = np.diff(hourly.index.as_unit("ms").asi8)
    return hourly, {
        "label": label,
        "rows_raw": int(rows_raw),
        "rows_unique_5m": int(rows_unique),
        "exact_duplicate_rows": int(exact_duplicates),
        "duplicate_timestamps_after_exact_dedup": int(time_duplicates),
        "invalid_timestamp_rows": int(invalid_times),
        "hourly_rows": int(len(hourly)),
        "gap_events_over_1h": int((diffs > 3_600_000).sum()),
        "from": iso(hourly.index.min()),
        "through": iso(hourly.index.max()),
        "grain": "5m source, 1h canonical context",
        "inner_archives": len(members),
    }


def load_nq(path, timeframes):
    raw = pd.read_csv(path, low_memory=False)
    source_rows = len(raw)
    stamp = pd.to_datetime(raw["timestamp ET"], errors="coerce")
    bad_times = int(stamp.isna().sum())
    raw = raw.loc[stamp.notna()].copy()
    stamp = stamp.loc[stamp.notna()].dt.tz_localize(
        "America/New_York", ambiguous=False, nonexistent="shift_forward"
    )
    for column in ("open", "high", "low", "close", "volume"):
        raw[column] = pd.to_numeric(raw[column], errors="coerce")
    null_rows = int(raw[["open", "high", "low", "close", "volume"]].isna().any(axis=1).sum())
    raw = raw.dropna(subset=["open", "high", "low", "close", "volume"])
    raw.index = stamp.loc[raw.index]
    exact_duplicates = int(raw.duplicated().sum())
    duplicate_times = int(raw.index.duplicated(keep="last").sum())
    invalid_rows = int(invalid_ohlc_mask(raw).sum())
    frame = raw.loc[~invalid_ohlc_mask(raw), ["open", "high", "low", "close", "volume"]]
    frame = frame.loc[~frame.index.duplicated(keep="last")].sort_index()
    aggregates = {
        timeframe: resample_ohlcv(frame, TF_RULES[timeframe], origin="start_day")
        for timeframe in timeframes
    }
    diffs = np.diff(frame.index.tz_convert("UTC").as_unit("ms").asi8)
    return aggregates, {
        "label": "NQ continuous 1m",
        "rows_raw": source_rows,
        "rows_clean": int(len(frame)),
        "bad_timestamp_rows": bad_times,
        "numeric_null_rows": null_rows,
        "exact_duplicate_rows": exact_duplicates,
        "duplicate_timestamps": duplicate_times,
        "invalid_ohlc_rows": invalid_rows,
        "gap_events_over_1m_including_scheduled_closures": int((diffs > 60_000).sum()),
        "from": iso(frame.index.min()),
        "through": iso(frame.index.max()),
        "grain": "1m, source timestamps labeled ET",
        "timezone_rule": "America/New_York; ambiguous fall-back minute treated as standard time",
        "excel_data_row_limit_hit": source_rows == 1_048_575,
    }


def load_es(path, timeframes):
    raw = pd.read_csv(path, low_memory=False)
    source_rows = len(raw)
    stamp = pd.to_datetime(raw["ts_event"], errors="coerce", utc=True)
    bad_times = int(stamp.isna().sum())
    raw = raw.loc[stamp.notna()].copy()
    raw["timestamp"] = stamp.loc[stamp.notna()]
    for column in ("open", "high", "low", "close", "volume"):
        raw[column] = pd.to_numeric(raw[column], errors="coerce")
    null_rows = int(raw[["open", "high", "low", "close", "volume"]].isna().any(axis=1).sum())
    raw = raw.dropna(subset=["open", "high", "low", "close", "volume"])
    exact_duplicates = int(raw.duplicated().sum())
    outright = raw.loc[raw["symbol"].astype(str).str.match(r"^ES[HMUZ][0-9]$")].copy()
    outright["session_day"] = outright["timestamp"].dt.tz_convert("America/Chicago").dt.date
    daily_volume = outright.groupby(["session_day", "symbol"], as_index=False)["volume"].sum()
    dominant = daily_volume.loc[
        daily_volume.groupby("session_day")["volume"].idxmax(), ["session_day", "symbol"]
    ]
    selected = outright.merge(dominant, on=["session_day", "symbol"], how="inner")
    selected = selected.sort_values("timestamp").drop_duplicates("timestamp", keep="last")
    invalid_rows = int(invalid_ohlc_mask(selected).sum())
    selected = selected.loc[~invalid_ohlc_mask(selected)].copy()
    selected["segment"] = selected["symbol"].ne(selected["symbol"].shift()).cumsum()
    adjusted_parts = []
    rolls = []
    previous_close = None
    previous_symbol = None
    for _, segment in selected.groupby("segment", sort=True):
        segment = segment.copy()
        first_open = float(segment["open"].iloc[0])
        offset = 0.0 if previous_close is None else previous_close - first_open
        if previous_symbol is not None:
            rolls.append({
                "at": iso(segment["timestamp"].iloc[0]),
                "from": previous_symbol,
                "to": str(segment["symbol"].iloc[0]),
                "raw_gap_points": number(first_open - previous_close),
                "forward_adjustment_points": number(offset),
            })
        for column in ("open", "high", "low", "close"):
            segment[column] += offset
        previous_close = float(segment["close"].iloc[-1])
        previous_symbol = str(segment["symbol"].iloc[-1])
        adjusted_parts.append(segment)
    continuous = pd.concat(adjusted_parts).sort_values("timestamp")
    continuous.index = pd.DatetimeIndex(continuous["timestamp"])
    frame = continuous[["open", "high", "low", "close", "volume"]]
    aggregates = {timeframe: resample_ohlcv(frame, TF_RULES[timeframe]) for timeframe in timeframes}
    diffs = np.diff(frame.index.as_unit("ms").asi8)
    return aggregates, {
        "label": "ES daily-volume front contract",
        "rows_raw": source_rows,
        "rows_outright_es": int(len(outright)),
        "rows_continuous": int(len(frame)),
        "rows_excluded_mes_spreads_back_months": int(source_rows - len(frame)),
        "bad_timestamp_rows": bad_times,
        "numeric_null_rows": null_rows,
        "exact_duplicate_rows": exact_duplicates,
        "invalid_ohlc_rows": invalid_rows,
        "gap_events_over_1m_including_scheduled_closures": int((diffs > 60_000).sum()),
        "from": iso(frame.index.min()),
        "through": iso(frame.index.max()),
        "grain": "1m ES outright; daily volume leader; forward additive roll adjustment",
        "rolls": rolls,
    }


def split_boundaries(index):
    utc_index = index.tz_convert("UTC") if index.tz is not None else index.tz_localize("UTC")
    validation = pd.Timestamp("2024-01-01", tz="UTC")
    holdout = pd.Timestamp("2025-01-01", tz="UTC")
    if utc_index.min() < validation and utc_index.max() >= holdout:
        method = "calendar: development through 2023, validation 2024, holdout 2025+"
    else:
        validation = utc_index[int((len(utc_index) - 1) * 0.60)]
        holdout = utc_index[int((len(utc_index) - 1) * 0.80)]
        method = "chronological 60/20/20 because the supplied span is too short for full calendar splits"
    return {
        "validation_start": int(validation.timestamp()),
        "holdout_start": int(holdout.timestamp()),
        "method": method,
        "attribution": "split by signal timestamp; indicators may use earlier bars only",
    }


def write_scope(work_dir, symbol, timeframe, frame, split):
    frame = frame.sort_index().loc[~frame.index.duplicated(keep="last")]
    timestamps = frame.index.tz_convert("UTC") if frame.index.tz is not None else frame.index.tz_localize("UTC")
    seconds = timestamps.as_unit("s").asi8
    values = frame[["open", "high", "low", "close", "volume"]].to_numpy(dtype=float)
    bars = [[int(stamp), *[number(value, 10) for value in row]] for stamp, row in zip(seconds, values, strict=True)]
    filename = f"{symbol}-{timeframe}.json.gz"
    payload = {
        "schema": "ev_desk_canonical_ohlcv_v1",
        "symbol": symbol,
        "timeframe": timeframe,
        "split": split,
        "bars": bars,
    }
    with gzip.open(work_dir / filename, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"), allow_nan=False)
    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "file": filename,
        "bars": len(bars),
        "from": iso(timestamps.min()),
        "through": iso(timestamps.max()),
        "split": split,
    }


def paul_teacher_audit(path, skill_dir):
    base = "BTC-Trading-Since-2020-main/"
    with zipfile.ZipFile(path) as archive:
        manifest = json.load(archive.open(base + "manifest.json"))
        executions = pd.read_csv(
            archive.open(base + "api-v1-execution-tradeHistory.csv"), low_memory=False
        )
        orders = pd.read_csv(archive.open(base + "api-v1-order.csv"), low_memory=False)
    trades = executions.loc[executions["execType"].eq("Trade")].copy()
    xbt = trades.loc[trades["symbol"].eq("XBTUSD")].copy()
    xbt_stamp = pd.to_datetime(xbt["timestamp"], errors="coerce", utc=True)
    bursts = pd.read_csv(skill_dir / "assets/xbtusd_position_logic_bursts.csv")
    bursts["start"] = pd.to_datetime(bursts["start"], errors="coerce", utc=True, format="mixed")
    bursts["event_hour"] = pd.to_datetime(
        bursts["event_hour"], errors="coerce", utc=True, format="mixed"
    )
    market = pd.read_csv(skill_dir / "assets/btc_usdt_binance_1h_features.csv", usecols=["event_hour"])
    market["event_hour"] = pd.to_datetime(
        market["event_hour"], errors="coerce", utc=True, format="mixed"
    )
    groups = {
        "open_long": "offensive_long",
        "add_long": "offensive_long",
        "reverse_short_to_long": "offensive_long",
        "open_short": "offensive_short",
        "add_short": "offensive_short",
        "reverse_long_to_short": "offensive_short",
        "reduce_long": "derisk_long",
        "close_long": "derisk_long",
        "reduce_short": "derisk_short",
        "close_short": "derisk_short",
    }
    bursts["action_group"] = bursts["action_type"].map(groups).fillna("other")
    latest_xbt = xbt_stamp.max()
    outcomes = {}
    for action, frame in bursts.groupby("action_type"):
        values = pd.to_numeric(frame["risk_direction_fwd_24h"], errors="coerce").dropna()
        outcomes[str(action)] = {
            "n": int(len(values)),
            "hit_rate_24h": number((values > 0).mean() * 100, 1) if len(values) else None,
            "mean_risk_direction_return_24h": number(values.mean(), 6) if len(values) else None,
            "median_risk_direction_return_24h": number(values.median(), 6) if len(values) else None,
        }
    calibration = None
    feed_path = ROOT / "data/paul-wei-live.json"
    if feed_path.exists():
        try:
            calibration = json.loads(feed_path.read_text(encoding="utf-8")).get("calibration")
        except (OSError, json.JSONDecodeError):
            pass
    quantiles = bursts["abs_btc"].quantile([0.25, 0.5, 0.75, 0.9, 0.99])
    return {
        "identity": "Paul Wei reconstructed public BitMEX ledger",
        "public_ledger": {
            "window": manifest.get("dataset_window"),
            "executions": int(len(executions)),
            "trade_executions": int(len(trades)),
            "xbtusd_trade_executions": int(len(xbt)),
            "orders": int(len(orders)),
            "duplicate_execution_rows": int(executions.duplicated().sum()),
            "duplicate_exec_ids": int(executions["execID"].duplicated().sum()),
            "duplicate_order_rows": int(orders.duplicated().sum()),
            "duplicate_order_ids": int(orders["orderID"].duplicated().sum()),
            "xbtusd_added_liquidity": int(xbt["lastLiquidityInd"].eq("AddedLiquidity").sum()),
            "xbtusd_removed_liquidity": int(xbt["lastLiquidityInd"].eq("RemovedLiquidity").sum()),
            "xbtusd_first": iso(xbt_stamp.min()),
            "xbtusd_through": iso(latest_xbt),
        },
        "behavior_labels": {
            "bursts": int(len(bursts)),
            "active_hours": int(bursts["event_hour"].nunique()),
            "from": iso(bursts["start"].min()),
            "through": iso(bursts["start"].max()),
            "verified_by_supplied_xbtusd_ledger": int((bursts["start"] <= latest_xbt).sum()),
            "after_supplied_xbtusd_ledger": int((bursts["start"] > latest_xbt).sum()),
            "action_counts": {
                str(key): int(value) for key, value in bursts["action_type"].value_counts().items()
            },
            "action_group_counts": {
                str(key): int(value) for key, value in bursts["action_group"].value_counts().items()
            },
            "size_btc_quantiles_historical_only": {
                str(key): number(value, 6) for key, value in quantiles.items()
            },
            "outcomes": outcomes,
            "outcome_boundary": "risk-direction market return, not executable PnL; reduce/close actions are derisking",
        },
        "market_teacher_frame": {
            "rows": int(len(market)),
            "from": iso(market["event_hour"].min()),
            "through": iso(market["event_hour"].max()),
            "grain": "1h",
        },
        "calibration": calibration,
        "privacy": "Only aggregate counts and de-identified behavior labels leave the local machine.",
    }


def alignment_summary(futures, index, metrics, symbol):
    joined = futures[["close"]].rename(columns={"close": "futures_close"}).join(
        index[["close"]].rename(columns={"close": "index_close"}), how="left"
    )
    metric_column = "sum_open_interest_value"
    if metric_column in metrics:
        joined = joined.join(metrics[[metric_column]], how="left")
    else:
        joined[metric_column] = np.nan
    basis = (joined["futures_close"] / joined["index_close"] - 1).dropna() * 10_000
    return {
        "symbol": symbol,
        "futures_hourly_rows": int(len(futures)),
        "index_match_rows": int(joined["index_close"].notna().sum()),
        "index_match_pct": number(joined["index_close"].notna().mean() * 100, 2),
        "metrics_match_rows": int(joined[metric_column].notna().sum()),
        "metrics_match_pct": number(joined[metric_column].notna().mean() * 100, 2),
        "futures_minus_index_basis_bps": {
            "p01": number(basis.quantile(0.01), 3),
            "median": number(basis.median(), 3),
            "p99": number(basis.quantile(0.99), 3),
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-root",
        default=os.environ.get("EV_DESK_TRAINING_DATA", str(ROOT / "enent contract")),
    )
    parser.add_argument(
        "--work-dir",
        default=os.environ.get("EV_DESK_TRAINING_WORKDIR", "/tmp/ev-desk-coach-training"),
    )
    parser.add_argument(
        "--skill-dir",
        default=os.environ.get("PAUL_WEI_SKILL_DIR", str(DEFAULT_SKILL)),
    )
    parser.add_argument("--timeframes", default="15m,1h,4h")
    args = parser.parse_args()

    data_root = Path(args.data_root).expanduser().resolve()
    work_dir = Path(args.work_dir).expanduser().resolve()
    skill_dir = Path(args.skill_dir).expanduser().resolve()
    timeframes = [value.strip() for value in args.timeframes.split(",") if value.strip()]
    unknown = [timeframe for timeframe in timeframes if timeframe not in TF_RULES]
    if unknown:
        raise ValueError(f"Unsupported timeframes: {unknown}")
    work_dir.mkdir(parents=True, exist_ok=True)
    files = locate_files(data_root)

    print("Profiling and normalizing BTC futures...")
    btc, btc_quality = load_nested_klines(
        [files["btc_futures_early"], files["btc_futures_late"]],
        "BTCUSDT USD-M futures",
        timeframes,
    )
    print("Profiling and normalizing ETH futures...")
    eth, eth_quality = load_nested_klines(
        [files["eth_futures_early"], files["eth_futures_late"]],
        "ETHUSDT USD-M futures",
        timeframes,
    )
    print("Profiling BTC/ETH index-price archives...")
    btc_index, btc_index_quality = load_nested_klines(
        [files["btc_index"]], "BTCUSDT index price", ["1h"]
    )
    eth_index, eth_index_quality = load_nested_klines(
        [files["eth_index"]], "ETHUSDT index price", ["1h"]
    )
    print("Profiling and de-duplicating BTC/ETH derivatives metrics...")
    btc_metrics, btc_metrics_quality = load_metrics(
        files["btc_metrics"], "BTCUSDT derivatives metrics"
    )
    eth_metrics, eth_metrics_quality = load_metrics(
        files["eth_metrics"], "ETHUSDT derivatives metrics"
    )
    print("Normalizing NQ and ES continuous futures...")
    nq, nq_quality = load_nq(files["nq"], timeframes)
    es, es_quality = load_es(files["es"], timeframes)
    print("Auditing Paul Wei teacher ledger and behavior labels...")
    paul = paul_teacher_audit(files["paul"], skill_dir)

    scopes = []
    for symbol, by_timeframe in {
        "BTCUSDT": btc,
        "ETHUSDT": eth,
        "NQ": nq,
        "ES": es,
    }.items():
        split = split_boundaries(by_timeframe[timeframes[0]].index)
        for timeframe in timeframes:
            scope = write_scope(
                work_dir, symbol, timeframe, by_timeframe[timeframe], split
            )
            scopes.append(scope)
            print(f"Prepared {symbol} {timeframe}: {scope['bars']:,} bars")

    roles = {
        "paul": "Paul Wei public execution/order teacher ledger",
        "nq": "NQ 1m cross-asset validation",
        "es": "ES/MES/spread source; ES outright continuous validation after filtering",
        "btc_futures_early": "BTCUSDT 1m futures OHLCV",
        "btc_futures_late": "BTCUSDT 1m futures OHLCV",
        "eth_futures_early": "ETHUSDT 1m futures OHLCV",
        "eth_futures_late": "ETHUSDT 1m futures OHLCV",
        "btc_index": "BTCUSDT 1m index-price basis context",
        "eth_index": "ETHUSDT 1m index-price basis context",
        "btc_metrics": "BTCUSDT 5m OI/positioning/taker context",
        "eth_metrics": "ETHUSDT 5m OI/positioning/taker context",
    }
    print("Hashing source files for lineage...")
    sources = [
        fingerprint(files[key], data_root, key, roles[key])
        for key in REQUIRED_FILES
    ]
    flags = []
    if nq_quality["excel_data_row_limit_hit"]:
        flags.append({
            "severity": "warning",
            "code": "nq_excel_row_limit",
            "message": "NQ has exactly 1,048,575 data rows plus one header; the export may be truncated at Excel's row limit.",
        })
    if btc_metrics_quality["exact_duplicate_rows"]:
        flags.append({
            "severity": "warning",
            "code": "btc_metrics_exact_duplicates",
            "message": (
                f"BTC metrics contained {btc_metrics_quality['exact_duplicate_rows']:,} "
                "exact duplicate rows; canonical context is de-duplicated by timestamp."
            ),
        })
    for code, quality in (
        ("btc_index_gaps", btc_index_quality),
        ("eth_index_gaps", eth_index_quality),
    ):
        if quality["missing_minutes"]:
            flags.append({
                "severity": "warning",
                "code": code,
                "message": (
                    f"{quality['label']} has {quality['missing_minutes']:,} missing "
                    "minutes; index context is never substituted for the complete futures series."
                ),
            })
    flags.append({
        "severity": "info",
        "code": "eth_metrics_coverage",
        "message": (
            "ETH derivatives metrics begin on 2021-12-01, so they are retained as "
            "partial context rather than fabricated for the earlier market window."
        ),
    })
    if paul["behavior_labels"]["after_supplied_xbtusd_ledger"]:
        flags.append({
            "severity": "warning",
            "code": "paul_skill_ahead_of_archive",
            "message": (
                f"{paul['behavior_labels']['after_supplied_xbtusd_ledger']:,} behavior "
                "bursts are newer than the supplied XBTUSD execution ledger and remain skill-only labels."
            ),
        })
    flags.append({
        "severity": "info",
        "code": "es_contract_selection",
        "message": "ES excludes MES and calendar spreads, selects the daily volume-leading outright, and removes roll gaps with a forward additive adjustment.",
    })
    manifest = {
        "schema": "ev_desk_coach_training_manifest_v1",
        "generated_at": utc_now(),
        "source_set": "user-supplied local archives; raw rows excluded from publishable artifacts",
        "timeframes": timeframes,
        "sources": sources,
        "quality": {
            "status": "usable_with_caveats",
            "flags": flags,
            "datasets": {
                "btc_futures": btc_quality,
                "eth_futures": eth_quality,
                "btc_index": btc_index_quality,
                "eth_index": eth_index_quality,
                "btc_metrics": btc_metrics_quality,
                "eth_metrics": eth_metrics_quality,
                "nq": nq_quality,
                "es": es_quality,
            },
            "derivatives_alignment": [
                alignment_summary(btc["1h"], btc_index["1h"], btc_metrics, "BTCUSDT"),
                alignment_summary(eth["1h"], eth_index["1h"], eth_metrics, "ETHUSDT"),
            ],
        },
        "paul_wei": paul,
        "scopes": scopes,
        "methodology": {
            "raw_privacy": "Raw executions, order IDs, trade IDs, and minute rows stay local and are ignored by Git.",
            "canonical_bar": "[open_time_utc_seconds, open, high, low, close, volume]",
            "market_split": "Chronological development/validation/holdout; never random shuffle.",
            "leakage_control": "Signals use the current closed bar and earlier bars only; split attribution uses signal timestamp.",
            "teacher_boundary": "Paul labels supervise behavior similarity. Market history calibrates fixed method lenses; it does not fabricate human expert judgment.",
        },
    }
    manifest_path = work_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {manifest_path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"prepare_coach_training failed: {exc}", file=sys.stderr)
        raise
