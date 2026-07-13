#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-live}"

if [[ "$MODE" != "live" && "$MODE" != "full" ]]; then
  echo "Usage: tools/update_data.sh [live|full]" >&2
  exit 2
fi

if [[ "$MODE" == "full" ]]; then
  (cd "$ROOT/arena-worker" && npm run evidence)
fi

if [[ -n "${PYTHON_BIN:-}" ]]; then
  PYTHON="$PYTHON_BIN"
elif [[ -x /opt/miniconda3/bin/python3 ]]; then
  PYTHON=/opt/miniconda3/bin/python3
else
  PYTHON=python3
fi

PAUL_ARGS=()
if [[ "$MODE" == "live" ]]; then
  PAUL_ARGS+=(--skip-calibration)
fi
"$PYTHON" "$ROOT/tools/build_paul_wei_feed.py" "${PAUL_ARGS[@]}"

if [[ -n "${ARENA_API:-}" || -n "${ADMIN_TOKEN:-}" ]]; then
  if [[ -z "${ARENA_API:-}" || -z "${ADMIN_TOKEN:-}" ]]; then
    echo "ARENA_API and ADMIN_TOKEN must be set together." >&2
    exit 2
  fi
  BASE="${ARENA_API%/}"
  curl -fsS -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$ROOT/data/expert-views/paul-wei.json" \
    "$BASE/api/v1/admin/expert-views"
  echo
  curl -fsS -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "$BASE/api/v1/admin/run"
  echo
else
  echo "Updated local data files. Set ARENA_API and ADMIN_TOKEN to publish them."
fi
