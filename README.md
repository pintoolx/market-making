## PinTool Frontend

The PinTool frontend is the creator-facing workspace where on-chain quants wire, test, and deploy automated Web3 workflows without touching raw smart contracts. We built a highly opinionated experience on top of Next.js 15, Solana wallet adapters, and a bespoke node editor so our users can orchestrate complex strategies with the same ease as dragging blocks.

### What Sets Us Apart

- **Workflow Builder** – A realtime node canvas with snap-to-grid positioning, precision zooming, keyboard navigation, and pan/drag safeguards. We render protocol-specific SVG overlays (Jupiter, Pyth, Kamino, Telegram…) and keep UX buttery smooth even with thousands of nodes.
- **Composable Notifications** – First-class integrations for Telegram, Discord, and upcoming Web3 inboxes. Users craft message templates, validations, and rate limits inside ConfigPanel, and we persist schema-driven configs end-to-end.
- **Adaptive Chat Copilot** – Our AI assistant (launching soon) reads the canvas, understands node categories, and scaffolds strategies directly on drop. The chat panel auto-resizes beneath editor controls regardless of viewport or overlay states.
- **Seamless Auth** – Wallet-only onboarding powered by Supabase Web3 auth. The hover-driven account menu reroutes builders to their profile or back to the workspace without ever blocking the main editor.
- **Production-grade UI System** – Heavily customized Space Grotesk design system, drop-shadow physics, Lucide icon swaps, and highly tuned CSS modules that reproduce the Figma look pixel-for-pixel.

### Architecture at a Glance

| Layer | Highlights |
| ----- | ---------- |
| **App Router** | Fully typed Next.js 15 app directory with React Server Components where it makes sense, client components for the interactive canvas. |
| **State** | Local component state for instantaneous interactions, Supabase session hooks, and upcoming Zustand slices for cross-canvas coordination. |
| **Nodes** | Strategy metadata is validated via shared TypeScript interfaces; we precompute defaults for price feeds, DEX swaps, lending, and notifications. |
| **Styling** | CSS Modules tuned for multi-device layouts, deterministic animations, and fine-grained control of z-index stacking on the canvas. |
| **Tooling** | ESLint, TypeScript strict mode, and pnpm workspaces. The roadmap includes Playwright regression suites and Chromatic visual diffing. |

### Getting Started

```bash
pnpm install
pnpm dev
```

Navigate to `http://localhost:3200` and connect a Solana wallet (Devnet by default). To explore the creator flow:

1. Click **Edit** to open the node toolbox.
2. Drag in Price Feed, Swap, Lending, and Notification nodes.
3. Configure thresholds and messaging via the right-hand Config Panel.
4. Hit **Deploy** to persist a mock strategy; it appears instantly on the Workflows page.

### Contributing

We build fast, test thoroughly, and keep DX polished. PRs should respect the established design language, avoid regression on the workflow builder, and include stories/screenshots for UI changes. Open an issue if you want to collaborate on the roadmap items above.
