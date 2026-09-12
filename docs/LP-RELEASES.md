# Versioned CLMM publication and readiness

This is the first integration stage from [GUARD-REPORT-V1.md](GUARD-REPORT-V1.md), not completion of all six templates or automatic Maker onboarding. It adds a signed publication registry, a shared executable envelope, a compiler adapter, approved policy/version bindings, and live readiness checks. The existing executor journal still owns approvals, ship, swap, recovery, monitoring and dock.

## Provider publication

`/studio` accepts CLMM publication for Ethereum Sepolia WETH/USDC only. The [shared schema](../shared/lp-release.mjs) defines an asymmetric range, zero swap fee, atomic per-token fill/inventory ceilings and a legacy lifetime field for bounded reports. The Studio does not ask for a lifetime: current Maker mandates explicitly request standing authorization. Legacy schema-1/2 Maker inputs continue to use the stored bounded TTL. Percentages have at most two decimal places; the browser rejects excess token precision before unit conversion. XYC, Pegged, Decay, Inventory and Shared-capital publication stay disabled until their specific mappings are implemented. Revenue sharing is disabled.

The private rule allows both Maker directions when `rss-simple-returns-30m-v1` volatility is at or below the entered threshold. It has a fixed 30-minute window, explicit percentage-to-bps conversion and independent evaluation on each observation. There is no recovery threshold, hysteresis, natural-language execution or automatic range renewal in this editor.

The browser encrypts the policy with the configured workflow public key using the existing X25519/XChaCha20-Poly1305 envelope. The Provider's EOA wallet signs the canonical release **and ciphertext**. The service verifies that signature before persisting an immutable version in `MANDATE_STATE_DIR/provider-releases/<id>/<version>.json`. An ID is scoped to the Provider wallet and CLMM template. A concurrent conflicting write cannot overwrite a version; an exact retry returns the existing version. Files are atomically linked only after a complete write. Deployment must use one shared persistent filesystem, not independent per-replica state directories.

Public list/history responses omit the ciphertext, signature and private rule. Reopening the editor restores the latest public envelope. The service cannot return plaintext private thresholds: creating a new version requires entering the threshold again. Inputs remain in component memory until success or leaving the editor. They are never written to local/session storage by the new editor; failures preserve inputs and the signed request for retries within that editor session. Old browser drafts/listing previews are not migrated or treated as executable policies.

| Endpoint | Purpose |
|---|---|
| `GET /v1/lp-capabilities` | Shared supported combinations |
| `GET /v1/provider-strategies` | Latest public versions, including withdrawal state |
| `GET /v1/provider-strategies/:id/versions/:version` | An immutable public version |
| `POST /v1/provider-strategies` | `{release, envelope, signature}`; publish/update/withdraw by signed next version |
| `GET /v1/strategies` | Operator-provisioned Maker programs; saving a publication does not add one |

Withdrawal removes that version and all preceding versions from new provisioning/evaluation. Publishing a later version does not revive those older approvals. It **does not send a transaction**, revoke an already accepted report or dock assets. Standing onchain permissions persist until an explicit Guard update, revocation or dock; bounded legacy permissions also stop at report expiry. Registry withdrawal alone does not revoke standing authorization. An existing Maker stays pinned to a version; updating a Provider listing cannot retarget that Maker's program silently.

Encryption here protects browser-to-service policy transport/storage, but does not prove enclave custody. The configured local CRE simulator's operator can access decrypted inputs. Real DON/TEE deployment and enrollment remain separate; no workflow deployment or secret upload was performed for this change. The mandate service is operator-managed; permissionless automated provisioning is not implemented.

## Compile and provision a Maker program

The [adapter](../contracts/aqua-executor/src/lp-release.ts) takes a signed registry record, Maker address, two allocation amounts, salt, future deadline, a reference price with its observation time, and the existing executor `RiskPolicy`. It verifies the signature/digest and token domain, rejects allocations above the public envelope, checks reference age (at most 90 seconds), maps the asymmetric percentages to canonical concentration bounds and produces an existing `aqua-execution-v1` ship request. This is an operator-supplied reference observation; the timestamp alone is not proof of price authenticity. The executor's price/risk checks and a fresh quote remain necessary before any asset action.

