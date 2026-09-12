# GuardReportV1 specification


**Status: implemented.** The workflow encoder and `AquaGuardV2` share a golden 512-byte fixture. Ethereum Sepolia and local integration records verify the receiver and SwapVM enforcement path; production CRE delivery requires a receiver deployed with the final workflow identity.

The confidential workflow produces public execution bounds from private inputs. The Guard receives those bounds through CRE and checks them during each SwapVM invocation. The Maker first approves a fixed strategy program and its public enforcement envelope, then ships that program from their wallet. New reports may vary execution within that envelope without authorizing a new program or another wallet transaction.

Public bounds, envelopes and trades may reveal information about the original inputs when observed over time. Expiry only limits future use of that authorization; it does not remove history or guarantee resistance to inference.

## Scope

The first supported integration uses Ethereum Sepolia, canonical WETH and Circle testnet USDC, the pinned AquaSwapVMRouter v1.0.2, exact-input swaps and zero protocol fees. Direction flags use the taker perspective. Limits apply per swap together with absolute post-swap inventory caps. Schema 1 reports live for at most 600 seconds. Schema 2 reports are standing authorizations with `validUntil = 0`; both versions use strictly increasing nonces.

`AquaGuardV2` stores reports by `(maker, strategyHash)` and maintains one active strategy hash per Maker. Accepting an enabled report for another strategy atomically switches the active strategy. A paused report clears the active hash only when it targets the currently active strategy.

These choices do not define a percentage exposure rule or a guaranteed maximum loss. A workflow may derive conservative atomic-token caps from a private percentage rule, but that rule's ongoing valuation guarantee would need a separately specified on-chain valuation model. The imported off-chain HODL loss monitor remains a separate reaction mechanism.

## Standing authorization (schema 2)

The updated `AquaGuardV2` accepts the same 512-byte tuple with `schemaVersion = 2` and `validUntil = 0`. Other schema-2 deadlines are rejected. The valid-after check, replay protection, active-profile gate, per-swap limits and inventory envelope still apply. Schema 1 retains its bounded lifetime for compatibility.

Standing authorization remains usable until replaced, paused, revoked by the Maker, or made unavailable by docking the Aqua strategy. If the workflow is unavailable, the last authorization remains effective; market freshness is not an on-chain guarantee. `setStrategyRevoked(hash, true)` is scoped to the caller's Maker account and prevents subsequent enabled reports for that hash. Clearing revocation does not reactivate an old report: a fresh report is required.

`latestReportBlock(maker, hash)` identifies the accepted report's block so clients can recover its original receipt without publishing a renewal. It changes only when a new report is accepted. Consumers must verify the receipt, digest and current Guard state before reusing evidence.

Existing deployed receivers do not gain these features through a source update. Deploy a new receiver and rebuild/re-ship its bound strategy programs before sending schema-2 reports.

## Evaluation and publication

Maker envelope schema 3 explicitly requests `authorization: "until-changed"` and omits the legacy TTL. Existing Maker schemas 1 and 2 retain their bounded consent; they are not silently extended. Standing evaluations continue to intersect both parties' trading and inventory limits. Provider rule TTLs apply only to bounded authorizations.

For standing reports, CRE reads the stored report and active strategy before delivery. Equal effective terms reuse the existing authorization without signing or writing another report. A changed direction, cap or active profile requires a new report; changed nonce/time alone does not. Reactivating an inactive profile also requires a new report, even when its stored caps match. The publisher advances the nonce against stored state before writing.

The local simulation adapter recognizes a public unchanged result. The mandate service then retrieves the original acceptance block and checks its event against current Guard state and the digest returned by CRE. The activity entry says the conditions were unchanged and links the original transaction. Refreshing status remains read-only. Readiness snapshots still expire quickly because wallet balances, allowances and Aqua availability can change independently of standing authorization.

## Two interfaces with different purposes

| Interface | Purpose |
|---|---|
| Local executor `aqua-execution-v1` JSON | Commands a signer to approve, ship, swap, rebalance, monitor or dock; local idempotency and recovery |
| `onReport(bytes metadata, bytes report)` | Receives authenticated workflow output and updates public Guard bounds; does not sign, ship, transfer funds or reset the HODL benchmark |

