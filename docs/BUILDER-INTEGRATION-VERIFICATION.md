# Builder integration verification

Recorded 2026-09-14 for Draft [PR #102](https://github.com/pintoolx/market-making/pull/102).
The PR remains unmerged. No Railway rollout, new public-chain transaction, CRE
deployment, activation or secret upload is part of these results.

## Results

| Check | Result and scope |
|---|---|
| Builder service | 105 passed, one optional network test skipped; disposable local PostgreSQL, including the enabled actual local Anvil wallet test |
| Strategy domain | 19 passed |
| Executor | 97 passed, three optional checks skipped; includes actual local router regressions for the unsafe fee composition |
| Orchestrator | 58 passed, one optional check skipped |
| Confidential workflow | 67 passed |
| Guard report delivery package | 16 passed |
| Frontend public verification | Five passed |
| Ordinary browser acceptance | Design, Provider templates and Maker preparation all passed; synthetic identity/model/inventory/settlement adapters |
| Wallet browser acceptance | Passed real UI/API/PostgreSQL/compiler/simulation gate and actual wallet transactions on an isolated Sepolia fork |
| Real OpenAI | Three capability/lifecycle/alternative/edit turns passed; unchanged parameters asserted against saved drafts |
| Actual CRE CLI + PostgreSQL | Signed Provider/consent input and healthy -> pause -> recovery candidates passed with live public market/Guard reads and no broadcast |
| Static verification | Builder/domain/executor/frontend/workflow/report TypeScript checks, scoped Builder lint, English-copy check and production Next build passed |

Optional default-suite skips are not counted as passes. The explicit wallet fork
and CLI probes are separate acceptance runs, not evidence that every optional
network scenario passed. GitHub check results are tracked on the PR at its final
head; local results above do not stand in for those checks.

## Evidence and reproducibility

- [Wallet fork evidence](builder-cre-verification/wallet-fork-browser.json):
  actual approved and reverted swaps, explicit Maker transactions and durable
  receipt recovery. Synthetic funds, public disposable Anvil key, forwarder
  impersonation and account-code override are disclosed. Fork transaction hashes
  are not public Sepolia receipts.
- [Real model evidence](builder-cre-verification/capability-lifecycle-agent.json):
  prompts, replies, tool events and revisions. Run
  `node packages/builder-service/scripts/eval-capability-lifecycle.ts` with a
  configured OpenAI environment and disposable localhost database. Do not print
  the environment. No wallet/report capability is installed in this probe.
- [Actual CLI outage evidence](builder-cre-verification/postgres-cli-outage.json):
  exact database nonces 1, 2, 3 and public direction masks 3, 0, 3. The pause path
  works without a valid policy decryption key. Delivery rows remain pending.
  Run `node workflow/scripts/verify-builder-pg-evaluation.mjs` with the working
  local CRE CLI/toolchain and a disposable database.
- [Fee regression](BUILDER-FEE-GUARD-LIMITATION.md): successful legacy swaps
  demonstrate gross-input and post-inventory cap violations for all three curves
  in both directions. Production paths now reject nonzero fees. Historical
  transaction recovery and risk reduction are separately tested.

The database scripts require `BUILDER_TEST_DATABASE_URL` pointing to localhost
and permission to create/drop their own disposable databases. Wallet acceptance
commands and required Anvil/Playwright tooling are documented in
[wallet execution](BUILDER-WALLET-EXECUTION.md). Public fixture evidence contains
no user credentials or private strategy inputs.

## Review findings addressed

The fee test originally failed at the amount-cap boundary, exposing the unsafe
legacy composition. The mitigation blocks nonzero fees while retaining dock/
revoke/recovery. A real OpenAI request then exposed strict-tool-schema rejection;
all twelve schemas now have a structural regression and the real multi-turn
probe passes. Browser checks found a stale transaction journal after rejection
and an overly broad simulation-card selector; both were corrected and rerun.
Historical artifact loading now keeps expired/unsupported strategy recovery
available. Source polling preserves stale/error health on skipped polls, bounded
backfill does not claim fresh health, and health scheduling rotates subscriptions
instead of repeatedly checking only the first batch.

These results establish the immediate implementation and local acceptance. The
funded user-wallet/public-chain resident worker path and continuous deployed
requirement-to-settlement acceptance remain in [the checklist](BUILDER-REMAINING-PR.md).
