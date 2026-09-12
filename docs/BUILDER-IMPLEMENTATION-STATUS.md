# Builder implementation status

Goal active since 2026-09-13. Scope: [approved goal v2](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md). Initial main: `167b630`. Worktree: `/home/kuoba123/eth-glo/market-making-builder-impl`; current branch: `feat/builder-persistence`, based on main `284613a`.

| Area | Current state |
|---|---|
| Multi-turn domain | Implemented strict drafts/patches, preserving other settings, revision diffs and restoration; application persistence and actual agent are pending |
| Capability inventory | Every non-reserved Aqua opcode accounted for; unsupported combinations retain specific reasons and distinct readiness evidence |
| Guard recipes | Extended existing V2 compiler to XYC/Pegged; CLMM retained; local actual-router tests pass |
| Compiler/decoder | Three zero-fee curves compile from new Maker drafts; independent decoder checks recipe, traits, target, envelope and parameters |
| Deployment | Fixed-block read verifier passed at Sepolia finalized block 11690690; all 6 contracts, Guard/router bindings and token metadata checked. Source-to-runtime and live recipe gates remain separate |
| PostgreSQL/auth | Implemented additive migrations, owned drafts/messages/history, atomic idempotency/outbox, generic leased jobs, EOA SIWE sessions and an HTTP handler. Local real PostgreSQL: 9 tests pass. Production mounting/migration and application roles pending |
| OpenAI/UI | Not started. User offered to provide OpenAI API access; configure server-side `OPENAI_API_KEY` at integration time, never paste/read it in chat |
| Private policies/template permissions | Existing evaluator reusable; Builder authoring, consent and publication integration pending |
| Wallet/dynamic binding | Pending |
| Event worker/recovery | Pending |
| Fees/modifiers | Pending after zero-fee flow; do not redefine these as completed |
| Cloud/live acceptance/PRs | Core [PR #42](https://github.com/pintoolx/market-making/pull/42) reviewed and merged at `284613a`; final head `030c245` passed GitHub suites and Cloudflare preview. Builder application rollout and live acceptance pending |

Core verification is recorded in PR #42. The persistence batch has created only disposable local test databases; it has not run Railway business migrations, a model request or a public-chain write. Cloudflare's existing PR/main integration builds the frontend automatically; the new Builder handler is not deployed or mounted yet.

Local verification: Builder 6 passed; executor suite 79 passed / 1 optional Sepolia fork skipped; both TypeScript checks pass. After making exported order traits JSON-safe, the 5 Builder compiler/settlement cases were rerun successfully. A pinned-action CI workflow now runs the domain and local Guard suites without secrets or public-chain writes.

Continue with the full goal. The original workspace remains on another user's ENS work; do not overwrite it or assume its files match this implementation worktree.

The latest main also contains ENS/monitor/standing-documentation updates and a publication config fix; all are retained. After integrating main, orchestrator verification was 43 passed / 1 optional fork skipped. Two pre-existing interrupted-transaction tests were fixed to compare pending nonces when the transaction is still in Anvil's mempool; all 12 affected tests and final CI passed.

Persistence follow-up: [service package](../packages/builder-service/README.md). It exports a handler but does not yet mount it in the deployed service, call OpenAI, consume message outbox events or send Guard reports. The user confirmed that Railway `mandate-service`'s `OPENAI_API_KEY` is configured. Consume it through the backend at model integration; never read back or print the value. Local persistence verification used PostgreSQL 16.15; the CI job targets 18.6.
