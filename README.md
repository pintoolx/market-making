# PinTool Market Making

Private market-making strategies on 1inch Aqua, powered by Chainlink Confidential Compute.

Strategy Providers publish market-making strategies without revealing their logic. Makers run them with their own funds and their own private limits, and pay the Provider a share of the profit, only when there is one.

## How it works

1. **A Provider publishes a strategy.** They start from an Aqua template, write the logic only they know, and set a performance fee. Makers only see the name, a description and the fee.
2. **A Maker sets private limits.** They pick a strategy and set a budget and a maximum exposure. The Provider never sees these.
3. **A confidential workflow combines both.** A Chainlink workflow running in a TEE checks the Provider's logic against the Maker's limits and only produces a plan that fits both.
4. **The Maker signs, and the strategy runs on Aqua.** Funds stay in the Maker's wallet the whole time. Limits are enforced on every swap, and the Provider's fee applies only to profit.

## What stays private

| Private | Public |
|---|---|
| Provider's pricing and adjustment logic | Strategy name, description and fee |
| Maker's budget and exposure limits | Parameters of an activated strategy and every trade onchain |

Limits reduce exposure; they do not guarantee a maximum loss.

## Status

| Part | Folder | Status |
|---|---|---|
| Web app: role choice, Provider Studio, Maker Marketplace, profile | `frontend/` | Working; published strategies and proposals are kept in the browser |
| Confidential workflow (Chainlink TEE) | `workflow/` | In progress |
| Aqua / SwapVM executor, off-chain loss monitor and transaction recovery | `contracts/aqua-executor/` | Imported; local tests and historical Base Sepolia evidence included |
| Guard contract, workflow reports and per-swap enforcement | `contracts/` | Pending report agreement and implementation |

## Getting started

```bash
pnpm install
cp frontend/.env.example frontend/.env.local   # set NEXT_PUBLIC_PRIVY_APP_ID
pnpm dev                                        # http://localhost:3000
```

Uses pnpm with a hoisted `node_modules` (see `.npmrc`). `@solana-program/token` is pinned in `package.json` because newer versions need a newer `@solana/kit` than the Solana wallet adapters use.

The executor requires **Node 24 or newer** for its SQLite journal. With Node 24 and Anvil installed, run `pnpm typecheck:contracts` and `pnpm test:contracts` (`ANVIL=/path/to/anvil` if needed). The web app's scripts and Node 22 Pages deployment remain separate. See [executor setup and migration](docs/AQUA-EXECUTOR-MIGRATION.md).

## Deploy (Cloudflare Pages)

The web app is exported as a static site (`output: "export"`).

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Build output directory: `frontend/out`
- Environment variables: `NEXT_PUBLIC_PRIVY_APP_ID` (inlined at build time) and `NODE_VERSION=22`
- Add the Pages domain to the Privy app's allowed origins.

## Docs

- [Product spec and interfaces](docs/PRODUCT-HANDOFF.md)
- [Aqua maker strategy research](docs/AQUA-MAKER-RESEARCH.md)
- [What Aqua can enforce per swap, and the Guard design](docs/AQUA-STRATEGY-DEEP-DIVE.md)
- [User stories and UX walkthrough](docs/UX-USER-STORIES.md)

## Background

The web app grew out of the [PinTool](https://github.com/pintoolx) app; its earlier git history is kept under `frontend/`. Everything from commit `33ff065` onward is new to this project; earlier commits are the existing PinTool app. How AI tools were used is described in [AI_USAGE.md](AI_USAGE.md).
