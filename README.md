# PinTool Market Making

Built for ETHOnline 2026 on 1inch Aqua and Chainlink Confidential Compute.

Strategy Providers publish market-making strategies; Makers run them on 1inch Aqua with their own funds and private limits. A Chainlink confidential workflow (TEE) combines both sides' private inputs, so neither has to reveal them. Makers keep custody of their funds and pay the Provider a fee only when they make a profit.

## Repository

| Folder | What it is | Status |
|---|---|---|
| `frontend/` | Next.js app: `/` role choice, `/studio` Provider Studio, `/maker` Maker Marketplace, `/profile` | Working prototype, data kept in the browser |
| TEE workflow | Chainlink confidential workflow that evaluates Provider logic against Maker limits | Planned |
| Aqua execution | Guard contract and SwapVM strategy that enforce the approved limits on every swap | Planned |

The frontend started from the PinTool app (`pintoolx/app`); its git history is kept under `frontend/`.

## Develop

Uses pnpm with a hoisted `node_modules` (see `.npmrc`); `@solana-program/token` is pinned in `package.json` because newer versions need a newer `@solana/kit` than the Solana wallet adapters use.

```bash
pnpm install
cp frontend/.env.example frontend/.env.local   # then set NEXT_PUBLIC_PRIVY_APP_ID
pnpm dev                                        # http://localhost:3000
```

## Deploy (Cloudflare Pages)

The frontend is exported as a static site (`output: "export"`).

- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Build output directory: `frontend/out`
- Environment variables: `NEXT_PUBLIC_PRIVY_APP_ID` (inlined at build time) and `NODE_VERSION=22`
- Add the Pages domain to the Privy app's allowed origins.
