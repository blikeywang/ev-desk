#!/usr/bin/env python3
"""Train and audit a plan-quality gate on chronological splits."""

from __future__ import annotations

import argparse
import json
import math
import platform
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import brier_score_loss, roc_auc_score


ROOT = Path(__file__).resolve().parents[1]
META_COLUMNS = {
    "symbol",
    "timeframe",
    "signal_bar_ts",
    "split",
    "net_r",
    "gross_r",
    "cost_r",
    "close_reason",
    "opened_bar_ts",
    "closed_bar_ts",
}


def rounded(value, digits=4):
    value = float(value)
    return round(value, digits) if np.isfinite(value) else None


def max_drawdown(values):
    equity = peak = 0.0
    drawdown = 0.0
    curve = []
    for value in values:
        equity += float(value)
        peak = max(peak, equity)
        drawdown = min(drawdown, equity - peak)
        curve.append(round(equity, 3))
    if len(curve) > 80:
        positions = np.linspace(0, len(curve) - 1, 80).astype(int)
        curve = [curve[index] for index in positions]
    return drawdown, curve


def policy_rows(frame, probabilities, threshold):
    work = frame[
        ["symbol", "timeframe", "signal_bar_ts", "closed_bar_ts", "net_r", "close_reason"]
    ].copy()
    work["probability"] = probabilities
    work = work.loc[work["probability"] >= threshold]
    if work.empty:
        return work
    work = work.sort_values(
        ["symbol", "timeframe", "signal_bar_ts", "probability"],
        ascending=[True, True, True, False],
    )
    work = work.drop_duplicates(["symbol", "timeframe", "signal_bar_ts"], keep="first")
    selected = []
    for _, scope in work.groupby(["symbol", "timeframe"], sort=False):
        busy_until = -math.inf
        for row in scope.sort_values("signal_bar_ts").itertuples(index=False):
            if row.signal_bar_ts <= busy_until:
                continue
            selected.append(row)
            busy_until = row.closed_bar_ts
    return pd.DataFrame(selected, columns=work.columns)


def summarize_policy(frame, probabilities, threshold):
    selected = policy_rows(frame, probabilities, threshold)
    if selected.empty:
        return {
            "n": 0,
            "win_rate": None,
            "ev": None,
            "profit_factor": None,
            "max_drawdown": None,
            "total_r": 0,
            "scope_weighted_ev": None,
            "positive_scope_pct": None,
            "scopes": {},
            "curve": [],
        }
    values = selected["net_r"].to_numpy(dtype=float)
    gains = values[values > 0].sum()
    losses = abs(values[values <= 0].sum())
    drawdown, curve = max_drawdown(values)
    scopes = {}
    weighted_evs = []
    weights = []
    for (symbol, timeframe), scope in selected.groupby(["symbol", "timeframe"]):
        scope_values = scope["net_r"].to_numpy(dtype=float)
        key = f"{symbol}|{timeframe}"
        scopes[key] = {
            "n": int(len(scope_values)),
            "ev": rounded(scope_values.mean(), 3),
            "win_rate": rounded((scope_values > 0).mean() * 100, 1),
            "total_r": rounded(scope_values.sum(), 2),
        }
        weights.append(math.sqrt(min(len(scope_values), 200)))
        weighted_evs.append(scope_values.mean())
    weight_total = sum(weights)
    scope_ev = sum(value * weight for value, weight in zip(weighted_evs, weights)) / weight_total
    return {
        "n": int(len(values)),
        "win_rate": rounded((values > 0).mean() * 100, 1),
        "ev": rounded(values.mean(), 3),
        "profit_factor": rounded(gains / losses, 2) if losses else 9.99,
        "max_drawdown": rounded(drawdown, 2),
        "total_r": rounded(values.sum(), 2),
        "scope_weighted_ev": rounded(scope_ev, 3),
        "positive_scope_pct": rounded(
            sum(value > 0 for value in weighted_evs) / len(weighted_evs) * 100, 1
        ),
        "scopes": scopes,
        "curve": curve,
    }


