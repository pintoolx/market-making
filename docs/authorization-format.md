# Authorization format — workflow-side proposal (draft for the contracts owner)

Status: **proposal, not yet agreed.** Written by the workflow owner on 2026-09-12 to
align with the contracts owner (pengu). It adopts
[`GUARD-REPORT-V1.md`](GUARD-REPORT-V1.md) **field for field, with no renames**, and
records how the enclave derives every value, what was deliberately *not* added, how the
report is delivered, and the questions that still need an answer. Where this document and
`GUARD-REPORT-V1.md` disagree, the disagreement is listed in §8 rather than silently resolved.

Implementation: [`workflow/src/types.ts`](../workflow/src/types.ts) (schemas),
[`workflow/src/intersect.ts`](../workflow/src/intersect.ts) (derivation),
[`workflow/src/encode.ts`](../workflow/src/encode.ts) (ABI), [`workflow/src/publish.ts`](../workflow/src/publish.ts) (delivery seam).

## 1. Where the authorization sits

```
Provider strategy (secret JSON) ─┐
                                 ├─► TEE handler ──► GuardReportV1 ──► DON signs ──► Keystone forwarder
Maker limits (secret JSON) ──────┘   (cron, Nitro)    (512-byte ABI)                  │
Market snapshot (public) ────────┘                                                    ▼
                                                                 AquaGuard.onReport(metadata, report)
                                                                                      │ stores bounds
                                                                                      ▼
                                   1inch Aqua swap ──► SwapVM Extruction ──► AquaGuard.extruction() ──► pass / revert
```

Only the report crosses the enclave boundary. The matched rule, the thresholds, the Maker's
budget and share, and which side "won" each cap stay inside the TEE.

## 2. Field table (`GuardReportV1`, 16 fields, `abi.encode` tuple = 512 bytes)

| # | Field | Solidity | Unit / range | Set by | Why it is needed |
|---|---|---|---|---|---|
| 1 | `schemaVersion` | `uint16` | always `1` | workflow constant | Lets the Guard reject a payload from an older/newer encoder instead of mis-decoding it. |
| 2 | `chainId` | `uint256` | `84532` (Base Sepolia) | `config/guard.ts` | Prevents replaying a Base Sepolia report on another chain where the same Guard bytecode may exist. |
| 3 | `guard` | `address` | 20 bytes | `config/guard.ts` | Binds the report to one receiver so a report signed for Guard A cannot be replayed into Guard B. |
| 4 | `router` | `address` | 20 bytes | `config/guard.ts` | The Guard only accepts `extruction()` calls from this router; the report must name the same one. |
| 5 | `maker` | `address` | 20 bytes | `config.staging.json` | Storage key #1 — the Guard keys state by `(maker, strategyHash)`; funds never leave this wallet. |
| 6 | `strategyHash` | `bytes32` | `router.hash(order)` | `config.staging.json` (TODO pengu) | Storage key #2 — ties the authorization to one Maker-approved guarded program. |
| 7 | `token0` | `address` | 20 bytes | `config/guard.ts` | With `token1`, lets the Guard reject a swap on the wrong pair; order = the approved program's order, never sorted. |
| 8 | `token1` | `address` | 20 bytes | `config/guard.ts` | See `token0`. |
| 9 | `nonce` | `uint64` | `> 0`, strictly increasing per `(maker, strategyHash)` | TEE (unix seconds, see §5) | Ordering + replay protection: older or reused nonces revert; a byte-identical retry is a no-op. |
| 10 | `validAfter` | `uint48` | unix seconds | TEE (`runtime.now()`) | Start of the window; the Guard requires `validAfter <= block.timestamp`. |
| 11 | `validUntil` | `uint48` | `validAfter < validUntil <= validAfter + 600` | TEE | Expiry; the Guard rejects swaps after it. Also the main leakage limiter (§7). |
| 12 | `allowedDirections` | `uint8` | `0..3` bitmask, taker perspective | TEE (§4) | `1` = taker 0→1 (Maker buys token0), `2` = taker 1→0 (Maker sells token0), `3` both, `0` paused. One byte says which side of the book is open. |
| 13 | `maxAmount0PerSwap` | `uint128` | atomic token0 | TEE = `min(provider, maker)` | Per-fill ceiling on token0 exchanged; applies to both directions; must be `> 0` if any direction is enabled. |
| 14 | `maxAmount1PerSwap` | `uint128` | atomic token1 | TEE = `min(provider, maker)` | Same for token1. |
| 15 | `maxPostBalance0` | `uint128` | atomic token0 | TEE (§4) | Absolute inventory ceiling *after* the swap — the Maker's "max share in token0" translated at the current price. |
| 16 | `maxPostBalance1` | `uint128` | atomic token1 | TEE (§4) | Absolute inventory ceiling for token1 — the Maker's budget intersected with the Provider's ceiling. |

