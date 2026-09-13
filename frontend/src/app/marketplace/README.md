# Market Making web application

The application exposes the two sides of the PinTool market:

| Route | Purpose |
|---|---|
| `/` | Product entry and role selection |
| `/studio` | Browse six templates or open the custom Strategy Builder; save public drafts and publish supported CLMM versions |
| `/maker` | Discover strategies, configure a Maker mandate and monitor verified activity |
| `/profile` | Manage strategies, mandates, account details and Provider identity |

`AquaApp.tsx` provides the application shell. `ProviderFlow.tsx` and `MakerFlow.tsx` implement the role-specific journeys, while `ui.tsx` contains shared product components.

## Data ownership

- Signed CLMM publications are stored in the publication service. Profile preferences and legacy listing metadata remain browser-local.
- Non-CLMM public design drafts are stored per wallet and template in this browser. They are not listings or executable strategies. CLMM private inputs remain in memory only.
- Maker limits and Provider policies are sealed in the browser before submission. The configured CRE local simulation operator can access decrypted inputs; this is not evidence of production TEE confidentiality.
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