def objective(summary):
    if summary["n"] < 200 or len(summary["scopes"]) < 6:
        return -math.inf
    drawdown_penalty = abs(summary["max_drawdown"] or 0) / math.sqrt(summary["n"]) * 0.002
    breadth = ((summary["positive_scope_pct"] or 0) - 50) * 0.0005
    return summary["scope_weighted_ev"] - drawdown_penalty + breadth


def probabilities_with_vote_policy(model, frame, feature_columns, active_vote_features):
    values = frame[feature_columns].to_numpy(dtype=float).copy()
    if active_vote_features is not None:
        allowed = set(active_vote_features)
        for index, feature in enumerate(feature_columns):
            if feature.startswith("vote_") and feature not in allowed:
                values[:, index] = 0
    return model.predict_proba(values)[:, 1]


def build_vote_policy_candidates(model, feature_columns):
    ranked = sorted(
        (
            (feature, float(importance))
            for feature, importance in zip(feature_columns, model.feature_importances_)
            if feature.startswith("vote_")
        ),
        key=lambda item: item[1],
        reverse=True,
    )
    ranked_features = [feature for feature, _ in ranked]

    def compact_team_label(features):
        generic = {"vote_edge_relative", "vote_count_for", "vote_count_against"}
        coach_count = sum(feature not in generic for feature in features)
        parts = [f"{coach_count} 位计划席"] if coach_count else []
        if "vote_edge_relative" in features:
            parts.append("总共识")
        if "vote_count_for" in features or "vote_count_against" in features:
            parts.append("票数强弱")
        return " + ".join(parts) or "精简教练输入"

    top_two = ranked_features[:2]
    top_five = ranked_features[:5]
    return [
        {
            "id": "full_council",
            "label": "全体方法镜头",
            "active_vote_features": None,
        },
        {
            "id": "structure_only",
            "label": "仅价格结构与执行纪律",
            "active_vote_features": [],
        },
        {
            "id": "top2_votes",
            "label": compact_team_label(top_two),
            "active_vote_features": top_two,
        },
        {
            "id": "top5_votes",
            "label": compact_team_label(top_five),
            "active_vote_features": top_five,
        },
    ]


def probability_metrics(y, probabilities):
    if len(np.unique(y)) < 2:
        return {"roc_auc": None, "brier": None, "base_rate": rounded(y.mean(), 4)}
    return {
        "roc_auc": rounded(roc_auc_score(y, probabilities), 4),
        "brier": rounded(brier_score_loss(y, probabilities), 4),
        "base_rate": rounded(y.mean(), 4),
    }


