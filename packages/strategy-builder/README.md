# Strategy Builder core

Browser-safe TypeScript domain models for the multi-turn SwapVM Builder. This package does not hold keys or broadcast transactions. The Node-only compiler adapter lives in `contracts/aqua-executor/src/builder-compile.ts`.

Implemented in this first batch:

- Strict public draft/intent inputs, owner/revision checks, partial updates, readable diffs and restore-as-new-revision. Artifact bindings reject stale confirmations, including after restoring an earlier draft.
- A catalog accounting for every non-reserved instruction in the deployed Aqua opcode table, with separate source, SDK, runtime, composition, product and routing evidence. Unknown/reserved instructions remain rejected.
- Validation of public recipe inputs, fixed ranges, supported token metadata, finite deadlines, allocations and immutable Guard envelopes. Templates and Maker instances are distinct; a template cannot compile before instantiation.
- Deterministic zero-fee XYC, concentrated and pegged compilation through the existing SDK adapter, with an independent bytecode/order decoder. Exported executor params preserve an explicit Guard V2 recipe. Nonzero fees are blocked by the [current Guard limitation](../../docs/BUILDER-FEE-GUARD-LIMITATION.md); historical bytes remain decodable for recovery.
- Local upstream-router/Guard integration tests with mock tokens: both directions, caps, rejected trades, persistent Maker revocation and dock. This is separate from Sepolia evidence.

Run from repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:builder
pnpm typecheck:builder
ANVIL=/path/to/anvil pnpm --filter aqua-executor test
pnpm --filter aqua-executor typecheck
node contracts/aqua-executor/scripts/verify-builder-profile.ts
```

The final command performs read-only RPC calls and writes the fixed-block verification record in `profiles/`. It does not establish source-to-runtime equivalence or authorize a transaction. Model tools must call this domain through an authenticated service, not trust client-provided profiles or owner fields.

Still required by the complete goal: PostgreSQL transactions and ownership service, template permissions and publication, conversation adapter and real OpenAI eval, private policy editor, complete preview/fork jobs, wallet review, trusted dynamic bindings, standing event worker, remaining modifiers, UI, live lifecycle and deployment. `assessRequirements` reports mechanism availability only; arbitrary natural-language requirements are not marked fulfilled until reviewed against actual artifacts.

The core catalog's `productEnabled` means the domain can accept the corresponding mechanism. It does not grant wallet readiness or imply that its UI is already shipped. Runtime verification and routing discovery remain separate.
