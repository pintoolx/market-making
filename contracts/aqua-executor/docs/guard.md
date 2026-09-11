# Aqua Guard v1 prototype

This implements the [report-v1 proposal in PR #3](https://github.com/pintoolx/market-making/pull/3) as a reviewable contracts prototype. The interface still needs agreement with the workflow owner. Reports in the included demo are synthetic and delivered through **our `GuardTestForwarder` harness**. They are not a CRE workflow simulation, DON signature verification or TEE attestation.

## Implemented behavior

The [Base Sepolia demo](guard-sepolia-demo.md) completed three real token swaps and one intentionally Guard-reverted transaction, followed by docking and allowance cleanup. Its evidence and synthetic-report limitations are recorded separately from the local tests.

`contracts/AquaGuard.sol` receives the proposed 16-field / 512-byte ABI tuple through `onReport`. The immutable configuration binds a forwarder and an AquaSwapVMRouter. In the production-identity profile it additionally requires the configured workflow ID and owner in the forwarder's 64-byte packed metadata. Both values are mandatory; the workflow name is not used as an identity boundary. This profile is tested with fabricated metadata locally, not a live production forwarder.

The separate simulation profile accepts reports only from its configured forwarder, skips workflow-identity checks, and can be deployed only on chain 31337 or 84532. It requires zero workflow ID / owner to prevent misleading configuration. Neither profile has an owner method to disable checks or replace the forwarder. Moving from a test harness to a real forwarder requires a new Guard deployment and a new Maker-approved order.

Reports bind chain, Guard, router, Maker, complete strategy hash and ordered token pair. They must be current, last at most 600 seconds and use an increasing positive nonce per `(maker, strategyHash)`. An identical current retry is a no-op; replay, nonce collision, bad domain, malformed ABI and expired reports revert without replacing accepted state. A directions value of zero pauses trading.

The Guard's read-only Extruction implementation checks every invocation against the stored report and the Maker-approved envelope. Directions are named from the **taker**: `1 = token0 in / token1 out`, `2 = token1 in / token0 out`, `3 = both`. Each token has a per-swap amount cap and a post-swap inventory cap; effective limits are the smaller of report and envelope limits. Equality passes. There is no cumulative budget counter, USD valuation, percentage-exposure guarantee or maximum-loss guarantee.

Quotes and swaps return unchanged VM registers and consume no quota or taker arguments. Missing / stale reports, a disabled direction, an incorrect pair, exact-output mode, nonzero protocol-fee pull or an exceeded bound revert. The initial compiler uses standard mock ERC20s and a fixed zero-fee XYC program. Fee-on-transfer, rebasing assets, callbacks and arbitrary program composition are outside this prototype.

## Compiler and integration API

`src/guard.ts` exports:

- `guardReportAbi`, `GuardReport` and `encodeGuardReport()` for workflow ABI encoding. Integer timestamps use seconds; monetary quantities are atomic-token `bigint` values. `test/fixtures/guard-report-v1.json` preserves the shared synthetic fixture.
- `compileGuarded(params, guard, caps)` for the full Maker-approved order. It requires zero fee and appends exactly one terminal Guard call. Changing the target or any envelope cap changes the strategy hash.
- `buildGuardReportTx()` for unsigned receiver calldata, to be delivered through the configured forwarder. It does not authorize an EOA to call `onReport`.
- `buildTestReportTx()` and `GuardTestForwarder` for the project-owned test harness only. The harness permits its deployment owner to supply arbitrary report bytes and metadata; it has no Chainlink signature checks.

The existing SDK 0.4.4 Aqua builder has no Extruction method. The compiler appends opcode **32** and the 125-byte argument payload explicitly, targeting the pinned v1.0.2 **AquaOpcodes** table. The envelope is version `uint8`, two addresses and four big-endian `uint128` caps (105 bytes), preceded by the 20-byte Guard target. Golden bytes and actual swaps against the pinned router test that encoding.

The input-fee instruction temporarily exposes net input to later VM instructions. This prototype omits that instruction entirely so the Guard sees actual gross transfer amounts. Nonzero `feeBps` is rejected. Fee-bearing templates need their own accounting and rounding tests.

`GuardedCompiled.params` carries `executionTemplate: "guarded-xyc-v1"`, which both the legacy JSON parser and compiler reject. The old JSON controller and journal reconstruction do not yet support guarded strategies. Use the complete `GuardedCompiled` result with the low-level transaction builders; do not strip the template marker. Construct new guarded orders from the original base parameters plus explicit target / caps. Guard-aware durable request support is subsequent integration work.

## Build and test

From the repository root, install with `pnpm install --frozen-lockfile`. Then:

```bash
cd contracts/aqua-executor
SOLC=/path/to/solc-0.8.30 pnpm build:guard
SOLC=/path/to/solc-0.8.30 pnpm build:guard --check
pnpm typecheck
ANVIL=/path/to/anvil pnpm test
```

The Guard build uses solc `0.8.30+commit.73712a01`, optimizer 200 runs, via IR, Prague EVM. It does not rebuild or modify the pinned official Aqua / router artifacts. The two new artifacts contain compiler settings and source hashes. `contracts/vendor/SwapVMInterfaces.sol` contains interface-only excerpts from SwapVM commit `32c687c2b73101fc26549e48fa1ff8a4d73afbac`; its upstream license is retained alongside it.

Tests cover the shared ABI fixture, the complete program encoding, identity / domain / replay checks, actual swaps in both directions, a mined Guard-reverted transaction with unchanged balances, report changes between quote and swap, exact limits and one-unit excess, envelope clamping, isolated Maker/hash keys, malformed arguments, paused / expired reports and demo cleanup. Earlier lifecycle, loss-monitor and recovery tests remain part of the suite.

## Repeat the demo

Use isolated local or Base Sepolia test accounts with zero initial Aqua / router allowances. The existing deployment is read from `deployments/<chainId>.json`; do not redeploy Aqua to run the Base Sepolia example.

```bash
# With the package's .env configured for the existing test accounts:
pnpm demo:guard --network base-sepolia

# Local: first deploy Aqua / router / mock tokens to your running Anvil.
pnpm run deploy --network local
pnpm demo:guard --network local
```

The script deploys only a new test forwarder and Guard, ships a zero-fee order, submits synthetic reports, completes swaps in both directions, disables token1-in and intentionally broadcasts one swap that reverts with `DirectionDisabled`. Token wallet and Aqua balances are compared around that rejection. Token0-in still succeeds; then a pause report is published, the strategy is docked, and both Maker and taker demo allowances are revoked.

JSONL records and a summary are written under `records/<chainId>/guard-demo-*`. The report records include the payload, digest and decoded acceptance event; failed-swap evidence includes the actual receipt and unchanged balances. Local-chain records stay ignored. The script is a demonstration, not a resumable controller: on interruption, inspect the recorded hashes and active strategy before manual recovery. Do not blindly rerun it or start it alongside another controller using the same accounts.

CRE CLI delivery, the actual confidential workflow, frontend Maker activation, guarded JSON recovery and Provider settlement remain to be connected. The Guard prototype is not a production deployment or security audit.

Transport reference: [Chainlink consumer-contract guide](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts). Router references and the proposed payload semantics are linked in [PR #3](https://github.com/pintoolx/market-making/pull/3).
