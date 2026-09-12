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

The current defaults target the checked-in Base Sepolia contracts. The runner owns the mapping from listing IDs to Provider secrets and Aqua strategy hashes. It must return only after the Guard report is accepted. The service validates the response, verifies the report transaction receipt through an independent RPC and persists only the public state. It never invents hashes or treats a planned transaction as evidence.

```bash
cp .env.example .env
# Set MANDATE_RUNNER to the absolute path of bin/confidential-http-runner.
# Replace the execution URL and token with the confidential gateway deployment.
set -a; . ./.env; set +a
node src/server.mjs
```

Set the frontend build variable to the public service URL, for example `NEXT_PUBLIC_MANDATE_API_URL=http://localhost:8787` during local integration. When Ethereum Sepolia is ready, change the chain, RPC and explorer environment variables together; the HTTP contract remains unchanged.
