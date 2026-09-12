> Current demo network: **Ethereum Sepolia / WETH / Circle testnet USDC**. See [setup and migration](../contracts/aqua-executor/docs/ETHEREUM-SEPOLIA.md). Set `guard` and `router` in `market-maker-auth` public config from the confirmed Sepolia bundle. Older Base references below describe historical validation.

# Confidential workflow (Chainlink CRE, TEE)

Owner: Henry (workflow). Counterpart: pengu (`contracts/`, the Aqua Guard).

A Chainlink CRE **Confidential Workflow** whose handler runs inside a TEE (AWS Nitro). It reads two confidential inputs — the Provider's strategy and the Maker's risk limits — as Vault DON secrets, intersects them at the current market snapshot, and emits a public [`GuardReportV1`](../docs/GUARD-REPORT-V1.md). The TEE never handles Maker funds.

The evaluator and report delivery are currently separate integration stages:

- [`market-maker-auth/`](market-maker-auth/) runs the Provider × Maker intersection through `handlerInTee` and produces the 16-field report in simulation.
- [`guard-report/`](guard-report/) encodes and delivers public report output through `runtime.report()` → `EVMClient.writeReport()`, then verifies Guard state and receipts.

Both stages have tests, but the confidential evaluator is not yet wired to the delivery adapter in one deployed workflow. CLI simulation is not production DON or TEE attestation. See the [transport and verification boundary](../docs/CRE-GUARD-INTEGRATION.md) and [`docs/authorization-format.md`](../docs/authorization-format.md).

## Layout

```
workflow/
├── project.yaml                 CRE project settings (RPCs per target)
├── secrets.yaml                 logical secret ids → env vars (PROVIDER_STRATEGY, MAKER_LIMITS)
├── .env.example                 synthetic demo secrets (copy to .env — gitignored)
├── market-maker-auth/           the CRE workflow (cre init --template hello-confidential-workflows-ts)
│   ├── workflow.ts              handlerInTee cron callback: getSecrets → intersect → publish
│   ├── workflow.test.ts         handler tests with a fake TeeRuntime
│   ├── config.staging.json      public config: schedule, maker, strategyHash, market snapshot, publishMode
│   └── workflow.yaml
├── src/
│   ├── types.ts                 zod schemas for both secrets, the snapshot and GuardReportV1
│   ├── intersect.ts             pure computeAuthorization() — no runtime, no clock, no I/O
│   ├── intersect.test.ts        15 cases: incompatible sides, exhausted inventory, expiry, rule order
│   ├── encode.ts                ABI encoder, golden-tested against docs/guard-report-v1/example.json
│   ├── publish.ts               THE seam to the Guard: publishAuthorization(runtime, result)
│   └── config/guard.ts          Guard / router / token / forwarder constants (TODO(pengu) marks)
└── scripts/check-no-leak.sh     simulate, then assert no private value appears in the output
```

## Run

Requires the [CRE CLI](https://docs.chain.link/cre) (tested with v1.33.0) and Bun.

```bash
cd workflow
bun install
cp .env.example .env          # synthetic values; real policies go here, never committed

bun test                      # 25 unit tests (src/ + market-maker-auth/)
bun run typecheck
bun run simulate              # = cre workflow simulate market-maker-auth --non-interactive --trigger-index 0
bun run check:leak            # simulate + leak scan
```

`simulate` prints the TEE notice box, the complete `GuardReportV1` payload the Guard would
receive (dry-run), its 512-byte ABI encoding and `keccak256` hash, and a public one-line
result. No deployment access is needed to simulate; deploying needs `cre account access`
and Confidential Workflows private-beta enrollment.

## Confidentiality boundary

| Stays in the enclave | Leaves the enclave |
|---|---|
| Provider rules, thresholds, TTL preferences, inventory ceilings | the 16-field `GuardReportV1` (public by design) |
| Maker budget, token0 share, per-swap tolerances, TTL | `allowedDirections`, nonce, validity window in the result string |
| matched rule id, which side bound each cap (`DecisionTrace`) | — |

Enforcement: `scripts/check-no-leak.sh` runs the simulation and fails if any scalar from the
two secrets appears in the output, except the caps the report publishes as `min(provider,
maker)` — those are listed explicitly so reviewers see exactly what is revealed.
`runtime.log()` calls inside the TEE handler are simulation-only and marked
`TODO(remove-before-deploy)`.

## Facts this is built on (verified, not remembered)

- `cre.handlerInTee(trigger, fn, [{ tee: 'nitro', regions: ['us-west-2'] }])`,
  `runtime.getSecrets([{ id }]).result()`, `runtime.now()`, `runtime.usingTheDons()` — from
  the official template and SDK 1.18.0 type definitions.
- `EVMClient.writeReport()` and every other `EVMClient` method accept only a DON `Runtime`
  (no `TeeRuntime` overload) → on-chain delivery must cross back with `usingTheDons()`.
- `HTTPClient.sendRequest()` is the only capability with a `TeeRuntime` overload.
- Quotas: 2 KB per secret, 27 KB per workflow, 5 secret calls per execution.
- Base Sepolia chain-selector name `ethereum-testnet-sepolia-base-1`; CRE mock forwarder
  `0x82300bd7c3958625581cc2f77bc6464dcecdf3e5`.

## Status

- [x] Scaffold from the official confidential template; baseline simulate passes
- [x] Pure intersection + GuardReportV1 encoding, golden-matched to the contracts fixture
- [x] TEE handler end-to-end in `cre workflow simulate` (dry-run publish)
- [x] Leak check script
- [ ] `publishMode: don-report` against a Guard deployed with the CRE forwarder (waiting on pengu — see `docs/authorization-format.md` §9)
- [ ] Market snapshot fetched inside the enclave via `HTTPClient` instead of config
