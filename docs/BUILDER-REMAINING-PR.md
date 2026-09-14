# Remaining Builder integration

Updated 2026-09-14. The user requested one PR for the remaining changes.
Work belongs on `feat/builder-cre-delivery`, Draft
[PR #102](https://github.com/pintoolx/market-making/pull/102). Review and fix it,
then leave it unmerged. Only a subsequent explicit user instruction authorizes
merging. Do not roll out this branch to Railway or change existing Maker
positions as part of review.

The full acceptance remains in `SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md`.
Its merge/rollout completion criterion is deferred by this newer instruction.

## Implemented in this PR

- [x] Signed Provider version and Maker consent feed two-phase local CRE
  evaluation/delivery with exact report identities/nonces, routing, ordering,
  change-only updates and ambiguous-broadcast recovery.
- [x] Capability/lifecycle context distinguishes implemented features, configured
  services and observed chain evidence. Real OpenAI multi-turn evaluation checks
  unsupported requests, alternatives and preservation of unrelated parameters.
  All twelve tools now have OpenAI-compatible strict schemas.
- [x] Maker wallet preflight, explicit signing, durable transaction history,
  replacement/reorg/lost-response recovery and historical dock/revoke controls.
  Actual browser wallet and settlement acceptance passes in a Sepolia fork.
- [x] Public Kraken and multi-contract EVM sources; bounded requests/backfill,
  persistent health transitions and signed source-outage pause/recovery.
  Real CLI + PostgreSQL evaluation verifies healthy -> pause -> recovery.
- [x] Reject unsafe legacy nonzero LP-fee/Guard composition. Regression tests
  reproduce gross-input and real-inventory cap violations. New flows use zero
  fees only; historical recovery remains available.

See [wallet execution](BUILDER-WALLET-EXECUTION.md),
[CRE delivery](BUILDER-CRE-DELIVERY.md),
[fee limitation](BUILDER-FEE-GUARD-LIMITATION.md) and
[verification](BUILDER-INTEGRATION-VERIFICATION.md).

## Still outside completed acceptance

- [ ] New funded user-wallet/public Sepolia lifecycle: approve, ship, real report
  acceptance, successful trade, rejected trade with unchanged balances, revoke,
  dock and allowance revocation, with public receipts.
- [ ] Resident worker public-chain outage pause/recovery and restart during
  broadcast, including exact accepted nonces and canonical receipts.
- [ ] Continuous natural-language requirement -> signed Provider version ->
  Maker acceptance -> public settlement evidence in the deployed product.
  Individual model, browser, CLI and fork tests do not prove this whole path.
- [ ] User-authorized merge/rollout, production migrations/configuration and
  live Privy/user-wallet acceptance. Keep these pending until explicitly allowed.

Public acceptance should use a newly selected disposable Maker controlled by
the user; this review does not authorize reuse of existing Maker positions or
reading their keys. Prepare the selected template, expected transaction plans
and event scenarios first, then record wallet/report receipts during the
authorized deployment stage. Fork hashes are not public receipts.

Full SwapVM opcode coverage, new fee-aware Guard design and automatic asset
rebalancing are deferred. CRE deployment, activation and secret upload remain
outside this authorization. No new public-chain transaction or Railway rollout
was performed for this implementation.
