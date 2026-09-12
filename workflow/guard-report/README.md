# Guard report delivery

This package implements the first **public report transport check** for the [selected CRE delivery route](../../docs/CRE-GUARD-INTEGRATION.md). `main.ts` registers an ordinary cron handler; it does not load secrets or run inside a TEE. `submitPublicReportFromTee()` is a hook for the future confidential evaluator, tested with a stub runtime crossover and official SDK mocks only.

## Offline setup and checks

Use Bun 1.4.2 (SDK minimum 1.2.21). This package has its own `bun.lock`; root `pnpm install` does not install it. Dependencies are pinned, including CRE SDK 1.20.1. From this directory:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

The build writes `.cache/guard-report.wasm`. The SDK downloads a checksum-verified Javy binary on its first build. Local preparation scripts have a separate TypeScript project because filesystem APIs are forbidden in the CRE workflow runtime; they are not imported into WASM.

`report.ts` validates the shared [v1 ABI](../../docs/guard-report-v1/abi.json), requiring decimal strings for integers. `runtime.report()` receives exactly `abi.encode(GuardReportV1)` without a function selector. Delivery checks the Guard's forwarder, router, simulation flag and workflow identity before writing. Success requires both transaction and receiver success, a nonzero transaction hash and a matching `getReport()` digest. The [EVM response reference](https://docs.chain.link/cre/reference/sdk/evm-client-ts) distinguishes receiver execution from the outer transaction result.

`config.example.json` illustrates the strict public schema with a placeholder Guard and expired timestamps. It is not an executable authorization. Never put a raw private policy, secret or original Maker budget in config or the public output. Structural validation cannot detect a secret deliberately encoded into an otherwise valid public field; choosing the derived output remains the evaluator's responsibility.

## Prepare the first simulated chain write

The team currently has no CRE account / Confidential Workflows access. These are instructions for a future run, **not completed chain evidence**. Start with [account creation](https://docs.chain.link/cre/account/creating-account), install [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux) v1.33.0, log in with `cre login`, and confirm `cre whoami`. Real confidential execution separately needs [Confidential Workflows access](https://docs.chain.link/cre/account/confidential-workflows-access).

1. Build the WASM before preparing the short-lived report. Generate a reviewable unsigned Guard creation:

   ```bash
   bun run setup:guard deployment
   ```

   `.cache/cre-simulation-guard-deployment.json` contains chain ID 84532, zero value, creation `data` and constructor arguments. It is not signed or broadcast. When ready, deploy this creation data with a Base Sepolia wallet, leaving the transaction recipient unset, and record the resulting Guard address and successful receipt. Check deployed code at the configured forwarder and router first. The constructor also rejects missing code. No token approvals, shipping or swaps are needed for this transport check.

   The constructor binds the official CLI simulation forwarder, existing router, zero workflow ID / owner and `simulationMode=true`. The historical Guard `0x41fde9f1f257fc65a40eb519d22ca9bfb1d2dbeb` trusts our own harness and cannot be reused here.

2. After deployment, prepare a paused report using your **public** Maker address and an explicit unused nonce:

   ```bash
   bun run setup:guard config --guard NEW_GUARD_ADDRESS --maker PUBLIC_MAKER_ADDRESS --nonce 1
   ```

   The tool makes read-only RPC calls, checks chain and Guard immutables, and refuses a used nonce. It writes `config.generated.json` without overwriting an existing file. The report uses a deliberately unshipped probe hash, disables both directions, sets all caps to zero, and expires 300 seconds after the latest block timestamp. The local clock must agree that the report is current. Save the printed ABI bytes and digest with the config; no key is used by this tool. `--rpc URL` selects another read endpoint.

3. CRE simulation broadcast needs a gas-paying testnet signer. Configure `CRE_ETH_PRIVATE_KEY` in an ignored local `.env`, as used in the [official Base Sepolia example](https://github.com/smartcontractkit/x402-cre-price-alerts); this is the CLI simulator's signer, not a key used by the production workflow. Keep credentials out of config and terminal output. From the repository's `workflow/` directory:

   ```bash
   cre workflow simulate ./guard-report --target simulation-settings \
     --wasm ./guard-report/.cache/guard-report.wasm \
     --trigger-index 0 --non-interactive --broadcast --env /absolute/path/to/local/.env
   ```

   Without `--broadcast`, the adapter cannot report confirmed success: it requires a real receiver receipt and matching chain state. Simulation targets use zero workflow identity. The `production-settings` YAML target does not grant deployment access or turn the public entry point into a confidential workflow.

4. Retain the CLI result, transaction receipt, Guard `ReportAccepted` event and `getReport(maker, strategyHash)` digest matching the prepared bytes. Re-read them with an independent RPC. Only then label this milestone **CRE CLI simulated delivery confirmed on Base Sepolia**. It does not establish production DON / TEE execution or activation of a trading strategy.

## Retry and integration rules

Retry the exact same config only while its original validity window is current, after checking any previous transaction and stored digest. The adapter never changes a nonce, refreshes expiry or re-evaluates limits during a retry. An identical accepted report is a Guard no-op; changed bytes under the same nonce revert. Archive old config before preparing a **new** report with a larger unused nonce. A readback failure may follow an accepted transaction, so inspect its logged hash before doing anything else.

The cron entry intentionally submits one fixed report; subsequent ticks expire. It is a transport fixture, not an authorization renewal service. The evaluator / application must persist the mapping from request to report bytes and delivery receipt. There is no delivery journal or automatic recovery worker in this package.

For production, obtain the actual workflow ID / owner and official network forwarder, deploy a separate identity-bound Guard, and supply `transport.profile="cre-production"`. The adapter rejects the CLI forwarder and zero identities in that profile and checks the receiver's immutables; it cannot certify that an arbitrary operator-supplied address is an official production forwarder. Verify it against the [official directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory). Replace the public fixture entry with the confidential evaluator, passing only its derived public report into `submitPublicReportFromTee()`. Deployment, real TEE processing and actual production delivery all remain to be verified.

See [verification status](VERIFICATION.md) and the [version / privacy decision](../../docs/CRE-GUARD-INTEGRATION.md).
