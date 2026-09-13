#!/usr/bin/env bash
set -euo pipefail

# Run from the workspace root. The server creates/removes its own localhost database.
if curl --silent --fail http://127.0.0.1:3311/fixture/token --output /dev/null; then
  printf '%s\n' 'Port 3311 already has a fixture; stop its owner before starting a fresh acceptance run.' >&2
  exit 1
fi
mkdir -p .cache/builder
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/private-check.mjs --bundle --platform=node --format=esm --outfile=.cache/builder/private-check.mjs
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/entry.jsx --bundle --format=esm --platform=browser --jsx=automatic --conditions=style --external:/hero.svg --outdir=.cache/builder/browser '--define:process.env.NEXT_PUBLIC_MANDATE_API_URL="http://127.0.0.1:3311"' '--define:process.env.NEXT_PUBLIC_CONFIDENTIAL_WORKFLOW_PUBLIC_KEY=undefined' '--define:process.env.NODE_ENV="development"'
node packages/builder-service/test/browser/server.mjs > .cache/builder/browser-server.log 2>&1 &
builder_fixture_pid=$!
cleanup() {
  kill -TERM "$builder_fixture_pid" 2>/dev/null || true
  wait "$builder_fixture_pid" || true
}
trap cleanup EXIT
builder_fixture_ready=false
for ((builder_fixture_attempt=0; builder_fixture_attempt<100; builder_fixture_attempt++)); do
  if ! kill -0 "$builder_fixture_pid" 2>/dev/null; then cat .cache/builder/browser-server.log; exit 1; fi
  if curl --silent --fail http://127.0.0.1:3311/fixture/token --output /dev/null; then builder_fixture_ready=true; break; fi
  sleep 0.1
done
if [[ "$builder_fixture_ready" != true ]]; then cat .cache/builder/browser-server.log; exit 1; fi
python3 packages/builder-service/test/browser/run.py
python3 packages/builder-service/test/browser/templates.py
python3 packages/builder-service/test/browser/preparation.py