Integers in JSON fixtures and logs are decimal strings; addresses are plain EVM hex.

## 3. Confidential inputs (what the TEE reads, never publishes)

Two secrets, one JSON document each (`secrets.yaml`: `PROVIDER_STRATEGY`, `MAKER_LIMITS`),
fetched with a single `runtime.getSecrets([...])` call. Quotas that shaped this: 2 KB per
secret, 27 KB per workflow, 5 secret calls per execution.

**Provider strategy** — an ordered rule list; the first rule whose `when` matches the market
snapshot wins, none matching = paused.

| Key | Meaning |
|---|---|
| `rules[].when.{priceMin,priceMax,volatilityBpsMin,volatilityBpsMax}` | Market regime the rule applies to (inclusive bounds, any subset). |
| `rules[].allowMakerBuyToken0` / `allowMakerSellToken0` | Which sides of the book the Provider opens in that regime. |
| `rules[].maxAmount0PerSwap` / `maxAmount1PerSwap` | Provider's per-fill ceilings (atomic). |
| `rules[].ttlSec` | How long a report issued under this rule should live (≤ 600). |
| `inventory.maxBalance0` / `maxBalance1` | Provider's own inventory ceilings. |

**Maker limits** — stated in the Maker's terms, translated by the enclave.

| Key | Meaning |
|---|---|
| `maxBudget1` | Max capital deployed, in token1 atomic (e.g. 10 000 USDC). |
| `maxToken0ShareBps` | Max share of that budget that may sit in token0 (6000 = 60 %). |
| `maxAmount0PerSwap` / `maxAmount1PerSwap` | Per-fill ceilings the Maker tolerates. |
| `maxTtlSec` | Maker's upper bound on report lifetime. |

**Market snapshot** (public, currently from `config.staging.json`; TODO: fetch inside the
enclave with `HTTPClient`): `midPrice` (token1 per token0), `volatilityBps`, the Maker's
`balance0` / `balance1`, and the two token decimals.

## 4. Derivation rules (the "intersection")

| Output | Rule |
|---|---|
| matched rule | first `rules[i]` whose every stated `when` bound holds; `null` → paused. |
| `maxAmount0PerSwap` | `min(rule.maxAmount0PerSwap, maker.maxAmount0PerSwap)` |
| `maxAmount1PerSwap` | `min(rule.maxAmount1PerSwap, maker.maxAmount1PerSwap)` |
| `maxPostBalance1` | `min(provider.inventory.maxBalance1, maker.maxBudget1)` |
| `maxPostBalance0` | `min(provider.inventory.maxBalance0, makerCeiling0)` where `makerCeiling0 = maxBudget1 × share / 10 000` converted to token0 at `midPrice` |
| direction bit 1 (Maker buys token0) | `rule.allowMakerBuyToken0 && balance0 < maxPostBalance0` |
| direction bit 2 (Maker sells token0) | `rule.allowMakerSellToken0 && balance1 < maxPostBalance1` |
| paused (`allowedDirections = 0`) | no rule matched · rule opens neither side · either per-swap cap is 0 · both inventories already at/over cap. **Paused reports carry all-zero caps** (allowed by the Guard, reveals nothing extra). |
| `validAfter` | `runtime.now()` in seconds (DON time, never `Date.now()`). |
| `validUntil` | `validAfter + min(rule.ttlSec, maker.maxTtlSec, 600)` |
| `nonce` | `validAfter` (see §5) |

Edge cases covered by unit tests (`workflow/src/intersect.test.ts`): both sides
incompatible → everything forbidden; inventory exhausted on one or both sides; Maker
stricter than Provider on every axis; rule ordering; expiry never exceeding 600 s.

## 5. Nonce and expiry semantics

- **Nonce = unix seconds of `validAfter`.** The enclave has no persistent state and cannot
  read the chain, so a timestamp is the only monotonic source available without a round
  trip. It is strictly increasing as long as two runs are ≥ 1 s apart (cron is every 2 min).
  Fits `uint64` trivially. A byte-identical re-issue within the same second is a no-op on the
  Guard, which is the documented behaviour.
- **Lifetime** is the shortest of the three bounds; the Guard's `MAX_REPORT_LIFETIME = 600`
  is never exceeded. A paused report still gets a window so the Guard keeps rejecting until
  the next report; once it expires the Guard rejects anyway (missing/expired report ⇒ revert).

## 6. ABI encoding and delivery

- **Encoding:** `abi.encode(GuardReportV1)` — plain tuple, not packed, exactly 512 bytes.
  `workflow/src/encode.ts` mirrors `docs/guard-report-v1/abi.json` and is golden-tested
  byte-for-byte (and by `keccak256` hash) against `docs/guard-report-v1/example.json`, the
  same fixture the Solidity side decodes. If either side changes a field, that test fails.
