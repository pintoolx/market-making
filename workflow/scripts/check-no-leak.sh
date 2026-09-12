#!/usr/bin/env bash
# Runs the confidential workflow simulation and asserts that no private
# strategy / limit value appears in the output. See scripts/leak-scan.ts.
#
# Usage: scripts/check-no-leak.sh [env-file]   (default: .env, falls back to .env.example)
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then ENV_FILE=".env.example"; fi

OUT="$(mktemp -t simulate-output.XXXXXX)"
trap 'rm -f "$OUT"' EXIT

echo "simulating with env=$ENV_FILE ..."
cre workflow simulate market-maker-auth --non-interactive --trigger-index 0 --env "$ENV_FILE" > "$OUT" 2>&1 || {
  echo "simulate failed:"; cat "$OUT"; exit 1
}

bun run scripts/leak-scan.ts "$ENV_FILE" "$OUT"
