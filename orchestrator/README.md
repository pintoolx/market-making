# PinTool mandate service

This service implements the frontend's `/v1/mandates` contract while keeping plaintext Maker limits out of ordinary application storage and logs.

It delegates confidential evaluation and chain execution to a runner executable configured through `MANDATE_RUNNER`. One JSON request is written to the runner's stdin; the runner must write exactly one public `MandateState` JSON document to stdout. Diagnostic output belongs on stderr and must not contain private inputs.

The included `bin/confidential-http-runner` forwards that request to the separately deployed confidential execution gateway. It requires authenticated HTTPS outside localhost. The gateway is responsible for placing Provider and Maker inputs into the confidential workflow, waiting for the Guard report and Aqua execution, and returning only the public state below.

Supported runner requests:

```json
{ "action": "create", "input": { "maker": "0x...", "providerStrategyIds": ["..."], "makerLimitsEnvelope": { "version": 1, "ephemeralPublicKey": "...", "nonce": "...", "ciphertext": "..." } } }
{ "action": "get", "mandateId": "mandate-01", "makerLimitsEnvelope": { "...": "stored ciphertext" } }
{ "action": "add-strategy", "mandateId": "mandate-01", "providerStrategyId": "...", "makerLimitsEnvelope": { "...": "stored ciphertext" } }
```

Ethereum Sepolia is the target network. The runner owns the mapping from listing IDs to provisioned Provider secrets and Aqua strategy hashes. It must return only after the Guard report is accepted. The service validates the response, verifies the report transaction receipt through an independent RPC and persists only the public state. It never invents hashes or treats a planned transaction as evidence.

`GET /v1/strategies` exposes the public projection of `MANDATE_STRATEGY_CATALOG` together with `MANDATE_STRATEGY_MAKER`, the wallet bound into those Aqua programs. The Maker application requires that exact connected wallet before allowing execution. Private policy contents never appear in this response.

### Direct CRE runner

`bin/cre-mandate-runner` implements the production HTTP trigger protocol:

1. It builds the official `workflows.execute` JSON-RPC request.
2. It recursively sorts the request before hashing and signs an `alg: ETH` JWT with the configured authorized key.
3. It treats the gateway's `ACCEPTED` response as acknowledgement only.
4. It waits for a matching `ReportAccepted` event from the configured Guard.
5. It reads the stored report and returns public mandate state. The service independently verifies the transaction receipt again.

Configure `CRE_GATEWAY_URL`, `CRE_WORKFLOW_ID`, `CRE_HTTP_TRIGGER_PRIVATE_KEY`,
`MANDATE_GUARD_ADDRESS`, `MANDATE_STRATEGY_CATALOG` and the Ethereum Sepolia
RPC settings from `.env.example`.

The browser seals each Maker policy with an ephemeral X25519 key and XChaCha20-Poly1305. The corresponding private key is a Vault DON secret and is requested only after `handlerInTee` begins. The service can validate envelope shape but cannot read or silently broaden the limits. It stores ciphertext in a mode-0600 sidecar so reevaluation and strategy addition use the same Maker mandate without returning that ciphertext to the frontend.

The direct runner supports creation, reevaluation and adding a provisioned strategy. Each
catalog entry maps a public marketplace listing to an Aqua strategy hash. The workflow
selects the corresponding isolated Provider secret, and AquaGuardV2 atomically replaces
the Maker's active strategy hash after accepting the new report.

```bash
cp .env.example .env
# Set MANDATE_RUNNER to the absolute path of bin/confidential-http-runner.
# Replace the execution URL and token with the confidential gateway deployment.
set -a; . ./.env; set +a
node src/server.mjs
```

Set the frontend build variable to the public service URL, for example `NEXT_PUBLIC_MANDATE_API_URL=http://localhost:8787` during local integration. When Ethereum Sepolia is ready, change the chain, RPC and explorer environment variables together; the HTTP contract remains unchanged.

The default evidence network is Ethereum Sepolia (11155111), with `sepolia.etherscan.io` transaction links. Set the chain ID, network name, RPC and explorer together when overriding the defaults. The gateway must use the same confirmed Sepolia deployment; changing these defaults does not deploy or configure the gateway.

## Railway deployment

The root `railway.json` builds `orchestrator/Dockerfile` and checks `/health`. Create a Railway service from this repository and mount a persistent volume at `/data`; the container stores verified public mandate state under `/data/mandates`.

The image runs CRE CLI local simulation and broadcasts through Chainlink's official
simulation forwarder. It pins CRE v1.33.0, installs Bun, and writes credentials and
workflow secrets only when the container starts. Set these service variables:

```text
ALLOWED_ORIGIN=https://mm.pintool.fun
MANDATE_RUNNER=/workspace/orchestrator/bin/cre-local-simulation-runner
MANDATE_CHAIN_ID=11155111
MANDATE_NETWORK_NAME=Ethereum Sepolia
MANDATE_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
MANDATE_EXPLORER_URL=https://sepolia.etherscan.io
MANDATE_STATE_DIR=/data/mandates
CRE_AUTH_CONFIG_B64=<base64-encoded CRE CLI credential file>
CRE_ETH_PRIVATE_KEY=<funded Sepolia report signer>
SECRET_PROVIDER_STRATEGY=<private Provider policy JSON>
SECRET_PROVIDER_STRATEGY_DEFENSIVE=<private Provider policy JSON>
SECRET_MAKER_LIMITS=<fallback private Maker limits JSON>
SECRET_ENVELOPE_PRIVATE_KEY=<X25519 private key used by the confidential handler>
MANDATE_GUARD_ADDRESS=<current Guard deployment>
MANDATE_STRATEGY_CATALOG=<listing-to-strategy JSON>
MANDATE_MARKET_SNAPSHOT=<public market-state JSON>
```

Railway supplies `PORT`. After deployment, open `/health`, add the generated HTTPS origin to the frontend as `NEXT_PUBLIC_MANDATE_API_URL`, and rebuild the static frontend. A healthy process proves only that configuration parsing and HTTP serving work; create a mandate to verify CRE compilation, simulated confidential execution, official-forwarder delivery and onchain evidence. This mode is CRE local simulation, not production DON execution or TEE attestation.
