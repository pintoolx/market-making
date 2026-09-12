# PinTool mandate service

This service implements the frontend's `/v1/mandates` contract while keeping private Maker policy out of ordinary application storage and logs.

It delegates confidential evaluation and chain execution to a runner executable configured through `MANDATE_RUNNER`. One JSON request is written to the runner's stdin; the runner must write exactly one public `MandateState` JSON document to stdout. Diagnostic output belongs on stderr and must not contain private inputs.

The included `bin/confidential-http-runner` forwards that request to the separately deployed confidential execution gateway. It requires authenticated HTTPS outside localhost. The gateway is responsible for placing Provider and Maker inputs into the confidential workflow, waiting for the Guard report and Aqua execution, and returning only the public state below.

Supported runner requests:

```json
{ "action": "create", "input": { "maker": "0x...", "providerStrategyIds": ["..."], "policy": { "...": "..." } } }
{ "action": "get", "mandateId": "mandate-01" }
{ "action": "add-strategy", "mandateId": "mandate-01", "providerStrategyId": "..." }
```

Ethereum Sepolia is the target network. The runner owns the mapping from listing IDs to provisioned Provider secrets and Aqua strategy hashes. It must return only after the Guard report is accepted. The service validates the response, verifies the report transaction receipt through an independent RPC and persists only the public state. It never invents hashes or treats a planned transaction as evidence.

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

The current Confidential Workflow uses Vault DON secrets provisioned before execution.
The runner therefore accepts only a Maker policy whose canonical SHA-256 matches
`MANDATE_POLICY_SHA256`; it refuses to imply that arbitrary browser input reached the
TEE. This restriction can be removed when the workflow has an approved dynamic encrypted
input path.

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
