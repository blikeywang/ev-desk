#!/usr/bin/env python3
"""Build the EV Desk Paul Wei feed from the installed teacher skill and live 1H bars."""

import argparse
import importlib.util
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SKILL = Path.home() / ".codex/skills/paul-wei-style-trading"
SYMBOLS = {"BTCUSDT": "btc", "ETHUSDT": "crypto_major", "SOLUSDT": "crypto_major"}


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "ev-desk-paul-wei-feed/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def fetch_closed_1h(symbol, limit=500):
    query = urllib.parse.urlencode({"symbol": symbol, "interval": "1h", "limit": limit})
    errors = []
    for base in ("https://api.binance.com", "https://data-api.binance.vision"):
        try:
            rows = fetch_json(f"{base}/api/v3/klines?{query}")
            now_ms = datetime.now(timezone.utc).timestamp() * 1000
            closed = [r for r in rows if float(r[6]) < now_ms]
            if len(closed) >= 200:
                return closed, "Binance official Spot 1H"
        except Exception as exc:  # provider fallback is intentional
            errors.append(f"{base}: {exc}")
    raise RuntimeError(" | ".join(errors) or "No closed 1H candles")


def feature_row(rows):
    frame = pd.DataFrame(
        rows,
        columns=["open_time", "open", "high", "low", "close", "volume", "close_time", "quote", "trades", "taker_base", "taker_quote", "ignore"],
    )
    for column in ("open", "high", "low", "close", "volume"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    close = frame["close"]
    high = frame["high"]
    low = frame["low"]
    volume = frame["volume"]
    last = frame.iloc[-1]
    ma24 = close.iloc[-24:].mean()
    ma168 = close.iloc[-168:].mean()
    prior_close = close.shift(1)
    true_range = pd.concat(
        [(high - low), (high - prior_close).abs(), (low - prior_close).abs()], axis=1
    ).max(axis=1)
    atr24 = true_range.iloc[-24:].mean()
    dist24 = float(last.close / ma24 - 1)
    dist168 = float(last.close / ma168 - 1)
    if dist168 >= 0 and dist24 >= 0:
        state = "uptrend_above_ma24h"
    elif dist168 >= 0:
        state = "uptrend_pullback"
    elif dist24 <= 0:
        state = "downtrend_below_ma24h"
    else:
        state = "downtrend_rebound"
    vol72 = volume.iloc[-72:]
    vol_std = vol72.std(ddof=1)
    stamp = pd.to_datetime(int(last.open_time), unit="ms", utc=True)
    value = {
        "close": float(last.close),
        "timestamp": stamp,
        "event_hour": stamp,
        "range_pct": float((last.high - last.low) / last.close),
        "atr24h_pct": float(atr24 / last.close),
        "dist_ma24h": dist24,
        "dist_ma168h": dist168,
        "dist_24h_high": float(last.close / high.iloc[-24:].max() - 1),
        "dist_24h_low": float(last.close / low.iloc[-24:].min() - 1),
        "dist_72h_high": float(last.close / high.iloc[-72:].max() - 1),
        "dist_72h_low": float(last.close / low.iloc[-72:].min() - 1),
        "volume_z_72h": float((last.volume - vol72.mean()) / vol_std) if vol_std else 0.0,
        "hourly_state": state,
        "back_ret_6h": float(last.close / close.iloc[-7] - 1),
        "back_ret_12h": float(last.close / close.iloc[-13] - 1),
        "back_ret_24h": float(last.close / close.iloc[-25] - 1),
    }
    return value


def load_skill(skill_dir):
    script = skill_dir / "scripts/score.py"
    if not script.exists():
        raise FileNotFoundError(f"Paul Wei scorer not found: {script}")
    spec = importlib.util.spec_from_file_location("paul_wei_score", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def serializable(value):
    if isinstance(value, pd.DataFrame):
        return [serializable(x) for x in value.to_dict("records")]
    if isinstance(value, pd.Series):
        return {str(k): serializable(v) for k, v in value.to_dict().items()}
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(k): serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serializable(v) for v in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value


def score_live(module, market_path, row, profile):
    history = pd.read_csv(market_path)
    query = pd.DataFrame([row])
    combined = pd.concat([history, query], ignore_index=True)
    combined["event_hour"] = pd.to_datetime(combined["event_hour"], utc=True, format="mixed")
    combined = combined.sort_values("event_hour").drop_duplicates("event_hour", keep="last")
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as handle:
        temp_path = Path(handle.name)
        combined.to_csv(handle, index=False)
    previous = os.environ.get("PAUL_WEI_MARKET_1H_PATH")
    os.environ["PAUL_WEI_MARKET_1H_PATH"] = str(temp_path)
    try:
        result = module.score(timestamp=row["event_hour"], k=500, market_profile=profile)
    finally:
        if previous is None:
            os.environ.pop("PAUL_WEI_MARKET_1H_PATH", None)
        else:
            os.environ["PAUL_WEI_MARKET_1H_PATH"] = previous
        temp_path.unlink(missing_ok=True)
    return serializable(result)


def summarize_signed(values):
    clean = np.asarray([x for x in values if np.isfinite(x)], dtype=float)
    if not len(clean):
        return {"n": 0, "hit_rate": None, "mean_signed_return": None, "median_signed_return": None}
    return {
        "n": int(len(clean)),
        "hit_rate": round(float((clean > 0).mean() * 100), 1),
        "mean_signed_return": round(float(clean.mean()), 5),
        "median_signed_return": round(float(np.median(clean)), 5),
    }


def calibrate(module):
    frame = module.load_training_frame().reset_index(drop=True)
    cutoff = frame["event_hour"].max() - pd.Timedelta(days=365)
    train = frame[frame["event_hour"] < cutoff].copy()
    holdout = frame[frame["event_hour"] >= cutoff].copy()
    holdout["fwd_24h"] = holdout["close"].shift(-24) / holdout["close"] - 1
    holdout["fwd_72h"] = holdout["close"].shift(-72) / holdout["close"] - 1
    holdout["fwd_168h"] = holdout["close"].shift(-168) / holdout["close"] - 1
    queries = holdout.iloc[::24].dropna(subset=["fwd_168h"])
    train_x, stats, levels = module.make_matrix(train)
    active_sizes = train.loc[train["action_type"].ne("no_action"), "action_abs_btc"]
    material_threshold = float(active_sizes.quantile(0.75))
    large_threshold = float(active_sizes.quantile(0.90))
    observations = []
    for _, query in queries.iterrows():
        qx, _, _ = module.make_matrix(query.to_frame().T, stats, levels)
        distances = np.linalg.norm(train_x - qx[0], axis=1)
        nearest = np.argsort(distances)[:500]
        neighbors = train.iloc[nearest].copy()
        neighbors["distance"] = distances[nearest]
        scale = max(float(np.median(neighbors["distance"])), 1e-9)
        neighbors["weight"] = np.exp(-neighbors["distance"] / max(2.0 * scale, 1e-9))
        action_probs, _ = module.weighted_probabilities(neighbors)
        _, material_share = module.weighted_action_subset_probs(
            neighbors, neighbors["action_abs_btc"].ge(material_threshold)
        )
        _, large_share = module.weighted_action_subset_probs(
            neighbors, neighbors["action_abs_btc"].ge(large_threshold)
        )
        decision = module.coaching_decision(action_probs.to_dict(), material_share, large_share, "btc")
        direction = 1 if decision["stance"] == "long_bias" else -1 if decision["stance"] == "short_bias" else 0
        observations.append(
            {
                "time": query["event_hour"],
                "stance": decision["stance"],
                "direction": direction,
                "signed_24h": direction * query["fwd_24h"] if direction else np.nan,
                "signed_72h": direction * query["fwd_72h"] if direction else np.nan,
                "signed_168h": direction * query["fwd_168h"] if direction else np.nan,
            }
        )
    active = [x for x in observations if x["direction"]]
    midpoint = len(active) // 2
    counts = pd.Series([x["stance"] for x in observations]).value_counts().to_dict()
    return {
        "schema": "paul_wei_behavior_calibration_v1",
        "label": "固定训练窗后的逐日样本外方向校准，不是交易策略PnL回测",
        "train_through": cutoff.isoformat(),
        "holdout_through": frame["event_hour"].max().isoformat(),
        "sample_frequency": "24h",
        "queries": len(observations),
        "stance_counts": {str(k): int(v) for k, v in counts.items()},
        "active": {
            "24h": summarize_signed([x["signed_24h"] for x in active]),
            "72h": summarize_signed([x["signed_72h"] for x in active]),
            "168h": summarize_signed([x["signed_168h"] for x in active]),
        },
        "stability": {
            "earlier_active_24h": summarize_signed([x["signed_24h"] for x in active[:midpoint]]),
            "later_active_24h": summarize_signed([x["signed_24h"] for x in active[midpoint:]]),
            "boundary": "前后半段差异表示稳定性/环境漂移，不表示模型自动成长",
        },
    }


def external_view(symbol, snapshot):
    coaching = snapshot["coaching"]
    evidence = snapshot["evidence"]
    groups = coaching["action_groups"]
    stance = coaching["stance"]
    direction = "long" if stance == "long_bias" else "short" if stance == "short_bias" else None
    confidence = {"低": 0.25, "中": 0.5, "中高": 0.68, "高": 0.8}.get(coaching["confidence"], 0.3)
    as_of = pd.Timestamp(evidence["query_hour"]).to_pydatetime()
    return {
        "schema": "ev_desk_expert_view_v1",
        "expert": {
            "id": "paul_wei",
            "name": "Paul Wei 重建",
            "school": "行为概率模型",
            "kind": "behavior_model",
            "version": "paul-wei-core-v2",
            "dataDependencies": "teacher dataset + live 1H OHLCV",
        },
        "symbol": symbol,
        "timeframe": "1h",
        "asOf": as_of.isoformat(),
        "validUntil": (as_of + pd.Timedelta(hours=2)).isoformat(),
        "direction": direction,
        "stance": stance,
        "confidence": confidence,
        "reason": (
            f"no_action {snapshot['action_probs'].get('no_action', 0):.1%}; "
            f"offensive_long {groups.get('offensive_long', 0):.1%}; "
            f"offensive_short {groups.get('offensive_short', 0):.1%}; "
            f"derisk_long {groups.get('derisk_long', 0):.1%}."
        ),
        "action": coaching["suggested_action"],
        "riskUnit": coaching["suggested_risk_unit"],
        "evidence": {
            "model_output": snapshot,
            "execution_boundary": "方向语言来自 Paul Wei 行为重建；若形成计划，具体价位由 EV Desk 独立关键位引擎生成。",
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill-dir", default=os.environ.get("PAUL_WEI_SKILL_DIR", str(DEFAULT_SKILL)))
    parser.add_argument("--output", default=str(ROOT / "data/paul-wei-live.json"))
    parser.add_argument("--js-output", default=str(ROOT / "data/paul-wei-live.js"))
    parser.add_argument("--views-output", default=str(ROOT / "data/expert-views/paul-wei.json"))
    parser.add_argument("--skip-calibration", action="store_true")
    args = parser.parse_args()

    skill_dir = Path(args.skill_dir).expanduser().resolve()
    module = load_skill(skill_dir)
    market_path = skill_dir / "assets/btc_usdt_binance_1h_features.csv"
    snapshots = {}
    sources = {}
    for symbol, profile in SYMBOLS.items():
        rows, source = fetch_closed_1h(symbol)
        row = feature_row(rows)
        snapshots[symbol] = score_live(module, market_path, row, profile)
        sources[symbol] = {"market": source, "as_of": row["event_hour"].isoformat()}
        print(f"Scored {symbol} @ {row['event_hour'].isoformat()}")
    if args.skip_calibration:
        calibration = None
        previous_output = Path(args.output)
        if previous_output.exists():
            try:
                calibration = json.loads(previous_output.read_text(encoding="utf-8")).get("calibration")
            except (OSError, json.JSONDecodeError):
                calibration = None
        print("Reused existing calibration" if calibration else "Skipped calibration")
    else:
        calibration = calibrate(module)
    feed = {
        "schema": "ev_desk_paul_wei_feed_v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model": {
            "id": "paul_wei",
            "name": "Paul Wei 重建",
            "version": "paul-wei-core-v2",
            "kind": "behavior_model",
            "boundary": "行为相似度评分，不是本人实时发言、价格预测或自动订单。",
        },
        "sources": sources,
        "snapshots": snapshots,
        "calibration": calibration,
    }
    views = {"schema": "ev_desk_expert_view_batch_v1", "views": [external_view(k, v) for k, v in snapshots.items()]}
    for target, value, javascript in (
        (Path(args.output), feed, False),
        (Path(args.js_output), feed, True),
        (Path(args.views_output), views, False),
    ):
        target.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(serializable(value), ensure_ascii=False, indent=None if javascript else 2)
        if javascript:
            text = f"window.EV_DESK_DATA=window.EV_DESK_DATA||{{}};window.EV_DESK_DATA.paulWei={text};\n"
        else:
            text += "\n"
        target.write_text(text, encoding="utf-8")
        print(f"Wrote {target}")


if __name__ == "__main__":
    main()
