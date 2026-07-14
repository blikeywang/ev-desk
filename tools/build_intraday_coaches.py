#!/usr/bin/env python3
"""Train session-aware NQ intraday coach candidates without publishing raw bars."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ROUND_TRIP_COST_POINTS = 1.25
MIN_RISK_POINTS = 4.0
MAX_RISK_OPENING_RANGES = 2.5


COACHES = {
    "opening_range": {
        "name": "开盘区间",
        "school": "Opening Range Breakout",
        "description": "只做美股正盘开盘区间被收盘价确认后的首次突破。",
        "reference": "Zarattini & Aziz, SSRN 4416622",
    },
    "vwap_pullback": {
        "name": "VWAP 首次回踩",
        "school": "VWAP Trend Pullback",
        "description": "先确认开盘推动，再等价格第一次回踩正盘 VWAP 并收回。",
        "reference": "Zarattini & Aziz, SSRN 4631351; EV Desk execution variant",
    },
    "opening_failure": {
        "name": "开盘失败反转",
        "school": "Opening Range Failure",
        "description": "只做开盘区间外扩张失败并重新收回区间后的反向计划。",
        "reference": "EV Desk falsification variant",
    },
}


def number(value, digits=4):
    value = float(value)
    return round(value, digits) if math.isfinite(value) else None


def find_nq_file(data_root: Path) -> Path:
    matches = sorted(data_root.rglob("Dataset_NQ_1min_2022_2025.csv"))
    if not matches:
        raise FileNotFoundError(f"Dataset_NQ_1min_2022_2025.csv not found under {data_root}")
    return matches[0]


def source_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_sessions(path: Path):
    columns = ["timestamp ET", "open", "high", "low", "close", "volume", "Vwap_RTH"]
    frame = pd.read_csv(path, usecols=columns, low_memory=False)
    stamp = pd.to_datetime(frame["timestamp ET"], errors="coerce")
    frame = frame.loc[stamp.notna()].copy()
    frame["timestamp"] = stamp.loc[stamp.notna()]
    for column in ("open", "high", "low", "close", "volume", "Vwap_RTH"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.dropna(subset=["open", "high", "low", "close", "volume"])
    minutes = frame["timestamp"].dt.hour * 60 + frame["timestamp"].dt.minute
    frame = frame.loc[(minutes >= 570) & (minutes < 960)].sort_values("timestamp")
    frame["session_day"] = frame["timestamp"].dt.date
    sessions = []
    for day, group in frame.groupby("session_day", sort=True):
        group = group.drop_duplicates("timestamp", keep="last")
        if len(group) < 200 or group["timestamp"].iloc[0].hour != 9:
            continue
        arrays = {column: group[column].to_numpy(dtype=float) for column in ("open", "high", "low", "close", "volume")}
        typical = (arrays["high"] + arrays["low"] + arrays["close"]) / 3
        cumulative_volume = np.cumsum(np.maximum(arrays["volume"], 0))
        computed_vwap = np.cumsum(typical * np.maximum(arrays["volume"], 0)) / np.maximum(cumulative_volume, 1)
        supplied = group["Vwap_RTH"].to_numpy(dtype=float)
        arrays["vwap"] = np.where(np.isfinite(supplied) & (supplied > 0), supplied, computed_vwap)
        sessions.append({
            "day": day.isoformat(),
            "year": day.year,
            "timestamps": group["timestamp"].to_numpy(),
            **arrays,
        })
    return sessions, int(len(frame))


def candidate_space(coach_id):
    if coach_id == "opening_range":
        keys = ("opening_minutes", "buffer_fraction", "max_entry_minute", "stop_fraction", "rr")
        values = ([5, 15, 30], [0.0, 0.08], [60, 120], [0.5, 0.75, 1.0], [1.5, 2.0, 2.5])
    elif coach_id == "vwap_pullback":
        keys = ("opening_minutes", "impulse_fraction", "touch_fraction", "max_entry_minute", "stop_fraction", "rr")
        values = ([5, 15], [0.0, 0.15], [0.05, 0.15], [90, 180], [0.2, 0.35], [1.5, 2.0, 2.5])
    else:
        keys = ("opening_minutes", "excursion_fraction", "max_entry_minute", "stop_pad_fraction", "rr")
        values = ([5, 15, 30], [0.05, 0.15], [60, 120], [0.05, 0.15], [1.2, 1.5, 2.0])
    return [dict(zip(keys, row, strict=True)) for row in itertools.product(*values)]


def first_signal(session, coach_id, config):
    opening = config["opening_minutes"]
    high, low = session["high"], session["low"]
    open_, close, vwap = session["open"], session["close"], session["vwap"]
    if len(close) <= opening + 2:
        return None
    opening_high = float(np.max(high[:opening]))
    opening_low = float(np.min(low[:opening]))
    width = opening_high - opening_low
    if not width > 0:
        return None
    end = min(len(close) - 2, int(config["max_entry_minute"]))

    if coach_id == "opening_range":
        buffer = width * config["buffer_fraction"]
        upper, lower = opening_high + buffer, opening_low - buffer
        for index in range(opening, end + 1):
            previous = close[index - 1]
            long_signal = close[index] > upper and previous <= upper and close[index] > vwap[index] and close[index] > open_[index]
            short_signal = close[index] < lower and previous >= lower and close[index] < vwap[index] and close[index] < open_[index]
            if long_signal == short_signal:
                continue
            direction = 1 if long_signal else -1
            stop = opening_high - width * config["stop_fraction"] if direction == 1 else opening_low + width * config["stop_fraction"]
            return index, direction, stop, opening_high, opening_low
        return None

    if coach_id == "vwap_pullback":
        impulse = width * config["impulse_fraction"]
        touch = width * config["touch_fraction"]
        for index in range(opening + 5, end + 1):
            start = max(opening, index - 90)
            long_impulse = np.max(close[start:index]) > opening_high + impulse
            short_impulse = np.min(close[start:index]) < opening_low - impulse
            slope_start = max(opening, index - 5)
            long_signal = long_impulse and low[index] <= vwap[index] + touch and close[index] > vwap[index] and close[index] > open_[index] and vwap[index] >= vwap[slope_start]
            short_signal = short_impulse and high[index] >= vwap[index] - touch and close[index] < vwap[index] and close[index] < open_[index] and vwap[index] <= vwap[slope_start]
            if long_signal == short_signal:
                continue
            direction = 1 if long_signal else -1
            if direction == 1:
                stop = min(low[index] - 0.25, vwap[index] - width * config["stop_fraction"])
            else:
                stop = max(high[index] + 0.25, vwap[index] + width * config["stop_fraction"])
            return index, direction, stop, opening_high, opening_low
        return None

    excursion = width * config["excursion_fraction"]
    pad = width * config["stop_pad_fraction"]
    for index in range(opening, end + 1):
        highest = float(np.max(high[opening:index + 1]))
        lowest = float(np.min(low[opening:index + 1]))
        failed_high = highest >= opening_high + excursion and close[index] < opening_high and close[index] < open_[index]
        failed_low = lowest <= opening_low - excursion and close[index] > opening_low and close[index] > open_[index]
        if failed_high == failed_low:
            continue
        direction = -1 if failed_high else 1
        stop = highest + pad if direction == -1 else lowest - pad
        return index, direction, stop, opening_high, opening_low
    return None


def simulate_trade(session, coach_id, config):
    signal = first_signal(session, coach_id, config)
    if signal is None:
        return None
    signal_index, direction, stop, opening_high, opening_low = signal
    entry_index = signal_index + 1
    entry = float(session["open"][entry_index])
    width = opening_high - opening_low
    risk = abs(entry - stop)
    if risk < MIN_RISK_POINTS or risk > width * MAX_RISK_OPENING_RANGES:
        return None
    target = entry + direction * risk * config["rr"]
    exit_price = float(session["close"][-1])
    exit_index = len(session["close"]) - 1
    reason = "rth_close"
    gross_r = direction * (exit_price - entry) / risk
    for index in range(entry_index, len(session["close"])):
        stop_hit = session["low"][index] <= stop if direction == 1 else session["high"][index] >= stop
        target_hit = session["high"][index] >= target if direction == 1 else session["low"][index] <= target
        if stop_hit:
            exit_price, exit_index, reason, gross_r = stop, index, "same_bar_stop_first" if target_hit else "stop", -1.0
            break
        if target_hit:
            exit_price, exit_index, reason, gross_r = target, index, "target", float(config["rr"])
            break
    cost_r = ROUND_TRIP_COST_POINTS / risk
    signal_time = pd.Timestamp(session["timestamps"][signal_index]).tz_localize("America/New_York", ambiguous=False).tz_convert("UTC")
    close_time = pd.Timestamp(session["timestamps"][exit_index]).tz_localize("America/New_York", ambiguous=False).tz_convert("UTC")
    return {
        "session": session["day"],
        "year": session["year"],
        "signal_bar_ts": int(signal_time.timestamp()),
        "closed_bar_ts": int(close_time.timestamp()),
        "direction": "long" if direction == 1 else "short",
        "entry": number(entry, 2),
        "stop": number(stop, 2),
        "target": number(target, 2),
        "risk_points": number(risk, 2),
        "gross_r": number(gross_r),
        "cost_r": number(cost_r),
        "net_r": number(gross_r - cost_r),
        "close_reason": reason,
    }


def run_candidate(sessions, coach_id, config):
    return [trade for session in sessions if (trade := simulate_trade(session, coach_id, config)) is not None]


def downsample(values, limit=90):
    if len(values) <= limit:
        return [number(value, 3) for value in values]
    indexes = np.linspace(0, len(values) - 1, limit).astype(int)
    return [number(values[index], 3) for index in indexes]


def summarize(trades, recent=False):
    values = np.array([trade["net_r"] for trade in trades], dtype=float)
    gross = np.array([trade["gross_r"] for trade in trades], dtype=float)
    costs = np.array([trade["cost_r"] for trade in trades], dtype=float)
    if not len(values):
        return {"n": 0, "win": 0, "ev": None, "ev_ci95": [None, None], "pf": 0, "mdd": 0, "total_r": 0, "curve": [], "recent_trades": [] if recent else None}
    curve = np.cumsum(values)
    peaks = np.maximum.accumulate(np.maximum(curve, 0))
    drawdown = curve - peaks
    ev = float(np.mean(values))
    standard_error = float(np.std(values, ddof=1) / math.sqrt(len(values))) if len(values) > 1 else 0
    gains = float(values[values > 0].sum())
    losses = abs(float(values[values <= 0].sum()))
    result = {
        "n": int(len(values)),
        "win": number((values > 0).mean() * 100, 1),
        "ev": number(ev, 3),
        "gross_ev": number(np.mean(gross), 3),
        "avg_cost_r": number(np.mean(costs), 3),
        "ev_ci95": [number(ev - 1.96 * standard_error, 3), number(ev + 1.96 * standard_error, 3)],
        "pf": number(gains / losses if losses else 9.99, 2),
        "mdd": number(float(drawdown.min()), 2),
        "total_r": number(float(curve[-1]), 2),
        "curve": downsample(curve),
        "first_trade": trades[0]["signal_bar_ts"],
        "last_trade": trades[-1]["closed_bar_ts"],
    }
    if recent:
        result["recent_trades"] = [{key: trade[key] for key in ("closed_bar_ts", "direction", "net_r", "close_reason")} for trade in trades[-20:]]
    return result


def development_score(summary):
    if summary["n"] < 60 or summary["ev"] is None:
        return -math.inf
    low, high = summary["ev_ci95"]
    standard_error = (high - low) / 3.92 if low is not None and high is not None else 1
    return summary["ev"] - 0.5 * standard_error - abs(summary["mdd"]) / max(1, summary["n"]) * 0.002


def pass_split(summary, minimum=50):
    return summary["n"] >= minimum and summary["ev"] is not None and summary["ev"] >= 0.02 and summary["total_r"] > 0 and summary["pf"] > 1


def train_coach(sessions, coach_id):
    development_sessions = [session for session in sessions if session["year"] <= 2023]
    candidates = []
    for config in candidate_space(coach_id):
        summary = summarize(run_candidate(development_sessions, coach_id, config))
        candidates.append((development_score(summary), config, summary))
    candidates.sort(key=lambda row: row[0], reverse=True)
    score, config, development = candidates[0]
    all_trades = run_candidate(sessions, coach_id, config)
    by_split = {
        "development": [trade for trade in all_trades if trade["year"] <= 2023],
        "validation": [trade for trade in all_trades if trade["year"] == 2024],
        "holdout": [trade for trade in all_trades if trade["year"] >= 2025],
    }
    reports = {key: summarize(value, recent=key == "holdout") for key, value in by_split.items()}
    validation_pass = pass_split(reports["validation"])
    holdout_pass = pass_split(reports["holdout"])
    status = "historically_supported" if validation_pass and holdout_pass else "forward_watch" if validation_pass else "research_only"
    return {
        "id": coach_id,
        **COACHES[coach_id],
        "status": status,
        "selected_on": "development_only",
        "candidate_count": len(candidates),
        "development_score": number(score, 4),
        "config": config,
        **reports,
        "assessment": {
            "validation_pass": validation_pass,
            "holdout_pass": holdout_pass,
            "deployment": "plan_seat" if status == "historically_supported" else "research_seat",
            "threshold": "n >= 50, EV >= +0.02R, total R > 0, PF > 1 in both validation and holdout",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--output", default=str(ROOT / "data/intraday-coaches.json"))
    parser.add_argument("--js-output", default=str(ROOT / "data/intraday-coaches.js"))
    args = parser.parse_args()
    source = find_nq_file(Path(args.data_root).expanduser().resolve())
    sessions, rth_rows = load_sessions(source)
    if len(sessions) < 500:
        raise RuntimeError(f"Only {len(sessions)} usable NQ sessions were found")
    coaches = {coach_id: train_coach(sessions, coach_id) for coach_id in COACHES}
    active = [coach_id for coach_id, coach in coaches.items() if coach["status"] == "historically_supported"]
    artifact = {
        "schema": "ev_desk_intraday_coaches_v1",
        "meta": {
            "generated_at": pd.Timestamp.now(tz="UTC").isoformat(),
            "source": "user-supplied NQ continuous 1-minute OHLCV",
            "source_sha256": source_hash(source),
            "raw_rows_published": False,
            "rth_rows": rth_rows,
            "sessions": len(sessions),
            "from": sessions[0]["day"],
            "through": sessions[-1]["day"],
            "timezone": "America/New_York",
            "regular_session": "09:30-16:00 ET",
            "splits": {"development": "through 2023", "validation": "2024", "holdout": "2025+"},
            "execution": {
                "decision": "signal on closed 1-minute bar; enter next bar open",
                "position_policy": "maximum one trade per coach per regular session",
                "same_bar_rule": "stop first",
                "time_exit": "last available regular-session bar",
                "round_trip_cost_points": ROUND_TRIP_COST_POINTS,
                "cost_note": "fixed NQ point allowance for spread, fees and slippage; not broker-specific",
            },
            "selection": "all parameters selected on development only; validation and holdout cannot change the selected variant",
            "research_boundary": "NQ evidence can support NQ/MNQ. US equities remain forward-only until consolidated stock minute archives are supplied.",
        },
        "active_coach_ids": active,
        "coaches": coaches,
    }
    output = Path(args.output)
    js_output = Path(args.js_output)
    output.parent.mkdir(parents=True, exist_ok=True)
    js_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js_output.write_text(
        "window.EV_DESK_DATA=window.EV_DESK_DATA||{};window.EV_DESK_DATA.intradayCoaches="
        + json.dumps(artifact, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f"Wrote {output}")
    for coach in coaches.values():
        print(f"{coach['name']}: {coach['status']} | validation {coach['validation']['ev']}R | holdout {coach['holdout']['ev']}R")


if __name__ == "__main__":
    main()
