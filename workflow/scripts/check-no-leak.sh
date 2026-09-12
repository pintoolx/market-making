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
CONFIG="$(mktemp -t pintool-leak-config.XXXXXX.json)"
trap 'rm -f "$OUT" "$CONFIG"' EXIT

# Leak checks inspect simulator output and must never depend on, or attempt, an
# onchain write. Preserve the checked-in config and override only publishMode.
bun -e 'const p=process.argv[1],o=process.argv[2];const c=await Bun.file(p).json();c.publishMode="dry-run";await Bun.write(o,JSON.stringify(c))' \
  market-maker-auth/config.staging.json "$CONFIG"

echo "simulating with env=$ENV_FILE ..."
cre workflow simulate market-maker-auth --non-interactive --trigger-index 0 --env "$ENV_FILE" --config "$CONFIG" > "$OUT" 2>&1 || {
  echo "simulate failed:"; cat "$OUT"; exit 1
}

bun run scripts/leak-scan.ts "$ENV_FILE" "$OUT"
