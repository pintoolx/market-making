# PinTool Market Making

Private market-making strategies on 1inch Aqua, with Chainlink Confidential Compute integration in progress.

The intended design lets Strategy Providers offer strategies while keeping their raw logic private. Makers use their own funds and private limits, with a Provider fee only when there is profit. Confidential execution and profit sharing are not implemented end to end yet.

## Intended flow

1. **A Provider publishes a strategy.** They start from an Aqua template, write the logic only they know, and set a performance fee. Makers only see the name, a description and the fee.
2. **A Maker sets private limits.** They pick a strategy and set a budget and a maximum exposure. The Provider never sees these.
3. **A confidential workflow combines both.** A Chainlink workflow running in a TEE checks the Provider's logic against the Maker's limits and only produces a plan that fits both.
4. **The Maker signs, and the strategy runs on Aqua.** Funds stay in the Maker's wallet the whole time. Limits are enforced on every swap, and the Provider's fee applies only to profit.

## What stays private

| Intended private inputs | Public output |
|---|---|
| Provider's pricing and adjustment logic | Strategy name, description and fee |
| Maker's original budget and exposure policy | Derived direction flags, caps, validity windows, activated strategy parameters and every onchain trade |

Public outputs and their history can reveal information about private inputs over time. Short expiry limits the use of an authorization; it does not erase historical reports or prevent strategy inference. We make no quantified privacy guarantee. Current frontend drafts remain in the browser, and the report delivery fixture uses public data; real TEE processing is still pending. See the [privacy and integration decision](docs/CRE-GUARD-INTEGRATION.md).

Limits reduce exposure; they do not guarantee a maximum loss.

## Status

| Part | Folder | Status |
|---|---|---|
| Web app: role choice, Provider Studio, Maker Marketplace, profile | `frontend/` | Working; published strategies and proposals are kept in the browser |
| CRE report delivery / confidential workflow | `workflow/` | Public adapter, SDK mock tests and WASM build ready; account access, actual delivery and TEE evaluator pending |
| Aqua / SwapVM executor, off-chain loss monitor and transaction recovery | `contracts/aqua-executor/` | Imported; local tests and historical Base Sepolia evidence included |
| Guard contract and per-swap enforcement | `contracts/aqua-executor/` | Prototype with synthetic-report testnet swaps / rejection evidence; actual CRE delivery pending |

## Getting started

```bash
pnpm install
cp frontend/.env.example frontend/.env.local   # set NEXT_PUBLIC_PRIVY_APP_ID
pnpm dev                                        # http://localhost:3000
```

Uses pnpm with a hoisted `node_modules` (see `.npmrc`). `@solana-program/token` is pinned in `package.json` because newer versions need a newer `@solana/kit` than the Solana wallet adapters use.

The executor requires **Node 24 or newer** for its SQLite journal. With Node 24 and Anvil installed, run `pnpm typecheck:contracts` and `pnpm test:contracts` (`ANVIL=/path/to/anvil` if needed). The web app's scripts and Node 22 Pages deployment remain separate. See [executor setup and migration](docs/AQUA-EXECUTOR-MIGRATION.md).

The CRE adapter uses a separate Bun package. Run `bun install --frozen-lockfile`, `bun test` and `bun run build` in `workflow/guard-report/`; see the [delivery runbook](workflow/guard-report/README.md).

## Deploy (Cloudflare Pages)

The web app is exported as a static site (`output: "export"`).

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Build output directory: `frontend/out`
- Environment variables: `NEXT_PUBLIC_PRIVY_APP_ID` (inlined at build time) and `NODE_VERSION=22`
- Add the Pages domain to the Privy app's allowed origins.

## Docs

- [Product spec and interfaces](docs/PRODUCT-HANDOFF.md)
- [Winning integration and video flow](docs/WINNING-FLOW.md)
- [ETHOnline topic diligence and prior-art analysis](docs/TOPIC-DILIGENCE.md)
- [Aqua maker strategy research](docs/AQUA-MAKER-RESEARCH.md)
- [What Aqua can enforce per swap, and the Guard design](docs/AQUA-STRATEGY-DEEP-DIVE.md)
- [CRE delivery decision, pinned VM version and privacy limits](docs/CRE-GUARD-INTEGRATION.md)
- [User stories and UX walkthrough](docs/UX-USER-STORIES.md)

## Background

The web app grew out of the [PinTool](https://github.com/pintoolx) app; its earlier git history is kept under `frontend/`. Everything from commit `33ff065` onward is new to this project; earlier commits are the existing PinTool app. How AI tools were used is described in [AI_USAGE.md](AI_USAGE.md).
