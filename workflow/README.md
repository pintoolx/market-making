> Current demo network: **Ethereum Sepolia / WETH / Circle testnet USDC**. See [setup and migration](../contracts/aqua-executor/docs/ETHEREUM-SEPOLIA.md). Set `guard` and `router` in `market-maker-auth` public config from the confirmed Sepolia bundle. Older Base references below describe historical validation.

# Confidential workflow (Chainlink CRE, TEE)

A Chainlink CRE **Confidential Workflow** whose handler runs inside a TEE (AWS Nitro). It opens browser-sealed Provider strategies and Maker limits inside the TEE, intersects both policies at the current market snapshot, and emits a public [`GuardReportV1`](../docs/GUARD-REPORT-V1.md). Pre-provisioned strategies may instead be read directly from Vault DON. The TEE never handles Maker funds or signing keys.

The workflow has two entry points:

- A cron trigger continuously reevaluates the configured strategy.
- An authorized HTTP trigger performs on-demand evaluation for a public Maker, strategy hash, market snapshot and encrypted Maker envelope. A Provider-published listing may also supply an encrypted Provider policy bound to its public Provider address.

Both handlers enter the TEE before fetching secrets, then call the shared report delivery seam. Cron retains provisioned Provider and Maker secrets for scheduled operation. The product HTTP handler can decrypt both parties' authenticated envelopes using one Vault DON key fetch. The separate [`guard-report/`](guard-report/) package verifies encoding, DON delivery and Guard readback. CLI simulation is not production DON or TEE attestation. See the [system architecture](../docs/ARCHITECTURE.md) and [transport verification boundary](../docs/CRE-GUARD-INTEGRATION.md).

## Layout

```
workflow/
├── project.yaml                 CRE project settings (RPCs per target)
├── secrets.yaml                 Provider policies, cron limits and envelope private key
├── .env.example                 local simulation secrets (copy to .env — gitignored)
├── market-maker-auth/           the CRE workflow (cre init --template hello-confidential-workflows-ts)
│   ├── workflow.ts              cron + HTTP handlerInTee callbacks: getSecrets → intersect → publish
│   ├── workflow.test.ts         handler tests with a fake TeeRuntime
│   ├── http-request.example.json public identity, observation and synthetic ciphertext
│   ├── config.staging.json      public config: schedule, trigger signer, default identity and publishMode
│   └── workflow.yaml
├── src/
│   ├── confidential-envelope.ts authenticated envelope decryption inside the TEE
│   ├── types.ts                 policy schemas, the snapshot and GuardReportV1
│   ├── intersect.ts             pure computeAuthorization() — no runtime, no clock, no I/O
│   ├── intersect.test.ts        15 cases: incompatible sides, exhausted inventory, expiry, rule order
│   ├── encode.ts                ABI encoder, golden-tested against docs/guard-report-v1/example.json
│   ├── publish.ts               THE seam to the Guard: publishAuthorization(runtime, result)
│   └── config/guard.ts          Guard / router / token / forwarder constants
└── scripts/check-no-leak.sh     simulate, then assert no private value appears in the output
```

## Run

Requires the [CRE CLI](https://docs.chain.link/cre) (tested with v1.33.0) and Bun.

```bash
cd workflow
bun install
cp .env.example .env          # synthetic values; real policies go here, never committed

bun test                      # unit tests for evaluator, encoding and both triggers
bun run typecheck
bun run simulate              # cron trigger
bun run simulate:http         # HTTP trigger with the checked-in public payload
bun run check:leak            # simulate + leak scan
```

`simulate` prints the TEE notice box, the complete `GuardReportV1` payload the Guard would
receive (dry-run), its 512-byte ABI encoding and `keccak256` hash, and a public one-line
result. HTTP trigger input is visible to Workflow DON nodes and therefore contains ciphertext rather than plaintext Maker limits. No deployment access is needed to simulate; deploying needs `cre account access`
and Confidential Workflows private-beta enrollment.

## Confidentiality boundary

| Stays in the enclave | Leaves the enclave |
|---|---|
| Provider rules, thresholds, TTL preferences, inventory ceilings | the 16-field `GuardReportV1` (public by design) |
| Maker budget, WETH-value ceiling, per-swap tolerance, TTL | `allowedDirections`, nonce, validity window in the result string |
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
- Ethereum Sepolia chain-selector name `ethereum-testnet-sepolia`; CRE simulation forwarder
  `0x15fc6ae953e024d975e77382eeec56a9101f9f88`. The current simulation Guard uses
  the Maker-active revision in `deployments/11155111.json`; production needs its own identity.

## Production configuration

- Replace `authorizedEVMAddress` with the EVM address used to sign CRE HTTP trigger requests. An empty or placeholder authorization is not valid production configuration.
- Deploy a production Guard with the official forwarder and assigned workflow identity, then replace the zero Guard placeholder in `config.production.json`. Never point the production target at the simulation receiver.
- Upload Provider strategies, cron Maker limits and `ENVELOPE_PRIVATE_KEY` through Vault DON. Publish only the matching X25519 public key to the web application.
- Use `publishMode: don-report` with a Guard deployed for the official forwarder and assigned workflow identity.
- Supply live market observations and Maker balances through a verified data path. The checked-in HTTP fixture and cron defaults are deterministic local inputs.
- Remove simulation-only report logging before deployment.
