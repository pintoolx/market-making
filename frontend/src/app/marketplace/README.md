# Market Making web application

The application exposes the two sides of the PinTool market:

| Route | Purpose |
|---|---|
| `/` | Product entry and role selection |
| `/studio` | Create and publish a Strategy Provider listing |
| `/maker` | Discover strategies, configure a Maker mandate and monitor verified activity |
| `/profile` | Manage strategies, mandates and account details |

`AquaApp.tsx` provides the application shell. `ProviderFlow.tsx` and `MakerFlow.tsx` implement the role-specific journeys, while `ui.tsx` contains shared product components.

## Data ownership

- Published listing metadata and profile preferences currently persist in browser storage.
- Provider drafts remain in session storage until publication.
- Maker limits are sealed in the browser for the confidential workflow. Provider policies are provisioned through Vault DON; plaintext private inputs never enter the mandate service.
- Confirmed mandate state comes from `NEXT_PUBLIC_MANDATE_API_URL`. The UI never generates transaction receipts or treats requested actions as confirmed.
- Executable profile availability comes from `GET /v1/strategies`. The marketplace can present several immutable Aqua profiles as one adaptive strategy product, but every required profile must be provisioned before that product accepts liquidity.
- `Refresh status` is a read-only evidence and readiness check. `Re-evaluate strategy` is the explicit product action that may run the confidential workflow and publish a new Guard authorization.

## Integration points

- `aquaTemplates.ts` defines supported strategy templates and their structured parameters.
- `mandateClient.ts` implements the product-facing mandate API.
- `publishedStore.ts` retains Provider-authored listing metadata until a durable registry is connected. Publication alone does not make a strategy executable.
- Aqua programs, authorization bounds and completed trades are public even when the source policies remain private.

## Development

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Set `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_MANDATE_API_URL` and `NEXT_PUBLIC_CONFIDENTIAL_WORKFLOW_PUBLIC_KEY` in `frontend/.env.local`. The application runs on port 3200.
