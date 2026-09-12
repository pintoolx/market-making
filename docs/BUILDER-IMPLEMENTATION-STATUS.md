# Builder implementation status

Goal active since 2026-09-13. Scope: [approved goal v2](SWAPVM-BUILDER-IMPLEMENTATION-GOAL.md). Initial main: `167b630`. Worktree: `/home/kuoba123/eth-glo/market-making-builder-impl`; current branch: `feat/builder-simulation-jobs`, based on merged lifecycle PR #60 (`c3beac8`).

| Area | Current state |
|---|---|
| Multi-turn domain | Strict drafts/patches, revision diffs/restoration, PostgreSQL persistence and actual agent implemented. Full intent/artifact requirement coverage remains pending |
| Capability inventory | Every non-reserved Aqua opcode accounted for; unsupported combinations retain specific reasons and distinct readiness evidence |
| Guard recipes | Extended existing V2 compiler to XYC/Pegged; CLMM retained; local actual-router tests pass |
| Compiler/decoder | Three zero-fee curves compile from new Maker drafts; independent decoder checks recipe, traits, target, envelope and parameters |
| Deployment | Fixed-block read verifier refreshed at Sepolia finalized block 11691533; all 6 contracts, Guard/router bindings, token metadata, and USDC implementation address/runtime checked. Source-to-runtime and live recipe gates remain separate |
| Lifecycle simulation | Node adapter runs the exact compiled Maker artifact in an owned Sepolia fork. XYC/CLMM/Pegged each pass 25 named checks, with 11 successful swaps. Durable owned jobs/results, recovery/cancellation, API, eighth agent tool and separate process implemented. Explicit synthetic funding/report authority; no registration readiness. Maker simulation UI, rollout and remaining range/extreme-input coverage pending |
| PostgreSQL/auth | Additive migrations, owned drafts/messages/history, atomic idempotency/outbox, generic jobs, durable design turns, EOA SIWE sessions and HTTP handler. Privy app/user/session verification plus wallet proof implemented; production mounting/migration and application roles pending |
| OpenAI/UI | OpenAI + AI SDK with eight design/preparation tools, streamed public events, bounded workers and replayable HTTP API implemented. Live design/compiler tests plus a five-turn simulation/failure/repair loop passed. Initial Privy-connected chat/summary/revisions workspace tested with browser fixtures; inventory/scenario/wallet preparation tools and Maker simulation UI pending |
| Private policies/template permissions | Existing evaluator reusable; Builder authoring, consent and publication integration pending |
| Wallet/dynamic binding | Pending |
| Event worker/recovery | Pending |
| Fees/modifiers | Pending after zero-fee flow; do not redefine these as completed |
| Cloud/live acceptance/PRs | Core [PR #42](https://github.com/pintoolx/market-making/pull/42) merged at `284613a`; persistence [PR #46](https://github.com/pintoolx/market-making/pull/46) merged at `73c2165`. Both passed GitHub CI and Cloudflare preview. Agent [PR #49](https://github.com/pintoolx/market-making/pull/49) merged at `89aceed`; both GitHub checks passed on final head. Builder rollout and onchain acceptance pending |

Core verification is recorded in PR #42. Builder tests have created only disposable local databases. Real OpenAI requests consumed the user-configured Railway key opaquely through a local process; no Railway business migration or public-chain write was performed. Cloudflare's existing PR/main integration builds the frontend automatically; the new Builder handler is not deployed or mounted yet.

Core baseline verification: Builder 6 passed; executor suite 79 passed / 1 optional Sepolia fork skipped; both TypeScript checks pass. After making exported order traits JSON-safe, the 5 Builder compiler/settlement cases were rerun successfully. A pinned-action CI workflow runs the domain and local Guard suites without secrets or public-chain writes. Later batches and their additional tests are described below.

Continue with the full goal. The original workspace remains on another user's ENS work; do not overwrite it or assume its files match this implementation worktree.

The latest main also contains ENS/monitor/standing-documentation updates and a publication config fix; all are retained. After integrating main, orchestrator verification was 43 passed / 1 optional fork skipped. Two pre-existing interrupted-transaction tests were fixed to compare pending nonces when the transaction is still in Anvil's mempool; all 12 affected tests and final CI passed.

Design follow-up: [service package](../packages/builder-service/README.md) and [live evaluation evidence](BUILDER-AGENT-EVALUATION.md). Current local service verification: 38 tests passed and one optional network case skipped on PostgreSQL 16.15; TypeScript passed; CI targets 18.6. Lease/cancellation/restart, public event replay, numeric history ordering, Date-to-JSON conversion and provider error redaction are covered. The model workflow prepares public drafts, compiled Maker artifacts and background simulations; template publication, private-policy editing, remaining inventory/scenario/wallet tools, trusted dynamic binding and event-driven Guard delivery remain required.

Workspace follow-up: `/builder` now provides public strategy chat, streamed replies, current parameters/validation, version diffs/restoration, cancellation and recovery. Python Playwright passed real API/PostgreSQL tests using fixture Privy identity and a deterministic model, including lost responses, expired sessions and mobile layout. Production Next build and scoped lint passed. The Provider link remains off unless `NEXT_PUBLIC_BUILDER_ENABLED=true`; live Privy/browser acceptance and service rollout remain pending.

Latest-main integration retains wallet-backed taker trading, ENS strategy discovery and the shared page scroll fix from PRs #50/#51. The browser fixture also checks that the mobile user can scroll to version controls and return to the heading.

Workspace PR #53 merged at `9b4253b` after final-head PostgreSQL and Guard CI passed, along with local production build and browser acceptance. Seven additional real OpenAI turns now verify incremental limits, XYC → Pegged → CLMM changes, unchanged constraints and conflict discussion without a mutation. Partial drafts retain missing fields explicitly and remain blocked from compile; direct API patches also reject pair relabeling after amounts or price intent exist. The public compiler is separated from artifact-loading/wallet imports and exported as `aqua-executor/builder`.

Compilation follow-up: migration 004 persists immutable decoded Maker artifacts, deduplicated by revision/manifest and protected by ownership and agent leases. API compile/list/get and the seventh `compileStrategy` agent tool are wired. Reads mark old revisions/restores/manifests stale and always keep registration readiness false pending simulation and wallet gates. Local service suite 28 passed; domain 8 passed; executor 81 passed / 1 optional fork skipped. Provider template preparation and remaining tools are still required.

Actual model compiler acceptance: `eval-design-api.ts --maker-compile` passed five turns through signed HTTP/API/durable worker and real compiler artifacts. It verifies XYC → cap edit → Pegged → CLMM, exact decoded caps, one current artifact and stale predecessors. Allocations are public local fixture inputs; no wallet inventory, public-chain write or lifecycle simulation is claimed. Browser acceptance also passed an initial single-cap draft with missing limits visibly retained.

Latest main includes PR #54’s explicit CRE market-scenario runner and fixture-source guards. These changes are retained; Builder lifecycle simulation has not yet been wired to that runner.

Preparation PR #55 merged at `d759691` after final-head Guard/PostgreSQL CI and Cloudflare preview passed. The standalone [lifecycle evaluator](BUILDER-LIFECYCLE-SIMULATION.md) is the next batch. Its snapshot/receipt handling, exact cap boundaries, report domain/replay/active-switch behavior, wallet/virtual exhaustion, deadline/standing/revoke/dock checks and evidence modes are documented separately. Full goal completion still requires the pending product and deployment gates above.

Lifecycle PR #60 merged at `c3beac8` after exact-head review, GitHub Guard/PostgreSQL CI and Cloudflare preview passed. The integrated main retains PRs #57–#59. Current simulation-service work adds migration 005 and a dedicated worker CLI, with 38 default service tests passing and one optional network case skipped. The separate-process real fork test passed independently. The final live model evaluation passed five turns: enqueue/read success → one-atomic-unit failure → cap restoration and a fresh successful fork → scoped result explanation. This is public, local fixture evidence; Railway business migrations, product mounting and actual wallet/CRE delivery remain pending.
