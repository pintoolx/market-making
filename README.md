# PinTool Market Making

Private market-making strategies on 1inch Aqua, with Chainlink Confidential Compute integration in progress.

The product lets a Maker discover a strategy, inspect its public execution envelope, apply private capital limits and monitor its authorization around one self-custodial balance. A Maker may later add more strategies to that mandate. A confidential workflow authorizes at most one strategy at a time, and PinTool Guard enforces the resulting short-lived mandate on every Aqua swap. The recorded ETHOnline scenario uses two strategies to make the authorization reversal easy to verify. Confidential execution and profit sharing are not implemented end to end yet.

## Intended flow

1. **Providers publish private policies.** Each policy decides when its public Aqua execution envelope should be active.
2. **A Maker chooses a strategy and sets one private mandate.** Capital, WETH inventory, fill and expiry limits remain hidden from Providers. More strategies may be added to the same mandate later.
3. **A confidential workflow selects the permitted strategy.** A deterministic validator applies the Maker's hard limits before emitting a short-lived mandate.
4. **PinTool Guard enforces the mandate on Aqua.** Market regime changes switch the active strategy hash without moving the Maker's underlying wallet balance.

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
| Web app: role choice, structured Provider Studio, strategy discovery and detail, Maker mandate, monitoring and profile | `frontend/` | Working; live execution requires the mandate service configured below |
| CRE report delivery / confidential workflow | `workflow/` | Public adapter, SDK mock tests and WASM build ready; confidential evaluator is not yet in this repository |
| Aqua / SwapVM executor, off-chain loss monitor and transaction recovery | `contracts/aqua-executor/` | Imported; local tests and historical Base Sepolia evidence included |
| LP templates and automatic controller | `contracts/aqua-executor/` | XYC, PeggedSwap, concentrated LP; bounded range/fee rollover and guarded JSON recovery tested locally |
| Guard contract and per-swap enforcement | `contracts/aqua-executor/` | Guard v1/v2 tested locally; v1 has synthetic-report testnet evidence. Atomic A/B switching and actual CRE delivery remain pending |

## Getting started

```bash
pnpm install
cp frontend/.env.example frontend/.env.local   # set Privy and mandate service values
pnpm dev                                        # http://localhost:3000
```

Uses pnpm with a hoisted `node_modules` (see `.npmrc`). `@solana-program/token` is pinned in `package.json` because newer versions need a newer `@solana/kit` than the Solana wallet adapters use.

The executor requires **Node 24 or newer** for its SQLite journal. With Node 24 and Anvil installed, run `pnpm typecheck:contracts` and `pnpm test:contracts` (`ANVIL=/path/to/anvil` if needed). The web app's scripts and Node 22 Pages deployment remain separate. See [executor setup and migration](docs/AQUA-EXECUTOR-MIGRATION.md).

The CRE adapter uses a separate Bun package. Run `bun install --frozen-lockfile`, `bun test` and `bun run build` in `workflow/guard-report/`; see the [delivery runbook](workflow/guard-report/README.md).

## Deploy (Cloudflare Pages)

The web app is exported as a static site (`output: "export"`).

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Build output directory: `frontend/out`
- Environment variables: `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_MANDATE_API_URL` (inlined at build time) and `NODE_VERSION=22`
- The Maker flow does not fabricate workflow or transaction success when the mandate service is absent.
- Add the Pages domain to the Privy app's allowed origins.

## Docs

- [Product website model and lifecycle](docs/PRODUCT-WEBSITE.md)
- [Product spec and interfaces](docs/PRODUCT-HANDOFF.md)
- [Winning integration and video flow](docs/WINNING-FLOW.md)
- [Frontend mandate service contract](docs/STRATEGY-MANDATE-API.md)
- [ETHOnline topic diligence and prior-art analysis](docs/TOPIC-DILIGENCE.md)
- [Aqua maker strategy research](docs/AQUA-MAKER-RESEARCH.md)
- [What Aqua can enforce per swap, and the Guard design](docs/AQUA-STRATEGY-DEEP-DIVE.md)
- [CRE delivery decision, pinned VM version and privacy limits](docs/CRE-GUARD-INTEGRATION.md)
- [User stories and UX walkthrough](docs/UX-USER-STORIES.md)

## Background

The web app grew out of the [PinTool](https://github.com/pintoolx) app; its earlier git history is kept under `frontend/`. Everything from commit `33ff065` onward is new to this project; earlier commits are the existing PinTool app. How AI tools were used is described in [AI_USAGE.md](AI_USAGE.md).
