# Builder numerical scenario previews

Updated 2026-09-14: new guarded previews use zero LP fees only. The historical
fee calculation below does not establish safe Guard composition; see the
[fee limitation](BUILDER-FEE-GUARD-LIMITATION.md).

Verified 2026-09-13. This adds the ninth application tool, `previewScenarios`, and an immutable PostgreSQL preview history. It is a mathematical model of the decoded recipe, including the fixed LP input fee, under explicit assumptions. Live wallet inventory, actual report authorization, a router quote and settlement remain separate results.

## Calculation and boundaries

The Node adapter `aqua-executor/builder-preview` validates the public draft, runs the deterministic compiler, independently decodes its order and calculates with bigint. Ordinary Solidity uint256 arithmetic is checked; `Math.mulDiv` permits its 512-bit intermediate. The implementation retains integer square-root, ceiling/floor and operation order from these pinned sources:

- [XYCSwap](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/XYCSwap.sol)
- [XYCConcentrate](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/XYCConcentrate.sol)
- [PeggedSwap](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/PeggedSwap.sol) and [PeggedSwapMath](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/libs/PeggedSwapMath.sol)

Each named scenario resets to the stated allocation. Trades inside a scenario are sequential; refused trades leave the modeled inventory unchanged. `tokenIn: base` means the taker supplies base, so the Maker receives base and pays quote. Both input and output token caps apply. Post-balance caps use actual Aqua inventory, including the remaining output token, rather than CLMM pricing reserves. Zero-output rounding, empty reserves, arithmetic overflow, Pegged price boundaries and insufficient actual output inventory are refusals. The displayed execution price is an exact rational in human quote/base units; it is not an external market price.

The model assumes an active, unrevoked, bidirectional Guard report equal to the public envelope. Real reports can be tighter or inactive. It does not check wallet funds, allowances, gas, CRE policy, registration or routing. Future-time/deadline scenarios remain in the separate lifecycle engine. Valid input requires an unexpired program deadline; a mathematical preview does not evaluate a trade after that deadline.

Maker previews use saved allocations only. A Provider comparison requires explicit hypothetical allocations; these never enter its template draft. A local compiler projection supplies an internal placeholder identity solely to derive and decode parameters. No compiled artifact, order hash, bytecode, executable export or registration plan is returned or saved for that projection. Relative CLMM templates still require a fixed price snapshot before numeric evaluation; snapshot acquisition is pending.

**Pegged allocation semantics:** the current Builder uses initial allocations as the reference balances. Under this mapping the initial marginal price follows the allocation ratio; `referencePrice` normalization alone does not independently set it. For example, a 0.007 WETH / 30 USDC hypothetical allocation with `referencePrice=2500` and amplification 1 returned 0.427553 USDC for 0.0001 WETH, or 4275.53 USDC/WETH. The tool returns this observation and the actual model explained it. A target-price requirement must be checked against the resulting amounts; it is not satisfied merely by filling the reference-price field. Redesigning reference balances or selecting compatible allocation ratios remains a separate domain decision in the full Builder work.

## Persistence, API and model

Migration 006 adds `builder.scenario_previews` with an owned revision foreign key, immutable input/result payloads and digests, engine/manifest binding, indices and a unique revision/manifest/engine/input key. The draft lock, request receipt and outbox event commit atomically. An active agent lease is checked before calculation and again before commit. A per-wallet advisory lock serializes a shared limit of 60 new inputs per hour across processes and drafts; deduplicated inputs consume no new allowance.

- POST `/v1/builder/drafts/:id/previews`: `{ expectedRevision, hypotheticalAllocations, scenarios }`. Amounts in this HTTP schema are atomic decimal strings; scenario trades contain `{ tokenIn, amountInAtomic }`. `hypotheticalAllocations` is null for Makers or `{ baseAtomic, quoteAtomic }` for explicit Provider examples.
- GET `/v1/builder/previews/:id`: owned immutable full result with current/stale state.
- GET `/v1/builder/drafts/:id/previews`: the newest 12 summaries, with revision, assumptions source, counts, rejections and final inventory.

POSTs use the existing authenticated session and idempotency key. Clients cannot supply owner, RPC configuration, private policy or executable payloads. Restoring an earlier specification creates a new revision and leaves its previous preview stale. Request retries retain the original receipt.

`previewScenarios` uses human amounts and converts them with the verified token decimals before the repository call. It accepts up to four named scenarios with six trades each; HTTP accepts up to eight with twelve trades each. Names use short ASCII identifiers. `inspectStrategy({ view: 'previews' })` reads bounded summaries, which prevents a history of full scenario payloads from flooding model context. Reopening the conversation does not depend on remembering assistant text.

## Evidence

- [Nine-strategy fork evaluation](builder-previews/fork-evaluation.json): balanced, unequal and reversed WETH/USDC configurations for each of XYC, CLMM and Pegged. All 27 sequential bidirectional integer predictions matched fixed-context router quotes, successful receipts, Maker ERC20 changes and actual Aqua balances. The run used a verified Sepolia fork with synthetic funds/report authority. Source fingerprints are included; there were zero public-chain writes and no source-to-runtime rebuild claim.
- [Five real OpenAI turns](builder-previews/agent-evaluation.json): Provider hypothetical XYC comparison → tighten only the USDC cap and observe both WETH-input trades blocked → restore cap and compare CLMM → compare unequal Pegged allocations and explain reference-price limits → read current/history without mutation. Exact parameters, human-to-atomic conversion, independent scenario resets, successful tool calls and immutable saved results were asserted.
- Native tests match the three previously committed lifecycle settlement traces and cover cap intersections, refusal state preservation, CLMM real-inventory exhaustion, uint256 overflow, template/Maker allocation boundaries and Pegged amplification 0/tiny/5000.
- PostgreSQL tests cover ownership, duplicate requests, immutable results, revisions/restores/manifests, cancelled agent authority, shared budget concurrency, authenticated HTTP and actual AI SDK tool execution. Service suite: 44 passed, one optional network test skipped. TypeScript passes for both packages.

Reproduce the fork check with `ANVIL=/path/to/anvil node contracts/aqua-executor/scripts/eval-builder-preview.ts`. Run the real model check with a privately configured `OPENAI_API_KEY`, local `BUILDER_TEST_DATABASE_URL`, and `node packages/builder-service/scripts/eval-preview-agent.ts`. The latter creates and removes only its own disposable database. Neither script performs public-chain transactions.

This is not complete coverage of all inputs or the full goal. Inventory snapshots, visual preview controls, relative price acquisition, full requirement acceptance, Provider publication, wallet plans, trusted dynamic binding, event delivery and rollout are still required. Protocol/dynamic fee modifiers remain disabled.