The application envelope described by the [current architecture](ARCHITECTURE.md) may retain request IDs and commitments offchain. It is not the Solidity ABI below. The workflow and application must record the association between a request, the exact Guard report bytes and the confirmed delivery receipt. A `producer: "tee"` label or a local JSON schema check provides no report authentication.

## ABI payload

`report` is standard **`abi.encode(GuardReportV1)`**, not JSON and not packed encoding. Every field occupies one 32-byte ABI word: this tuple is exactly **512 bytes**. [`guard-report-v1/abi.json`](guard-report-v1/abi.json) is the machine-readable ABI-parameter array; [`guard-report-v1/example.json`](guard-report-v1/example.json) includes one synthetic input and its exact encoding.

```solidity
struct GuardReportV1 {
    uint16 schemaVersion;         // 1
    uint256 chainId;
    address guard;
    address router;
    address maker;
    bytes32 strategyHash;         // router.hash(order), after the complete program is built
    address token0;
    address token1;
    uint64 nonce;
    uint48 validAfter;
    uint48 validUntil;
    uint8 allowedDirections;      // 0=paused, 1=0→1, 2=1→0, 3=both (taker perspective)
    uint128 maxAmount0PerSwap;
    uint128 maxAmount1PerSwap;
    uint128 maxPostBalance0;
    uint128 maxPostBalance1;
}
```

Addresses use ordinary EVM address encoding; times are Unix seconds. Token amounts are atomic integers, independent of token decimals. JSON fixtures use decimal strings for every integer. `token0` / `token1` retain the Maker-approved program's order; do not silently sort by address. No USD price, private strategy logic, original budget, private risk policy or private rejection reason belongs in this payload or its events.

The order hash already binds the Maker, traits and complete program including Guard address and envelope arguments. Compute it **after** building the program, then put it into the report. Do not put the order's own hash into its program arguments, which would create a circular dependency. Chain ID, Guard and router provide an explicit domain because the order hash alone is not a cross-chain boundary.

## Receiving a report

1. Validate the caller using the configured forwarder and production workflow identity before accepting the payload. Implement CRE's receiver / ERC165 interface. Bind the receiver deployment to one router and a concrete workflow identity; never select trusted identity from the report itself.
2. Require canonical v1 encoding, the expected version, `chainId == block.chainid`, `guard == address(this)`, the configured router, nonzero Maker / tokens / strategy hash, distinct tokens and `allowedDirections <= 3`. Require positive caps for an enabled direction. Paused reports may set all caps to zero.
3. Require `validAfter <= now < validUntil` and `validUntil - validAfter <= 600`. Future reports are not queued. Invalid reports must leave the last accepted state unchanged.
4. Key stored state by `(maker, strategyHash)`. Accept a nonce greater than the last accepted nonce (first nonce must be positive). An exact byte-for-byte retry of the current report is a no-op and emits no second acceptance event. Reusing the nonce with different bytes, or delivering an older nonce, reverts. Even an identical retry must pass the current expiry checks; it never extends validity.
5. Store the bounds and payload digest, then emit an acceptance event with Maker, strategy hash, nonce, digest and expiry. A `directions = 0` report actively pauses that strategy. Failure to approve a new application proposal is different from sending a pause for an existing strategy.

The report alone cannot authorize spending. An unshipped hash may receive a report but cannot trade until its Maker activates the matching order. The Guard validates the stored token pair against the program envelope at invocation. Raising an absolute bound above the Maker-approved envelope must not weaken the effective limit: apply `min(reportBound, envelopeBound)` for each cap.

CRE forwards workflow identity in `metadata`, separately from the application ABI. The current production format contains the workflow ID, name, owner and report ID; use the documented decoder rather than `abi.decode` as a standard tuple or an assumed 62-byte equality check. Simulation currently omits workflow identity, so it needs a separately labelled mock-forwarder configuration. Mock delivery proves a state transition, not production TEE authentication. These transport requirements follow the [Chainlink consumer-contract guide](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts).

## Checking a swap

The Guard implements the pinned `extruction(bool,uint256,SwapQuery,SwapRegisters,bytes,bytes)` interface. It must accept calls only from the configured AquaSwapVMRouter. Quote and swap use the same read-only validation and return the unchanged `nextPC`, `choppedLength = 0`, and unchanged registers. No quota is consumed by a quote.

