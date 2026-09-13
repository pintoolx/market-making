# Remaining Builder integration

The user requested one PR for the remaining changes on 2026-09-13. Work belongs
on `feat/builder-cre-delivery`. Review and fix the PR, then leave it unmerged.
Only a subsequent explicit user instruction authorizes merging. Do not roll out
this branch to Railway or change existing Maker positions as part of review.

The full product acceptance remains in `SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md`.
Its merge/rollout completion criterion is deferred by this newer instruction.

Implemented and locally verified in this batch:

- Two-phase Builder evaluation and delivery through the existing confidential
  workflow, with a persisted report identity and exact nonce.
- Trusted binding of a compiled Maker instance to the signed Provider version
  and current Maker consent; no manual strategy catalog changes.
- Event routing, selection, delivery ordering and uncertain-receipt recovery.
- Browser first-consent and stop-updates flows, including the corrected revoke
  signature message. Wallet plans remain unsigned.
- Actual CRE CLI evaluation through signed template/consent and PostgreSQL,
  with live market/Guard reads and no broadcast. See `BUILDER-CRE-DELIVERY.md`.

Keep this as one draft PR while the remaining product acceptance is incomplete:

- [ ] Wallet transaction execution, replacement and failed-readback recovery.
- [ ] Consented source-outage pause and recovery, with delivery evidence.
- [ ] Complete requirement-to-settlement acceptance.
- [ ] New public Sepolia lifecycle matrix and resident-worker recovery evidence.

Do not treat passing the integration checks as completion of these items. No
rollout or public-chain write was performed in this batch.

Keep local simulation, fork evidence and public Sepolia evidence distinct. CRE
deployment, activation and secret upload remain outside this authorization.
Record verification and unresolved acceptance items in the final PR description.
