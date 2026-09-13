# Maker inventory, compilation and simulation workspace

The Maker conversation now opens a preparation dialog for its exact draft revision. Users can read current wallet/Aqua inventory, compile and inspect the guarded program, start or cancel a durable background simulation, inspect case outcomes and return to the conversation to make changes. The component receives no wallet signer. This batch adds no production API, migration or chain transaction; it connects the already scoped inventory/artifact/simulation services.

## What the screen establishes

- Inventory distinguishes native gas ETH from WETH, both requested allocations, wallet balances and allowances to Aqua. Known strategy virtual balances and shared inventory/allowance capacities remain separate. It preserves the `live-read`, `fork-with-overrides` or `mock` label, observation time, unfinalized block and incomplete-commitment/truncation boundary. It makes no claim about uncommitted funds or live report validity. Reads remain explicit and are cleared when re-reading or leaving the dialog.
- Compilation shows the exact current program/order/strategy hashes, Guard target and decoded instructions. The browser independently decodes the bytes and checks the requested artifact ID, draft/content/profile identity, Maker, pair, allocation, deadline, salt, caps and hash consistency. The existing server compiler compares the complete curve encoding against the spec. This browser check is a read-only consistency check, not the future wallet preflight or a proof of arbitrary natural-language requirements.
- Simulations show queued/running/completed/failed/cancelled state, evidence mode, skipped cases, failure guidance and individual cases. A skipped case prevents a full-coverage claim. A completed mock result stays explicitly non-chain evidence. Fork results still use synthetic funding/report authority; they do not demonstrate TEE verification or actual Maker funding.
- Changes and restoration create new revisions. Historical artifacts/results remain visible and cannot supply the current simulation action. Refresh checks the owned draft; changes while the dialog is open disable further preparation until the latest draft is loaded. Background jobs continue outside the browser and are recovered through persisted lists after reload.
- Lost compile/start/cancel responses retain the same request key. Retrying does not create another artifact/job or spend another new-job budget. Polling runs only while the loaded list contains an active simulation; no report renewal or chain write is introduced. Authentication expiry unmounts the dialog.

Requirement acceptance, Maker private limits and explicit automation consent, wallet transaction plans, trusted bindings and event delivery remain separate full-goal work. All `registrationReady` values remain false. No executable export or approve/ship action is enabled by this screen.

## Verification

Four frontend unit tests cover public publication/signature verification and Maker preparation consistency checks, including substituted revisions, identities, allocations, program hashes, caps, spender and evidence modes. Frontend typecheck, scoped lint and the production static Next build pass.

The browser fixture uses the real React components, wallet session/HTTP/store/agent layers, deterministic compiler, PostgreSQL simulation leases and `runSimulation` lifecycle. Only identity/model, inventory data and settlement adapter are synthetic. The new acceptance verifies insufficient allowance, explicit evidence labels, lost compile/start responses and same-key retries, job cancellation, skipped coverage, reload while a job continues, case detail, failed tiny-allocation simulation, stale results after edits/restores, session expiry and mobile overflow. It asserts that only login signatures were requested. It does not duplicate or replace the actual-fork engine evidence from the earlier [lifecycle](BUILDER-LIFECYCLE-SIMULATION.md) and [inventory](BUILDER-WALLET-INVENTORY.md) batches.

All three browser scripts pass sequentially against one newly created disposable database. The new browser CI job installs pinned Playwright/Chromium in a local virtualenv, bundles the actual components, runs the public unit tests and these same acceptance scripts without secrets or public-chain writes. The service-only PostgreSQL job and Cloudflare production build remain separate checks.

After installing the frontend/Builder dependencies and Python Playwright with Chromium, run from the repository root:

```sh
# Set BUILDER_TEST_DATABASE_URL to a disposable localhost PostgreSQL service.
node --test frontend/test/builder-publication.test.mjs frontend/test/builder-preparation.test.mjs
bash packages/builder-service/test/browser/run-all.sh
```

The runner builds both fixtures, starts its own server on localhost:3311, waits for readiness, runs baseline → templates → preparation, and stops only its server. The server removes only the database it created. Screenshots under ignored `.cache/builder/` contain synthetic test data. Production application code never imports fixture control routes or the synthetic inventory/evaluator.