The program has one terminal Guard call on every supported path. The initial template has no jumps, custom balance changes, token hooks, protocol fees, other external calls or fee-on-transfer / rebasing assets. The compiler and golden-byte tests must prove those constraints for the complete Maker-approved program; the Guard cannot prove them from an arbitrary caller-supplied label. Direct calls to the Guard do not establish that a real swap occurred.

At invocation, require a present, fresh report for `query.maker` and `query.orderHash`, the matching token pair, exact-input mode and an allowed direction. Let `a0` / `a1` be the actual amount of token0 / token1 exchanged. Apply both token amount caps, including the token paid out by the Maker. With zero fees and standard ERC20s:

| Taker direction | Post-swap token0 balance | Post-swap token1 balance |
|---|---|---|
| 0 → 1 | `balanceIn + amountIn` | `balanceOut - amountOut` |
| 1 → 0 | `balanceOut - amountOut` | `balanceIn + amountIn` |

Require each post-swap balance at or below `min(report cap, envelope cap)`. Equality passes; any excess reverts. Reject underflow, unsupported direction / pair and missing or expired reports. An already excessive inventory may only trade when its resulting inventory satisfies both caps in this first version; do not silently introduce an exception for a purportedly risk-reducing trade.

Per-swap caps are **not** remaining cumulative budgets. Splitting an order into several swaps can use the per-swap amount allowance repeatedly; the absolute inventory bound still applies after each one. If the workflow needs a cumulative counter, add explicit semantics and quote / swap consistency tests before changing this interface.

### Fee and encoding constraints

The existing imported demo uses a 30 bps input-fee instruction. That instruction temporarily reduces `amountIn` while executing its remaining program and restores the gross input afterward. A Guard simply appended after the curve would therefore observe a net input and could undercount the Maker's incoming inventory. The first Guard template uses **zero fee** until gross-amount accounting and rounding have separate tests. Do not append the new Guard to the existing fee-bearing bytecode and assume these formulas remain correct.

For the public envelope, packed custom arguments are: version `uint8`, token0 `address`, token1 `address`, then the four `uint128` amount / post-balance caps in the same order as the report. This is 105 bytes, plus the 20-byte Guard target = 125 bytes, within the VM's one-byte instruction-argument length. Reports use the 512-byte ABI tuple; **do not put that whole tuple in an Extruction instruction**. Maker approval binds this public envelope, not a plaintext copy of the original private policy.

An intervening report update may invalidate a prior quote. That swap should revert, and the taker must re-quote with its ordinary slippage / deadline protection. Missing data must never be treated as an unlimited report.

These observations were checked against the pinned SwapVM commit `32c687c2b73101fc26549e48fa1ff8a4d73afbac`: [Extruction](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/Extruction.sol), [VM registers / instruction encoding](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/libs/VM.sol), [input fee](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/Fee.sol), and [Aqua opcode table](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/opcodes/AquaOpcodes.sol). Use `AquaOpcodes`, not the general router's `Opcodes` table.

## Verification requirements

- Solidity decoding and workflow encoding match the shared fixture, and malformed or trailing data is rejected.
- An authorized fresh report changes Guard state. Wrong caller / identity / chain / Guard / router, bad token pair, nonce reuse with changed payload, older nonce, missing report and expiry all fail without changing valid state.
- Maker approval binds the complete zero-fee guarded program and envelope. Tests reject unsupported fee-bearing templates; no execution path skips the Guard.
- Real swaps in both directions transfer tokens. Exact cap equality succeeds; a one-unit amount or resulting inventory excess reverts. Report loosening cannot exceed the envelope.
- A synthetic depeg-style report disables one direction: the forbidden swap reverts with balances unchanged while the permitted direction still succeeds. Pausing / expiry rejects both directions. Synthetic inputs are labelled in evidence.
- Quotes do not mutate state. A report update between quote and swap is handled as a possible revert. Repeated report delivery and simulated failures do not revive an older report.
- Publish deployment addresses, report delivery receipts, a successful transfer receipt and an actual Guard-reverted transaction receipt. Local tests and simulated delivery are labelled separately from production confidential execution.