def train(frame):
    feature_columns = sorted(column for column in frame.columns if column not in META_COLUMNS)
    for column in feature_columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame[feature_columns] = frame[feature_columns].replace([np.inf, -np.inf], np.nan).fillna(0)
    frame["target_hit"] = frame["close_reason"].eq("target").astype(int)
    development = frame.loc[frame["split"].eq("development")].copy()
    validation = frame.loc[frame["split"].eq("validation")].copy()
    holdout = frame.loc[frame["split"].eq("holdout")].copy()
    if min(len(development), len(validation), len(holdout)) == 0:
        raise ValueError("All chronological splits must contain samples")

    train_x = development[feature_columns].to_numpy(dtype=float)
    validation_x = validation[feature_columns].to_numpy(dtype=float)
    holdout_x = holdout[feature_columns].to_numpy(dtype=float)
    train_y = development["target_hit"].to_numpy(dtype=int)
    validation_y = validation["target_hit"].to_numpy(dtype=int)
    holdout_y = holdout["target_hit"].to_numpy(dtype=int)
    model = GradientBoostingClassifier(
        n_estimators=120,
        learning_rate=0.04,
        max_depth=3,
        min_samples_leaf=250,
        subsample=0.80,
        random_state=42,
    )
    model.fit(train_x, train_y)
    validation_prob = model.predict_proba(validation_x)[:, 1]
    threshold_values = set(
        np.quantile(
            validation_prob,
            [0.90, 0.95, 0.975, 0.99, 0.9925, 0.995, 0.997, 0.999],
        ).tolist()
    )
    threshold_values.add(0.5)
    candidates = []
    best = None
    for threshold in sorted(threshold_values):
        summary = summarize_policy(validation, validation_prob, float(threshold))
        score = objective(summary)
        row = {
            "threshold": rounded(threshold, 6),
            "selection_score": rounded(score, 5) if np.isfinite(score) else None,
            "validation": summary,
        }
        candidates.append(row)
        if np.isfinite(score) and (best is None or score > best["score"]):
            best = {"score": score, "threshold": float(threshold)}
    if best is None:
        raise RuntimeError("No plan gate candidate met the minimum validation coverage")

    vote_policy_reports = []
    for policy in build_vote_policy_candidates(model, feature_columns):
        policy_validation_prob = probabilities_with_vote_policy(
            model, validation, feature_columns, policy["active_vote_features"]
        )
        policy_validation = summarize_policy(
            validation, policy_validation_prob, best["threshold"]
        )
        score = objective(policy_validation)
        vote_policy_reports.append(
            {
                **policy,
                "selection_score": rounded(score, 5) if np.isfinite(score) else None,
                "validation": policy_validation,
            }
        )
    eligible_vote_policies = [
        policy for policy in vote_policy_reports if policy["selection_score"] is not None
    ]
    selected_vote_policy = max(
        eligible_vote_policies,
        key=lambda policy: policy["selection_score"],
        default=vote_policy_reports[0],
    )
    selected_vote_features = selected_vote_policy["active_vote_features"]
    validation_prob = probabilities_with_vote_policy(
        model, validation, feature_columns, selected_vote_features
    )
    holdout_prob = probabilities_with_vote_policy(
        model, holdout, feature_columns, selected_vote_features
    )
    validation_summary = summarize_policy(validation, validation_prob, best["threshold"])
    holdout_summary = summarize_policy(holdout, holdout_prob, best["threshold"])
    for policy in vote_policy_reports:
        policy_holdout_prob = probabilities_with_vote_policy(
            model, holdout, feature_columns, policy["active_vote_features"]
        )
        policy["holdout"] = summarize_policy(
            holdout, policy_holdout_prob, best["threshold"]
        )
    all_vote_features = [feature for feature in feature_columns if feature.startswith("vote_")]
    active_vote_features = all_vote_features if selected_vote_features is None else selected_vote_features
    active_coach_ids = [
        feature.removeprefix("vote_")
        for feature in active_vote_features
        if feature.removeprefix("vote_")
        not in {"edge_relative", "count_for", "count_against"}
    ]
    deployment_scopes = []
    for scope, validation_scope in validation_summary["scopes"].items():
        holdout_scope = holdout_summary["scopes"].get(scope)
        if (
            holdout_scope
            and validation_scope["n"] >= 20
            and holdout_scope["n"] >= 20
            and validation_scope["ev"] > 0
            and holdout_scope["ev"] > 0
        ):
            deployment_scopes.append(scope)
    top = sorted(
        (
            {"feature": feature, "importance": rounded(importance, 5)}
            for feature, importance in zip(feature_columns, model.feature_importances_)
        ),
        key=lambda item: item["importance"],
        reverse=True,
    )[:15]
    status = "accepted_limited" if deployment_scopes else "rejected"
    return {
        "schema": "ev_desk_plan_gate_v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "training_runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
            "scikit_learn": sklearn.__version__,
        },
        "status": status,
        "boundary": (
            "Shallow gradient-boosting gate trained on development, hyperparameters and a predeclared coach-vote policy selected on validation, "
            "and evaluated once on final holdout. It may block plans; it never creates an order."
        ),
        "samples": {
            "development": int(len(development)),
            "validation": int(len(validation)),
            "holdout": int(len(holdout)),
            "sampling": "15m every 8 bars; 1h every 2 bars; 4h every bar; both directions; executed plans only",
        },
        "selection": {
            "probability_threshold": rounded(best["threshold"], 6),
            "selection_score": rounded(best["score"], 5),
            "used_holdout": False,
        },
        "deployment": {
            "mode": "veto_only",
            "scopes": deployment_scopes,
            "active_coach_ids": active_coach_ids,
            "boundary": "The gate may veto an existing consensus plan only in scopes that were positive in both validation and holdout; it never creates direction, entry, or size.",
        },
        "coach_vote_policy": {
            "selected": selected_vote_policy["id"],
            "label": selected_vote_policy["label"],
            "active_vote_features": active_vote_features,
            "active_coach_ids": active_coach_ids,
            "suppressed_vote_features": [
                feature for feature in all_vote_features if feature not in active_vote_features
            ],
            "selection_score": selected_vote_policy["selection_score"],
            "used_holdout": False,
            "boundary": "The vote-feature count is selected on validation only. Final holdout reports every predeclared control after the policy is frozen; individual coaches still cannot create a trade.",
            "candidates": vote_policy_reports,
        },
        "probability_quality": {
            "validation": probability_metrics(validation_y, validation_prob),
            "holdout": probability_metrics(holdout_y, holdout_prob),
        },
        "validation": validation_summary,
        "holdout": holdout_summary,
        "model": {
            "type": "shallow_gradient_boosting_classifier",
            "features": feature_columns,
            "active_vote_features": active_vote_features,
            "base_log_odds": rounded(
                math.log(model.init_.class_prior_[1] / model.init_.class_prior_[0]), 10
            ),
            "learning_rate": model.learning_rate,
            "trees": [
                {
                    "children_left": estimator[0].tree_.children_left.tolist(),
                    "children_right": estimator[0].tree_.children_right.tolist(),
                    "feature": estimator[0].tree_.feature.tolist(),
                    "threshold": [
                        rounded(value, 10) for value in estimator[0].tree_.threshold
                    ],
                    "value": [
                        rounded(value[0][0], 10) for value in estimator[0].tree_.value
                    ],
                }
                for estimator in model.estimators_
            ],
            "threshold": rounded(best["threshold"], 10),
        },
        "top_feature_importances": top,
        "top_validation_candidates": sorted(
            [row for row in candidates if row["selection_score"] is not None],
            key=lambda row: row["selection_score"],
            reverse=True,
        )[:8],
        "execution": {
            "pending_bars": 12,
            "maximum_hold_bars": 30,
            "same_bar": "stop first",
            "round_trip_cost_pct": 0.10,
            "one_active_plan_per_symbol_timeframe": True,
        },
        "research_boundary": (
            "The architecture was finalized after exploratory offline audits. "
            "Treat the positive holdout as research evidence, not as an untouched production guarantee; "
            "forward-sealed arena results remain the deployment authority."
        ),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--samples",
        default="/tmp/ev-desk-coach-training/plan-samples.jsonl.gz",
    )
    parser.add_argument(
        "--output",
        default=str(ROOT / "data/plan-gate-model.json"),
    )
    parser.add_argument(
        "--js-output",
        default=str(ROOT / "data/plan-gate-model.js"),
    )
    args = parser.parse_args()
    print(f"Loading {args.samples}...")
    frame = pd.read_json(args.samples, lines=True, compression="gzip")
    print(f"Training on {len(frame):,} plan outcomes...")
    result = train(frame)
    output = Path(args.output)
    js_output = Path(args.js_output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js_output.write_text(
        "window.EV_DESK_DATA=window.EV_DESK_DATA||{};"
        f"window.EV_DESK_DATA.planGate={json.dumps(result, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"Wrote {output}")
    print(f"Wrote {js_output}")
    print(
        f"Gate {result['status']}: validation {result['validation']['scope_weighted_ev']}R, "
        f"holdout {result['holdout']['scope_weighted_ev']}R"
    )


if __name__ == "__main__":
    main()
