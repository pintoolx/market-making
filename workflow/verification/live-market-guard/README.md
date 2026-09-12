# Live CRE acquisition → Sepolia Guard → concentrated swap

Run date: 2026-09-12. This run used the **existing** Ethereum Sepolia Aqua, pinned SwapVM router and Guard V2 `maker-active-v1`. No contracts or DON workflow were deployed. The actual CRE CLI executed the confidential handler locally, supplied explicitly **public synthetic policies** through the secret API, and broadcast reports through the CLI simulation forwarder. This is not real DON/TEE attestation.

## Verified path

```text
Kraken ETH/USDC book + completed candles + Sepolia finalized wallet balances
  → market-observation-v2 validation
  → market-maker-auth policy intersection
  → shared report delivery adapter
  → CRE report / writeReport / simulation forwarder
  → current Guard V2
  → allowed CLMM swap / DirectionDisabled mined rejection
  → paused report / dock / Maker and taker allowance cleanup
```

Maker: `0x32F79282124EaFc681601cDCa2883C672C72D340`.
Taker: `0x9C69F55b9E6836b8e096C0F61202665C869922Cc`.
Guard: `0xfadc3165abeb127a0815d5ea4e2862ed430e1f70`.
Strategy: `0x85c6ecaab6b1f6e61877f61760eed5dcc843962b083aa0da7bb2f60012811646`.

The program allocated **0.002 WETH + 5 USDC**, with an explicit demo range of **2,000–3,000 USDC/WETH** and zero fee. This fixed range does not prove frontend range mapping. Report limits were computed from live market data and [public synthetic policies](../../fixtures/public-live-demo.json); the program's own Guard envelope also constrained each trade.

| Step | Ethereum Sepolia evidence |
|---|---|
| Initial paused CRE report | [955947…763a](https://sepolia.etherscan.io/tx/0x955947583290fae2d20addf564def4b61e1c75f550e0d9d165ad944b6f4a763a) |
| Ship | [b47480…1fb4](https://sepolia.etherscan.io/tx/0xb474805296df2e90ad601b550a5aa04c5d9dc115458ff4c33bbb73b526ca1fb4) |
| CRE permits both directions | [CRE allow report](https://sepolia.etherscan.io/tx/0x031cec36962b0a0028cefe953e6814620fcbf17fd95bf102be6562a7a0595f00) |
| Taker spends **0.5 USDC** successfully | [836160…f4cf](https://sepolia.etherscan.io/tx/0x83616005b47248716044f37f56fff94ebf307c58c330ef5cc51445eb180ef4cf) |
| CRE permits only Maker buying WETH | [180b49…a8e4](https://sepolia.etherscan.io/tx/0x180b492e7180a6ddad99851624193e541f84a2e7933efaefeeb6aaaf2cb7a8e4) |
| Opposite direction is mined and reverted | [a3011d…87ad](https://sepolia.etherscan.io/tx/0xa3011d753f5ad28a4c6bd2e1727d41b0eaaff2d53ffd95c4a517cd52f06187ad) |
| Final paused CRE report | [82c518…ed4e](https://sepolia.etherscan.io/tx/0x82c51809f0bfe15065d6095e4788997f94876f09c5af90dff2951b4e9c08ed4e) |
| Dock | [020d9e…5ca4](https://sepolia.etherscan.io/tx/0x020d9efd11c87f84a0c84a5ed9896f855d4fc1ae6ab57808eba2613e375e5ca4) |
| Remaining taker allowance revoked | [e4624c…baa1](https://sepolia.etherscan.io/tx/0xe4624ca3c0fc107790b8118fdf93285eb792285f763ec3509501b871b539baa1) |

Independent RPC verification covered **15 transactions: 14 successes and one intentional revert**. The successful swap returned **0.000201760068347711 WETH** for 0.5 USDC.

The final state is docked, both Aqua token balances zero with `tokensCount=255`, all four Maker→Aqua / taker→router allowances zero, and Maker `activeStrategyHash=0`. No LP watcher remains running. See [independent verification](independent-verification.json) for all receipts, historical reports, wallet deltas and final state.

## Recovery exercised

The first ship request successfully mined two approvals and ship, then stopped at its post-ship risk check because the default Chainlink USDC/USD observation was older than this demo's 3,600-second limit. [Initial failure](ship.log). The session remained recoverable and had no enabled Guard report.

We kept the request, hash, original HODL baseline and freshness policy unchanged. A [separate USD book provider](../../../contracts/aqua-executor/src/kraken-risk-prices.ts) fetched ETH/USD and **USDC/USD independently**, preserving actual level timestamps and the observed USDC price instead of assuming a one-dollar peg. The exact ship request was resumed with that public price snapshot; [ship-resumed.log](ship-resumed.log) contains the original three transaction hashes, with no repeated asset operation.

The intentionally rejected swap persists its signed transaction in the existing private journal before broadcasting and verifies `DirectionDisabled` before submission. [Its replay after final cleanup](rejection-replayed.log) reused the same mined hash and verified historical block balances; it did not re-approve or send another swap. Signed bytes are not included here.

## Verification and source scope

- Main workflow: **50 tests / 265 assertions** and typecheck passed.
- Shared delivery package: **11 tests / 78 assertions** and typechecks passed.
- New USD risk provider: **2 tests**, plus executor typecheck passed.
- Actual CRE dry-run and four simulation broadcasts completed. CLI logs retain WASM binary and public config hashes; the full public report is recovered from Guard at each transaction's block.
- The transaction RPC was PublicNode. The independent verifier uses Tenderly, checks receiver events/digests/nonces, active-strategy transitions, successful swap deltas, unchanged balances across the rejection block, and final allowances/inventory.
- The public verifier serializes reads to respect endpoint limits. Its first attempt hit HTTP 429 near the end; no transaction was involved in that verification retry.
- Final source SHA256 values identify the final checked worktree. They are separate from the per-run WASM hashes and are not an enclave attestation. The root workflow SDK was aligned from 1.18.0 to the delivery package's 1.20.1 so both share the same report/runtime types.

Local checks:

```bash
# From workflow/
bun run test
bun run typecheck
node scripts/verify-live-guard.mjs

# From contracts/aqua-executor/
node --test test/kraken-risk-prices.test.ts
pnpm run typecheck
```

The [public plan](plan.json) records the executed strategy and requests' context. It is historical: do not try to ship its docked hash again. For a newly authorized run, `scripts/cre-live-plan.ts` creates a fresh plan; fetch `scripts/cre-risk-prices.ts` before executing its ship request with `--prices`. `workflow/scripts/simulate-public-demo.mjs` supports `both`, `buy-only` and `paused`, requires an explicit public config, and adds `--broadcast` only when requested. Existing signing material is supplied opaquely by the parent process, never copied into config or evidence. The executor's dock revokes Maker allowances; `scripts/cre-live-close.ts` also clears remaining taker allowances.

## Still outside this evidence

The six frontend templates are not all operational. This run does not prove Provider publication/versioning, confidential input onboarding, the direct HTTP runner, frontend readiness state, range rollover with a replacement hash, multi-strategy A/B switching, guarded fees, Pegged/Decay/Inventory/Shared-capital completion, revenue sharing, or real DON/TEE execution. See [the frontend completion handoff](../../../docs/FRONTEND-LP-COMPLETION.md).
