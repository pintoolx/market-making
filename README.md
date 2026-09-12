# PinTool Market Making

**Private strategy intelligence for self-custodial market making.**

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

The integrated execution environment uses Ethereum Sepolia with canonical WETH and Circle testnet USDC. The checked-in deployment bundle and public transaction records document a complete Aqua lifecycle, guarded swaps and an expected onchain rejection. See the [Ethereum Sepolia deployment](contracts/aqua-executor/docs/ETHEREUM-SEPOLIA.md) and [verified public run](contracts/aqua-executor/docs/ethereum-sepolia-demo.md).

## Integration status

The web application, mandate API, Aqua executor, Guard contracts and confidential workflow are implemented and tested. Ethereum Sepolia execution is verified. The checked-in Sepolia receiver was deployed for CRE simulation before Maker-scoped atomic strategy switching was added; deploy the current Guard artifact with the final workflow identity before enabling the full product flow. The mandate service accepts only independently verified Guard events and transaction receipts.

Provider policies and Maker limits are intended to remain confidential. Deployed programs, authorization bounds, receipts and completed trades are public. Repeated public output can reveal information over time, and risk limits do not guarantee profit or a maximum loss. See the [CRE and Guard integration](docs/CRE-GUARD-INTEGRATION.md) for the exact boundary.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Mandate API](docs/STRATEGY-MANDATE-API.md)
- [Authorization format](docs/AUTHORIZATION-FORMAT.md)
- [Guard report specification](docs/GUARD-REPORT-V1.md)
- [CRE and Guard integration](docs/CRE-GUARD-INTEGRATION.md)
- [Aqua executor](contracts/aqua-executor/README.md)
- [AI usage](AI_USAGE.md)
