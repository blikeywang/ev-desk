#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_ROOT="${1:-${EV_DESK_TRAINING_DATA:-$ROOT/enent contract}}"
WORK_DIR="${EV_DESK_TRAINING_WORKDIR:-/tmp/ev-desk-coach-training}"

if [[ -n "${PYTHON_BIN:-}" ]]; then
  PYTHON="$PYTHON_BIN"
elif [[ -x /opt/miniconda3/bin/python3 ]]; then
  PYTHON=/opt/miniconda3/bin/python3
else
  PYTHON=python3
fi

"$PYTHON" "$ROOT/tools/prepare_coach_training.py" \
  --data-root "$DATA_ROOT" \
  --work-dir "$WORK_DIR"

"$PYTHON" "$ROOT/tools/build_intraday_coaches.py" \
  --data-root "$DATA_ROOT" \
  --output "$ROOT/data/intraday-coaches.json" \
  --js-output "$ROOT/data/intraday-coaches.js"

node "$ROOT/arena-worker/scripts/build-coach-training.mjs" \
  --manifest "$WORK_DIR/manifest.json" \
  --output "$ROOT/data/coach-training.json" \
  --js-output "$ROOT/data/coach-training.js"

node "$ROOT/arena-worker/scripts/export-plan-training-samples.mjs" \
  --manifest "$WORK_DIR/manifest.json" \
  --output "$WORK_DIR/plan-samples.jsonl.gz"

"$PYTHON" "$ROOT/tools/train_plan_gate.py" \
  --samples "$WORK_DIR/plan-samples.jsonl.gz" \
  --output "$ROOT/data/plan-gate-model.json" \
  --js-output "$ROOT/data/plan-gate-model.js"
