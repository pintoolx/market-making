# ETHOnline Aqua flow

`AquaApp.tsx` serves three routes and reuses the original marketplace styles, logo and shared controls:

| Route | Screen |
|---|---|
| `/` | Role choice and architecture diagram (visitors without a Solana session; signed-in Solana users still get the workflow canvas) |
| `/studio` | Provider Studio: choose one of six templates, configure mechanism parameters and a private activation policy, then publish |
| `/maker` | Maker Marketplace: browse strategies, inspect one strategy, apply private limits, and monitor confirmed authorization and execution activity |
| `/profile` | Providing / Making / Account tabs: your strategies, your proposals, photo and profile details |

`/marketplace` redirects to `/`. Steps inside `/studio` and `/maker` are page state, shown by the step bar. `AquaApp.tsx` is the shell and home screen; `ProviderFlow.tsx` and `MakerFlow.tsx` hold each flow; `ui.tsx` has the shared step bar, heading and listing card.

Browser storage until a backend or the TEE takes over:

- `publishedStore.ts` (`localStorage`): published strategies with author name, photo and performance fee. Private logic is never stored.
- `proposalStore.ts` (`localStorage`): Maker proposals shown in Profile → Making.
- Provider drafts (`sessionStorage`, this tab only): dropped once published.
- `../profile/profileStore.ts` (`localStorage`): photo, name, bio and X handle per Privy user.

Publishing needs a Privy login when `NEXT_PUBLIC_PRIVY_APP_ID` is set. Nothing is encrypted, submitted to a TEE, signed or executed yet. User stories and the UX walkthrough: `ethonline-2026/UX-USER-STORIES.md` in the pintool workspace.

## Integration boundary

- `aquaTemplates.ts` is the example catalog, not a list of deployed providers.
- Base strategies, strategy modifiers and capital policies are distinct categories.
- Provider rules and Maker boundaries must be separate inputs to the future confidential evaluation service.
- Provider Studio separates template-specific execution parameters from structured private activation conditions. Confidential submission, durable commitments and compilation into a validated SwapVM program remain integration boundaries.
- Replace `publishedStore.ts` with the durable Provider registry when ready. The Maker flow already calls the service contract in `mandateClient.ts`; it never fabricates approval, report delivery, swap settlement or Guard rejection.
- A Maker starts with one strategy. The mandate model and monitor accept a larger strategy set so additional strategies can be added later without making first-use onboarding depend on portfolio construction.
- Recorded market transitions and test-taker swaps belong to workflow and contract tooling. The product UI reads confirmed mandate state and activity instead of exposing test controls.
- Onchain execution parameters are public; neither privacy nor loss protection is guaranteed by this UI.

## Local development

From the frontend directory run `npm run dev`, set `NEXT_PUBLIC_PRIVY_APP_ID` in `.env.local`, then open `/` on port 3200.
