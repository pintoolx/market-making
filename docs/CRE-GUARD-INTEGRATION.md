# Chainlink CRE and PinTool Guard

PinTool uses Chainlink Confidential Workflows to derive a public, short-lived execution authorization from a private Strategy Provider policy and private Maker limits. The DON signs that authorization, the configured Chainlink forwarder delivers it, and `AquaGuardV2` enforces it during every Aqua quote and swap.

## Delivery path

```text
Provider policy ─┐
                 ├─ TEE evaluation ─ public GuardReportV1 ─ DON signature
Maker limits ────┘                                            │
                                                              ▼
Market state ───────────────────────────────────── Keystone forwarder
                                                              │
                                                              ▼
Maker wallet ─ Aqua strategy ─ SwapVM Extruction ─ AquaGuardV2
```

The evaluator calls `runtime.usingTheDons()` only after private computation is complete. `EVMClient.writeReport()` sends the signed report through the forwarder to `onReport(bytes,bytes)`. The Guard authenticates the forwarder and, in production mode, the workflow ID and owner encoded in CRE metadata. It then validates the report domain, nonce, validity window and execution bounds.

An accepted report is only an authorization. It cannot transfer Maker assets or activate an Aqua strategy by itself. The Maker must approve and ship the complete SwapVM program.

## Deployment profiles

| Profile | Identity | Purpose |
|---|---|---|
| Local test | Project test forwarder | Contract and executor integration tests |
| CRE simulation | Directory-listed simulation forwarder, zero workflow ID and owner | CLI broadcast validation |
| Production | Official forwarder, assigned workflow ID and owner | DON-authenticated execution |

Receiver identity is immutable. Each profile requires its own Guard deployment. Never configure a simulation forwarder as a production trust root.

The checked-in [Ethereum Sepolia deployment](../contracts/aqua-executor/deployments/11155111.json) uses canonical WETH, Circle testnet USDC and the CRE simulation forwarder. The [historical public run](../contracts/aqua-executor/docs/ethereum-sepolia-demo.md) proves the Aqua lifecycle, successful guarded swaps and an onchain rejection with an earlier receiver. The current simulation receiver is `0xfadc3165abeb127a0815d5ea4e2862ed430e1f70`, with Maker-scoped active strategies. Its [separate replacement proof](../contracts/aqua-executor/docs/ethereum-sepolia-guard-revision.json) verifies creation input, immutable identity and empty active-strategy state through two RPCs. Neither run delivered a real CRE report. Production requires its own assigned workflow identity.

## Version compatibility

The executor pins AquaSwapVM v1.0.2 at commit `32c687c2b73101fc26549e48fa1ff8a4d73afbac`. Its Aqua opcode table assigns Extruction to `0x20` and its `SwapRegisters` contains five `uint256` fields. The compiler appends the tested Extruction instruction explicitly because the SDK builder does not expose it.

A router upgrade must update the vendor interfaces, opcode encoding, contract artifact, compiler and real-router tests together. Do not combine interfaces or opcodes from another SwapVM version.

## Verification boundary

The repository verifies these properties independently:

- workflow schema validation, deterministic policy intersection and no-secret output tests;
- byte-for-byte `GuardReportV1` encoding;
- report authentication, replay protection, expiry and domain separation;
- Maker-scoped active strategy switching;
- successful Aqua swaps and atomic Guard reverts with unchanged balances;
- mandate-service correlation and independent receipt verification.

A local workflow simulation does not prove production TEE execution or DON consensus. A public transaction from a project-owned forwarder proves contract behavior, not Chainlink authentication. Production evidence requires a registered workflow, its assigned identity, a matching Guard deployment and a confirmed forwarder transaction.

## Confidentiality boundary

Provider rules and Maker limits are confidential inputs. The report intentionally publishes direction flags, caps, validity, Maker, strategy hash and token pair. Aqua programs and completed trades are also public. Repeated outputs may reveal information about the original policies over time; expiry limits future use of an authorization but does not erase prior reports.

HTTP trigger payloads are visible to Workflow DON nodes. Pre-provisioned Provider policies and the envelope private key are fetched from Vault DON after execution enters the TEE. Provider-published policies and Maker limits arrive only as browser-sealed ciphertext, each bound to its public actor address. No plaintext secret may be logged, returned or embedded in a report.

## Configuration

| Concern | Source |
|---|---|
| Chain and canonical assets | `workflow/src/config/guard.ts` |
| Guard, router, Maker and strategy hashes | `workflow/market-maker-auth/config.*.json` |
| Workflow identity and trigger authorization | CRE deployment configuration |
| Report ABI and derivation | `docs/GUARD-REPORT-V1.md`, `workflow/src/` |
| Receiver and execution enforcement | `contracts/aqua-executor/contracts/AquaGuardV2.sol` |
| Product API and receipt validation | `orchestrator/` |
