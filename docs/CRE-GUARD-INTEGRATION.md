# CRE → Guard: delivery decision and verification boundary

Updated 2026-09-12. The project owner selected **B: public derived report → DON → forwarder → Guard**, retaining the tested Base Sepolia router and Guard ABI. This selects the transport direction; the workflow owner still needs to agree the product report semantics.

## What is implemented

[`workflow/guard-report`](../workflow/guard-report/) contains a public report delivery workflow, a `TeeRuntime.usingTheDons()` integration hook, SDK tests and an unsigned Guard deployment / configuration tool. It uses the existing 16-field, 512-byte [v1 report](GUARD-REPORT-V1.md). It does not yet evaluate Provider secrets, register a confidential handler or implement the two-strategy mandate.

| Evidence | Status | What it establishes |
|---|---|---|
| Existing Base Sepolia Guard demo | Complete; [receipts and checks](../contracts/aqua-executor/docs/guard-sepolia-demo.md) | Actual token transfers and a Guard-reverted swap with unchanged balances, delivered through our own test harness |
| CRE adapter tests | Local SDK mocks | Payload encoding, identity preflight, receipt checks, readback and public-output validation |
| Workflow compilation | Local SDK / Javy WASM build | The public entry point compiles; no execution or attestation claim |
| CRE CLI simulation / broadcast | Pending account authentication | No new Chainlink delivery receipt exists yet |
| Production DON delivery | Pending deployment access and assigned identity | No production workflow ID / owner has been provisioned |
| Confidential workflow execution | Pending access and evaluator integration | No real TEE execution or attestation evidence exists yet |

The owner confirmed that neither a CRE account nor Confidential Workflows access is currently available. CLI v1.33.0 `cre whoami --non-interactive` exits 1 with `authentication required: no credentials found`. Build and SDK mocks work without that login. We did not bypass authentication, broadcast a new transaction or redeploy contracts in this increment. Once an account exists, follow the [delivery runbook](../workflow/guard-report/README.md).

## Why B

