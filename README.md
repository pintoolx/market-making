# PinTool Market Making

**Private strategy intelligence for self-custodial market making.**

Current demo assets: [Ethereum Sepolia WETH / Circle testnet USDC](contracts/aqua-executor/docs/ETHEREUM-SEPOLIA.md).


PinTool connects Strategy Providers with Makers on [1inch Aqua](https://1inch.com/aqua/). Providers contribute proprietary market-making policies, Makers define private risk limits, and a [Chainlink Confidential Workflow](https://chain.link/confidential-compute) combines both inside a TEE. The resulting short-lived authorization is enforced on every swap by PinTool Guard.

## How it works

```text
Strategy Provider policy ─┐
                          ├─► Chainlink Confidential Workflow ─► signed authorization
Maker risk limits ────────┘                                          │
                                                                    ▼
Maker wallet ───────────────► 1inch Aqua strategy ───────────► PinTool Guard
        one self-custodial balance                         allow or revert each swap
```

1. A **Strategy Provider** publishes a strategy listing while keeping its activation rules, thresholds and sizing logic private.
2. A **Maker** selects a strategy and sets private limits for capital, inventory, fills and authorization lifetime.
3. The confidential workflow intersects both policies. It can make a Maker's limits stricter, never looser.
4. PinTool Guard accepts the signed authorization and enforces it during Aqua execution.

This lets one Maker balance support multiple strategies without transferring custody to PinTool. At most one strategy in a mandate is active at a time.

## Product surfaces

- **Strategy marketplace** — discover strategies and inspect their public execution envelopes.
- **Provider Studio** — create a strategy from structured market-making templates and publish its public listing.
- **Maker mandate** — configure private risk limits and assign liquidity to compatible strategies.
- **Activity monitor** — follow confirmed authorization changes and onchain execution.

## Architecture

| Component | Location | Responsibility |
|---|---|---|
| Web application | [`frontend/`](frontend/) | Marketplace, Provider Studio, Maker mandate, monitoring and profile |
| Mandate service | [`orchestrator/`](orchestrator/) | Request validation, confidential runner transport and receipt verification |
| Confidential workflow | [`workflow/market-maker-auth/`](workflow/market-maker-auth/) | Private policy intersection and Guard report generation |
| Report delivery | [`workflow/guard-report/`](workflow/guard-report/) | DON report encoding and onchain delivery |
| Aqua executor | [`contracts/aqua-executor/`](contracts/aqua-executor/) | Compile, ship, swap, rebalance, monitor and dock Aqua strategies |
| PinTool Guard | [`contracts/aqua-executor/contracts/`](contracts/aqua-executor/contracts/) | Enforce direction, amount, inventory and expiry bounds per swap |

Read the [system architecture](docs/ARCHITECTURE.md) for trust boundaries and execution invariants.

## Local development

### Web application

```bash
pnpm install
cp frontend/.env.example frontend/.env.local
pnpm dev
```

The app runs at [http://localhost:3200](http://localhost:3200). Set `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_MANDATE_API_URL` in `frontend/.env.local`.

### Validation

```bash
pnpm lint
pnpm build
pnpm test:orchestrator

cd workflow
bun install --frozen-lockfile
bun test
bun run typecheck
```

The Aqua executor requires Node.js 24 or newer and Anvil:

```bash
pnpm typecheck:contracts
ANVIL=/path/to/anvil pnpm test:contracts
```

## Deployment

The frontend is a static Next.js export deployed at [mm.pintool.fun](https://mm.pintool.fun).

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Output directory: `frontend/out`
- Runtime variables: `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_MANDATE_API_URL`, `NODE_VERSION=22`

Ethereum Sepolia is the target network for the integrated WETH/USDC flow. The repository also contains earlier Base Sepolia execution receipts used to validate the imported Aqua executor. A network migration must update the deployment manifest, workflow domain, RPC, explorer and frontend configuration together; the mandate service rejects mixed-network evidence.

## Integration status

The web product, mandate API, Aqua executor, Guard contracts and confidential evaluation workflow are implemented and tested independently. The mandate service includes the complete signed CRE HTTP trigger and Guard-event verification path. End-to-end deployment requires the Ethereum Sepolia contract addresses, a deployed Confidential Workflow ID and the corresponding authorized signer. Until those values are configured, the product does not present planned actions as confirmed transactions.

Provider policies and Maker limits are intended to remain confidential. Deployed programs, authorization bounds, receipts and completed trades are public. Repeated public output can reveal information over time, and risk limits do not guarantee profit or a maximum loss. See the [CRE and Guard integration](docs/CRE-GUARD-INTEGRATION.md) for the exact boundary.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Mandate API](docs/STRATEGY-MANDATE-API.md)
- [Authorization format](docs/AUTHORIZATION-FORMAT.md)
- [Guard report specification](docs/GUARD-REPORT-V1.md)
- [CRE and Guard integration](docs/CRE-GUARD-INTEGRATION.md)
- [Aqua executor](contracts/aqua-executor/README.md)
- [AI usage](AI_USAGE.md)
