# Builder implementation status

Goal active since 2026-09-13. Scope: [approved goal v2](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md). Initial main: `167b630`. Worktree: `/home/kuoba123/eth-glo/market-making-builder-impl`; branch: `feat/strategy-builder-core`.

| Area | Current state |
|---|---|
| Multi-turn domain | Implemented strict drafts/patches, preserving other settings, revision diffs and restoration; application persistence and actual agent are pending |
| Capability inventory | Every non-reserved Aqua opcode accounted for; unsupported combinations retain specific reasons and distinct readiness evidence |
| Guard recipes | Extended existing V2 compiler to XYC/Pegged; CLMM retained; local actual-router tests pass |
| Compiler/decoder | Three zero-fee curves compile from new Maker drafts; independent decoder checks recipe, traits, target, envelope and parameters |
| Deployment | Fixed-block read verifier passed at Sepolia finalized block 11690690; all 6 contracts, Guard/router bindings and token metadata checked. Source-to-runtime and live recipe gates remain separate |
| PostgreSQL/auth | Not started; previously provisioned Railway database exists |
| OpenAI/UI | Not started. User offered to provide OpenAI API access; configure server-side `OPENAI_API_KEY` at integration time, never paste/read it in chat |
| Private policies/template permissions | Existing evaluator reusable; Builder authoring, consent and publication integration pending |
| Wallet/dynamic binding | Pending |
| Event worker/recovery | Pending |
| Fees/modifiers | Pending after zero-fee flow; do not redefine these as completed |
| Cloud/live acceptance/PRs | Pending |

First-batch verification is recorded in the PR and test results as it completes. No public-chain write, model request, new database table or cloud deployment has been performed by this implementation batch.

Local verification: Builder 6 passed; executor suite 79 passed / 1 optional Sepolia fork skipped; both TypeScript checks pass. After making exported order traits JSON-safe, the 5 Builder compiler/settlement cases were rerun successfully. A pinned-action CI workflow now runs the domain and local Guard suites without secrets or public-chain writes.

Continue with the full goal. The original workspace remains on another user's ENS work; do not overwrite it or assume its files match this implementation worktree.