The SDK exposes `usingTheDons()` for capabilities requiring DON consensus. A confidential evaluator can explicitly pass only its public output to that runtime; those values leave the enclave. See the [Confidential Workflows SDK reference](https://docs.chain.link/cre/reference/sdk/confidential-workflows-client-ts).

In production, the **forwarder verifies the DON signatures**. `AquaGuard` authenticates the configured forwarder and workflow ID / owner from metadata, then validates the report domain, nonce, expiry and bounds. The Guard is not a separate DON signature verifier. See the [consumer contract guide](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts).

A self-signed JSON-RPC transaction from an enclave remains a deferred alternative. It would need a separate authenticated sender path plus key, gas, nonce and retry handling. The current Guard has no EOA setter and no switch to disable forwarder validation. Missing CRE access is not resolved by changing the delivery transport.

The CLI simulator is a distinct environment: its own source says it is **not a real TEE** ([v1.33.0 implementation](https://github.com/smartcontractkit/cre-cli/blob/v1.33.0/cmd/workflow/simulate/simulate.go)). A successful `--broadcast` run can prove a simulated report changed chain state, not production DON consensus or confidential execution.

## Keep the deployed VM version consistent

| Target | Extruction opcode | SwapRegisters | Selector |
|---|---|---|---|
| This repository's AquaSwapVM v1.0.2, commit `32c687c2b73101fc26549e48fa1ff8a4d73afbac` | `0x20` | Five `uint256` fields, including `amountNetPulled` | `0xb77cc3e2` |
| Upstream `contracts/` main inspected on 2026-09-12 | `0x04` | Four `uint256` fields | `0xccd435ec` |

Use the pinned [Aqua opcode table](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/opcodes/AquaOpcodes.sol) and [VM interfaces](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/libs/VM.sol). Upstream [current opcode table](https://github.com/1inch/swap-vm/blob/main/contracts/libs/OpcodeList.sol) and [interfaces](https://github.com/1inch/swap-vm/blob/main/contracts/libs/VM.sol) belong to another version; `main` links may change. A future router upgrade must update interfaces, artifact, compiler and real-router tests together.

SDK v0.4.4's Regular table puts Extruction at `0x21`; the Aqua table uses `0x20`. The imported Aqua builder lacks the public Extruction helper, so `compileGuarded()` appends the tested instruction explicitly. Our bytes begin `0x20 0x7d`, followed by the 20-byte Guard and 105-byte envelope. There is no gas-limit field in that instruction.

The Guard's `view extruction()` returns the unchanged registers and `(nextPC, 0)` when accepted, and reverts to reject. The pinned router uses CALL for swaps and STATICCALL for quotes. Returning `false` is not a veto mechanism. Our existing mined rejection already supplies the real-swap evidence missing from the upstream example set; no claim of being the first Guard / veto use is made.

This deployment is **Base Sepolia, chain ID 84532**, not Ethereum Sepolia 11155111. The existing Aqua, router and token addresses are in [`deployments/84532.json`](../contracts/aqua-executor/deployments/84532.json). We do not need another Aqua or router deployment merely to test CRE delivery.

## Three distinct receiver configurations

| Profile | Forwarder | Identity | Use |
|---|---|---|---|
| Existing project harness | `0xf79ffa7f200220f564b91f20db39d357aa50a8c4` | Fabricated / simulation | Historical Guard enforcement evidence only |
| CRE CLI v1.33.0 simulation | `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5` | Zero workflow ID and owner; `simulationMode=true` | Requires a **new** simulation Guard |
| Production CRE | Obtain and verify the official forwarder for the chosen network | Assigned nonzero workflow ID / owner; `simulationMode=false` | Requires a separate deployment and actual delivery verification |

The CLI address comes from its [pinned supported-chains source](https://github.com/smartcontractkit/cre-cli/blob/v1.33.0/cmd/workflow/simulate/chain/evm/supported_chains.go). Recheck it when upgrading the CLI. Do not configure the CLI forwarder as production trust. Guard immutables cannot be changed after deployment. A new Guard also changes the Maker-approved program and its hash if later used for trading; the first paused transport probe deliberately does not ship a program.

## Public output leaks information

The intended confidential boundary protects the raw Provider policy and Maker inputs during evaluation. Public direction flags, caps, validity windows, Maker-approved program envelopes and trades can reveal information about those inputs over time. The prototype makes no quantified resistance-to-inference guarantee.

**A short expiry limits how long an authorization can be used; it does not erase historical reports or prevent strategy inference.** We currently disclose that limitation. Lower update frequency and bounded noise are research options, not implemented protections; they would need separate analysis of safety, usefulness and leakage. No noise is added to financial limits.

The current browser stores drafts locally, and the delivery smoke test processes public fixture data. Neither is evidence that real confidential inputs were stored or executed in a TEE.

## Relationship to the product mandate

[`PRODUCT-HANDOFF.md`](PRODUCT-HANDOFF.md), [`TOPIC-DILIGENCE.md`](TOPIC-DILIGENCE.md) and the Defensive Strategy B fixture in [`WINNING-FLOW.md`](WINNING-FLOW.md) describe the next product integration. The current transport test retains zero-fee XYC and mWETH / mUSDC. It does not implement `activeStrategyHash`, taker `expectedSequence`, two-strategy selection, cumulative quotas, combined wallet exposure, percentage valuation or Provider profit sharing.

The v1 nonce rejects stale report writes; it does **not** bind a taker to a quoted report revision. The Guard uses whichever valid report is current during the swap. Product JSON and Maker-facing direction labels require an explicit conversion into the existing taker-oriented ABI. Those changes need a new agreed contract / compiler interface and tests before the full mandate demo; adding them to JSON alone would not enforce them.