- **Setter:** the Guard already implements CRE's receiver interface
  `onReport(bytes metadata, bytes report)` (`AquaGuard.sol:96`). No new setter is proposed.
- **Delivery path (recommended, "option B"):** inside the TEE handler call
  `runtime.usingTheDons()` → `donRuntime.report({ encodedPayload, encoderName:'evm',
  signingAlgo:'ecdsa', hashingAlgo:'keccak256' })` → `new EVMClient(selector).writeReport(donRuntime,
  { receiver: guard, report, gasConfig })`. The DON signs; the Keystone forwarder calls
  `onReport`; the Guard checks `msg.sender == forwarder` (+ workflow identity in production
  mode). This is exactly the trust model `AquaGuard.sol` already encodes.
  Fact that forces this: in SDK 1.18.0 every `EVMClient` method accepts only a DON
  `Runtime`; there is no `TeeRuntime` overload, so the enclave cannot write on-chain directly.
- **Fallback ("option A"):** `HTTPClient.sendRequest` *does* accept a `TeeRuntime`, so the
  enclave could sign a raw transaction with a secret key and POST `eth_sendRawTransaction`.
  That would require a Guard that trusts a plain EOA instead of the forwarder — a different
  contract. Kept only as a documented stub in `publish.ts`.
- **Forwarder addresses (Base Sepolia, from the Chainlink CRE docs):** simulation Mock
  Forwarder `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`. The prototype Guard
  `0x41fde9f1f257fc65a40eb519d22ca9bfb1d2dbeb` was deployed with the project's own
  `GuardTestForwarder`, so a CRE-delivered report will currently be rejected.

## 7. Known information-leakage surface (answer for judges)

Each report publishes `min(provider, maker)` for four caps plus a window length. An
observer collecting many reports can infer the *stricter* side's numbers and the regime
switches. Mitigations already in place: paused reports zero every cap; the matched rule, the
thresholds, the budget/share and the "who bound" attribution never leave the enclave; short
`validUntil` limits how long any one number is useful. Options if we want more: coarsen caps
to a grid, or add bounded noise below the true cap (always safe for the Maker). The
`scripts/check-no-leak.sh` scan prints exactly which secret values surface, and fails on any
other.

## 8. Fields considered and deliberately not added

| Candidate | Decision | Reason |
|---|---|---|
| price bounds (`minPrice`/`maxPrice`) | not added | The Guard sees `amountIn`/`amountOut`, so it *could* enforce an effective price, but the Aqua strategy program already prices the fill; adding a second price check risks double-reverting quotes. Price thresholds are instead used *inside* the TEE to pick the regime. Open to adding if pengu wants the Guard to enforce a band (§9 Q5). |
| remaining cumulative budget | not added | `GUARD-REPORT-V1.md` explicitly rejects cumulative counters without quote/swap consistency tests; the absolute `maxPostBalance*` caps give the same protection statelessly. |
| matched rule id / reason | never on-chain | Would leak the strategy shape. Kept in an enclave-only `DecisionTrace`. |
| per-direction caps | not added | Both amount caps apply to both directions in v1; splitting them doubles the payload for little gain. |

## 9. Questions for pengu

1. **Delivery:** confirm option B (forwarder → `onReport`) is what you want the workflow to
   target, so option A stays a stub.
2. **Guard deployment for simulation:** will you redeploy the simulation-profile Guard with
   `forwarder = 0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` (CRE mock forwarder, Base
   Sepolia) so `cre workflow simulate --broadcast` can change Guard state? Give me the new
   address → `workflow/src/config/guard.ts`.
3. **Production identity:** for the non-simulation profile the Guard's immutable
   `workflowId` / `workflowOwner` must match the registered workflow. Do you want the
   workflow ID before deploying, or a Guard with a settable identity for the demo?
4. **`strategyHash`:** send the `router.hash(order)` of the guarded program plus the Maker
   address for the demo → `workflow/market-maker-auth/config.staging.json`.
5. **Price band in the report?** See §8 row 1. If yes, propose the unit (token1 per token0,
   scale) and I add two `uint128` fields + tests + a new fixture.
6. **Gas limit** for `onReport` on Base Sepolia (currently a placeholder `500000`).
7. **Metadata in simulation:** confirm the Guard's simulation profile skips the 64-byte
   workflow-identity check (docs say only the forwarder address is checked).

## 10. What changes when the answers arrive

| Answer | File(s) touched |
|---|---|
| Q1, Q2, Q3, Q6 | `workflow/src/config/guard.ts` constants; flip `publishMode` to `don-report` in `config.staging.json`. |
| Q4 | `workflow/market-maker-auth/config.staging.json` (`maker`, `strategyHash`). |
| Q5 | `workflow/src/types.ts`, `intersect.ts`, `encode.ts`, tests, `docs/guard-report-v1/*` — plus the Solidity struct. |
| Q7 | none on the workflow side. |

Nothing else in `workflow/` depends on these answers.