For example, reference `2500`, below `3%`, above `7%` produces **2425–2675 USDC/WETH**. The version/ciphertext digest participates in the program salt, so even an otherwise identical new publication gets a new hash and cannot reuse its predecessor's report. Repeating exactly the same input yields the same request and hash.

```bash
# From contracts/aqua-executor/. This only writes a new local plan; output must not already exist.
node scripts/prepare-lp-release.ts <plan-input.json> <new-plan.json>
```

`plan-input.json` has `{publication:{release,envelope,signature,digest}, maker, amounts, salt, deadline, reference:{price,observedAt}, policy}`. Preserve the output alongside the existing private executor state; do not publish Maker risk inputs as public evidence. The output includes `request`, `strategyHash`, `catalogEntry` and `workflowBinding`.

The operator must review the concrete program and Maker limits, then provision:

1. Catalog key `<release.id>.v<release.version>` → the generated `catalogEntry` in `MANDATE_STRATEGY_CATALOG`.
2. The generated `workflowBinding` in the workflow's `providerBindings`. It pins program hash, Provider, decrypted `strategyId` and ciphertext hash.
3. The same persistent `MANDATE_STATE_DIR` for service and runner. The runner resolves the exact saved envelope, rejects a withdrawn release and passes ciphertext to the HTTP trigger. The workflow checks the binding before fetching secrets and checks the policy version after decryption.
4. Execute the generated `request` through the existing executor, preserving its journal and original HODL baseline. The Maker wallet signatures, funding/approvals and valid Guard report are still required. A compilation or saved listing is not an executed ship.

These are **manual provisioning steps**, not automatic publishing of a workflow or signing of Maker asset transactions. The browser does not yet fund and ship a newly published range on its own. There is no browser test claiming that complete path has run on Sepolia.

## Readiness

Set `MANDATE_GUARD_ADDRESS`, `MANDATE_AQUA_ADDRESS`, the existing router/network/RPC settings, and each catalog entry's `programDeadline` from its compiled plan. Missing configuration or a failed RPC produces **unverified**, never ready. Existing catalog entries without a verified deadline remain unverified for that condition.

The [reader](../orchestrator/src/lp-readiness.mjs) checks chain ID and block freshness, then reads Guard report/active hash, both Aqua raw balances, Maker wallet balances and Maker→Aqua allowances at **one block**. The conservative funding check requires wallet/allowance coverage of both current raw balances. Both token balances must be positive. Only all conditions together yield `ready-for-quote`; each actual trade still needs a fresh quote, slippage checks, taker funding and Guard execution.

The public readiness snapshot expires after at most 30 seconds, earlier at report/program expiry. The frontend stops displaying a cached ready state when it expires. Historical report acceptance, ship status and current funding appear separately. The reader and mandate `GET` path send no transactions; reevaluation publishes only when the derived execution terms change.

Report evidence now reads Guard state at the accepted event's block and matches nonce/digest, preventing a later report from being attached to an older transaction. This does not add a durable concurrent CRE nonce allocator or correlate simultaneous requests to separate report IDs; serialize executions for a Maker.

## Evidence and remaining work

The [integration verification](../workflow/verification/lp-release-integration/README.md) covers signed HTTP registry behavior, compile/version binding, the actual CRE HTTP simulation with browser-sealed synthetic policies, local Router tests and a read-only Sepolia observation of a docked strategy. The earlier [live broadcast proof](../workflow/verification/live-market-guard/README.md) is preserved at source checkpoint `b769b92`; its historical transactions are not new-version tests.

Remaining product work includes automatic Maker plan approval/ship/report coordination, restoring private inputs on another device, range rollover with refreshed publication binding, nonzero guarded fees, other templates, revenue settlement and real DON/TEE delivery. The Railway service runs the packaged simulator and uses a shared persistent state directory. Its image includes the shared module and receiver ABI required by the integrated workflow. Container deployment does not establish production DON or TEE execution.
