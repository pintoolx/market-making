# ETHOnline Aqua flow

`AquaApp.tsx` serves three routes and reuses the original marketplace styles, logo and shared controls:

| Route | Screen |
|---|---|
| `/` | Role choice and architecture diagram (visitors without a Solana session; signed-in Solana users still get the workflow canvas) |
| `/studio` | Provider Studio: choose one of six templates, write the public listing and private logic, publish |
| `/maker` | Maker Marketplace: choose a strategy, set private limits, review the proposal |
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
- The current rule textarea accepts prose for product exploration. It is not an executable SwapVM program or a validated policy schema.
- Replace `publishedStore.ts` and the disabled "Execute with Aqua" button with encrypted TEE submission, structured policy validation and wallet-signed Aqua transactions when those integrations are ready.
- Onchain execution parameters are public; neither privacy nor loss protection is guaranteed by this UI.

## Local development

From the frontend directory run `npm run dev`, set `NEXT_PUBLIC_PRIVY_APP_ID` in `.env.local`, then open `/` on port 3200.
