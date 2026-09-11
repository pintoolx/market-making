# Aqua executor migration

`pintoolx/market-making` is the primary repository. The existing executor is imported into `contracts/aqua-executor/` through a contracts branch and reviewable commits. Subsequent Guard and workflow integration should build on this package through separate PRs.

## What is available

| Capability | Implementation / evidence |
|---|---|
| Pinned Aqua + SwapVM v1.0.2 deployment, XYC encoding, approve / ship / swap / atomic rebalance / dock | Package `src/`, `artifacts/` and [Base Sepolia lifecycle evidence](../contracts/aqua-executor/docs/base-sepolia-demo.md) |
| Loss relative to the original HODL inventory, Chainlink reference prices, rebalance tracking and automatic dock | [Monitor behavior](../contracts/aqua-executor/docs/risk-monitor.md) and [historical testnet evidence](../contracts/aqua-executor/docs/risk-monitor-sepolia.md) |
| Validated JSON requests, persisted signed transaction intents, process locking and restart recovery | [Execution and recovery](../contracts/aqua-executor/docs/execution-recovery.md); local Anvil tests include actual process termination |
| CRE report authentication, `onReport`, an Extruction Guard and Guard-rejected swap | Pending report-format agreement and implementation |
| Frontend activation, production wallet signing and Provider profit-sharing settlement | Pending integration |

The local `aqua-execution-v1` JSON request is an executor command, not the workflow-to-Guard report. A `meta.producer: "tee"` string does not prove attestation. Existing loss monitoring reacts after observing inventory changes; it does not enforce a maximum loss inside each swap.

The imported program targets SwapVM **v1.0.2**, whose instruction table differs from the upstream `main` used in parts of the earlier research. Guard work must use the pinned router source and add encoding and swap tests against that version.

## Run from this repository

Use **Node 24+**, **pnpm 10.6.2** and **Anvil** for executor development. Node 24 is required for the built-in SQLite journal. The frontend retains its own build commands and Node 22 Pages setting; running contracts tests is a separate operation.

```bash
# At the repository root
pnpm install --frozen-lockfile
pnpm typecheck:contracts
ANVIL=/path/to/anvil pnpm test:contracts

# Schema-only validation: no RPC or signing
pnpm --filter aqua-executor run execute --request examples/ship-request.json --validate

# Other package scripts run from their package directory
cd contracts/aqua-executor
cp .env.example .env
# Set local values in .env before commands that need them.
pnpm run execute --network base-sepolia --session session-123 --status
```

All package paths, including `.env`, deployment files, records and `.state/`, resolve inside `contracts/aqua-executor/`. Install with the root pnpm lock. The imported documentation's `npm run <script> -- ...` commands also work with these installed dependencies; do not run a second `npm install` in the package.

The shipped `examples/ship-request.json` is a schema example. An actual activation needs the Maker's intended parameters and fresh identifiers / deadlines. Existing Base Sepolia deployment addresses can be reused; the import does not deploy contracts or run any testnet transactions.

The original workspace's `.env`, `.state/`, `.cache/`, `node_modules/`, local-chain deployment and records are excluded. Keep an existing controller journal and signer configuration together: pending transactions must be recovered using their original state directory. Do not start independent old and new controllers with the same accounts. Historical public JSONL files are evidence, not recovery journals.

## Source provenance

The source was the existing `aqua-executor` working directory at migration time, based on local HEAD `a4817a09d6330834a94ae3c278d81b7f34885ed9`, plus the completed loss-monitoring and JSON-recovery work that had not yet been committed. Those later features are recorded as new commits in this repository. This is a file import, not a claim that the original commit graph has been merged; the original repository is retained.

| Original local commit | Work |
|---|---|
| `af882bf6f3637a9e76c23d92e06af70d32ef708a` | Package and strategy encoding |
| `c834b79bdcc1ebc810e2327beadaa3d775b5d902` | Pinned contract artifacts |
| `96451f9ddff205af23866036786aafa0769a6889` | Executor, deployment and records |
| `c3b197bbedf876453a5c947313892a35b188cfd7` | Lifecycle and atomic rebalance |
| `b996ded7f33095d40a746dce29a95a61385d44c1` | Anvil lifecycle / misuse tests |
| `707a52ac3309bb1837ba0b239053588991c0e3fc` | Execution and interface documentation |
| `a4817a09d6330834a94ae3c278d81b7f34885ed9` | Base Sepolia evidence and handoff |

Runtime source, tests, contract artifacts and public deployment / transaction evidence are copied unchanged. Workspace integration changes package placement, dependency installation and documentation. Existing frontend dependency snapshots are retained in the pnpm lock; the executor adds its own pinned viem 2.56.3 and SwapVM SDK 0.4.4.

The [historical risk source manifest](../contracts/aqua-executor/docs/risk-monitor-source.sha256) remains unchanged. When verifying it, map `package.json` to `docs/source-snapshots/risk-monitor-package.json` and `package-lock.json` to `docs/source-snapshots/risk-monitor-package-lock.json`, relative to the executor package. Other manifest entries keep their relative paths. The archived npm lock describes the historical testnet run, not current workspace installation.

## Validation scope

Migration validation: frozen pnpm installation passed on Node 24.14.0 and Node 22.20.0; executor typechecking and **31/31** unit / Anvil integration tests passed on Node 24; the schema-only CLI example passed. All 46 imported runtime, test, artifact and public evidence files matched the source, and all 21 historical manifest entries matched using the archived package files.

Frontend static builds completed with exit code 0 on Node 24 and Node 22. Both emitted the pre-existing ESLint `@typescript-eslint/no-unused-expressions` / `allowShortCircuit` error. The same lint failure was reproduced from clean main commit `3a553c8` with the retained frontend dependency versions. This import does not fix that separate frontend toolchain issue; a successful static build does not mean frontend lint passed. All existing pnpm dependency snapshots and frontend source files are unchanged.

Public Base Sepolia evidence predates the resumable JSON controller: P0 covers 13 lifecycle transactions; the two risk demonstrations cover another 26 transactions. Recovery guarantees are tested locally with Anvil and must not be inferred from those older public records.
