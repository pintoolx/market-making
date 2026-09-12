# Builder wallet inventory reads

Verified 2026-09-13. The tenth application tool, `getWalletInventory`, reads an owned Maker wallet from an operator-configured Sepolia RPC. No wallet signer, approval, wrap, ship, report or public-chain transaction is available through this tool.

## One context, separate balances

`aqua-executor/builder-inventory` reads a single numbered latest block, checks that its timestamp is recent (at most 120 seconds old and no more than 30 seconds ahead), verifies the six pinned runtime hashes, Guard/router bindings, token decimals/symbols and Circle USDC implementation, then rechecks the block hash before returning. A chain mismatch, stale block, code/binding change, reorganization or provider failure is an error. Provider URLs and exception metadata are redacted. All RPC operations are reads, with a 30-second overall budget and no database transaction held during RPC.

The result contains native ETH, each token's wallet balance and allowance to Aqua, Guard's selected hash, and actual Aqua `rawBalances` for up to 40 distinct owned artifact hashes. A nonzero Guard-selected hash is also read if it was not in that list. Histories that restore an order's original bytes do not duplicate its inventory. All token arrays retain verified address/decimal identity; reversed draft base/quote pairs resolve by address.

The accounting follows pinned [Aqua](https://github.com/1inch/aqua/blob/9c5c42e5840e8741fba3597c48456c9510212b66/src/Aqua.sol) and [Balance](https://github.com/1inch/aqua/blob/9c5c42e5840e8741fba3597c48456c9510212b66/src/libs/Balance.sol):

- ETH is distinct from WETH. No automatic wrapping occurs.
- `ship` creates virtual inventory; it does not deposit or create wallet tokens. `dock` clears virtual inventory; it is not a token withdrawal.
- Pair counts are distinguished as unregistered, shipped, docked (`255`) or inconsistent.
- The inventory/allowance capacity for one strategy/token is the minimum of its virtual balance, the wallet balance and the wallet's Aqua allowance, and zero for a non-shipped pair. Other trading conditions are not part of this figure.
- Different strategies share the same wallet tokens and Aqua allowance. Their per-strategy capacities must not be summed or described as uncommitted assets.
- The bounded known-hash list is not an exhaustive scan of other Aqua apps or outside commitments. `commitmentsComplete` and `registrationReady` remain false.
- A Guard-selected hash is not proof of a valid report or successful settlement. A docked strategy can remain selected. Curves, caps, report state, deadline, transfer behavior and gas impose additional conditions.

The latest block is explicitly unfinalized. These on-demand results are not durable transaction confirmations or fund reservations; plans must capture and revalidate their own fresh preflight context before signing. A stored assistant reply is not a wallet-state artifact. This batch adds no database migration.

## Ownership, API and configuration

The repository derives the Maker from an authenticated owned draft, rejects Provider templates, validates the expected revision and reads only owned, integrity-checked artifacts for the pinned manifest. After RPC it rereads the current draft and any agent lease. Edits and cancelled/expired agent authority prevent late results from being accepted as current. Adapter results must match the Maker, chain, manifest, engine and verified token metadata. Test sources remain explicitly `mock` or `fork-with-overrides`.

GET `/v1/builder/drafts/:id/inventory?revision=<number>` uses the existing Privy/EOA session. It accepts no wallet address, RPC URL, alternate block, mode or other query parameter. The route is unavailable unless the server receives a trusted `inventoryAdapter` dependency. It limits reads to 120 socket-address attempts per minute per HTTP process and eight simultaneous reads per reader. Deployment ingress still needs shared limits across replicas. Model turns retain their separate shared PostgreSQL budget and bounded tool loop.

Wire `nativeInventoryAdapter(profile, { rpcUrl })` into `builderHandler` and `runDesignTurn` through server configuration. The design worker CLI enables this adapter only with `BUILDER_INVENTORY_ENABLED=true`; `BUILDER_INVENTORY_RPC_URL` is optional and defaults to publicnode. The CLI also forwards `BUILDER_SIMULATION_ENABLED=true` to its existing background-simulation tool; a separate simulation worker must be running. These options are never supplied by model tools or HTTP clients. Runtime secret values are not logged.

`getWalletInventory({ expectedRevision })` reports actual per-token allocation sufficiency and allowance sufficiency separately. Provider templates use hypothetical numerical previews instead. Builder chat activity labels now distinguish reading assets, calculating scenarios and queueing lifecycle simulation. Dedicated Maker inventory/review controls and production mounting remain pending.

## Verification

- Native failure tests check manifest mismatch and cancellation before RPC, operator URL redaction, wrong chain, stale block and substituted code using read-only RPC methods.
- The optional actual Sepolia test passed with the current read adapter, checking all six contracts and both tokens without a wallet signer or public writes. A separate read of the user's previously supplied Maker address also succeeded; that address was not used to sign or send transactions.
- The [fork evaluation](builder-inventory/fork-evaluation.json) passes five reads across unregistered → two shipped strategies with zero allowance → approved shared inventory → a selected hash absent from the supplied catalog → docked-but-still-selected. It verifies no deposit/withdrawal is inferred, duplicate hashes are read once, and two strategy capacities share one wallet balance. Source fingerprints and explicit synthetic mode are retained.
- The [real OpenAI evaluation](builder-inventory/agent-evaluation.json) passes three signed-local-HTTP/PostgreSQL turns with actual Sepolia reads of a fresh unfunded Maker. The agent reports zero balances/allowances, distinguishes ETH/WETH and virtual accounting, then reduces only USDC allocation and rereads without claiming executable funding. The discussion-only turn performs no read or edit.
- PostgreSQL/service tests cover owner isolation, known-hash deduplication, metadata/result binding, late reads after an edit or cancellation, RPC redaction, the authenticated disabled/enabled route and actual AI SDK tool execution. The full service suite passes 49 tests with one optional network skip. Native and service TypeScript checks pass.

Reproduce native reads with `BUILDER_INVENTORY_TEST_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com node --test contracts/aqua-executor/test/builder-inventory.test.ts`. The isolated accounting check is `ANVIL=/path/to/anvil node contracts/aqua-executor/scripts/eval-builder-inventory.ts`. The real model check is `node packages/builder-service/scripts/eval-inventory-agent.ts`, with private server-side OpenAI configuration and a local `BUILDER_TEST_DATABASE_URL`; it removes only its own disposable database.

Wallet preparation/cancellation tools, Provider/Maker product flows, transaction-bound preflight snapshots, trusted authorization, event delivery, LP fees and platform rollout remain required by the active full goal. None is established by an inventory read.
