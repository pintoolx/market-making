# Provider policy editor and Maker template workspace

The existing `/builder` page now connects the signed publication/instance API to the browser. Providers can design a public strategy with the agent, open a separate private policy editor, choose Maker parameter permissions, review a version and sign its publication. The version catalog verifies Provider signatures locally before Maker application or withdrawal. Applying a version opens a Maker conversation with exact allocations, immutable pin and original-baseline permissions. It remains a design workspace; wallet execution, policy authorization and event delivery are later gates.

## Private authoring boundary

The editor supports one to eight ordered rules. Each rule can specify inclusive price and volatility lower/upper bounds, Maker buy/sell directions and both token amount caps. Global private inventory ceilings are separate. It shows the first-match behavior and paused fallback, accepts zero caps for intentional pauses, and rejects an unconditional rule before later rules because those rules would be unreachable. Reordering retains rule identity.

Human amounts convert exactly with the verified base/quote decimals. Base remains workflow token0, including a reversed-address pair; it is not resorted by address. Prices are positive decimals with at most eight places, matching the current workflow's fixed-point precision without truncation. Volatility uses nonnegative safe integer bps. Invalid/inverted conditions, excess precision, public-envelope overruns and duplicate rule IDs fail before any HTTP request. Serialized plaintext plus the 16-byte authentication tag must fit the existing 4096-byte envelope limit.

The wire format is the existing Provider strategy v1, including its required legacy `ttlSec: 600`. The standing Maker v3 evaluator ignores that legacy TTL and produces standing report v2. The UI offers no periodic renewal or expiry claim: events drive reevaluation, and idle standing authorization may remain valid.

Private plaintext exists only in React state and local conversion/encryption temporaries. It is not placed in a conversation, model input, tool result, public stream, browser storage, URL or ordinary API request. The explicit `@pintool/strategy-builder/private-policy` subpath is separate from the public domain entry point; application agents do not import it. The existing browser sealer uses the operator public key in a verified publication intent and Provider-address AAD. Only the envelope is posted. Closing the dialog, changing draft/wallet, successful publication or session expiry unmounts/clears the form. This is application-state clearing, not a claim that JavaScript can physically erase browser memory.

The editor is initialized with public caps and both directions disabled. The Provider must review these visible settings; it does not silently grant bidirectional trading. Private errors are rendered in this dialog, not forwarded into the agent or public event log. The server's status remains `encrypted-unverified`: browser sealing and local syntax validation do not establish DON/TEE verification.

## Review and recovery

Before sealing, the browser checks the intent against the visible draft revision, content, full public spec/requirements, permissions, Provider wallet, chain/manifest, origin, encryption key commitment and strategy ID. It rejects expired or mismatched intents. After sealing it presents the exact EIP-191 message and waits for a distinct user click to request a wallet signature. No model tool signs or publishes.

An uncertain publication response retains the same envelope, signature and idempotency key. Retrying confirms the same publication without another signature or version. A stale review acquires a new intent after explicit review; closing a stale dialog reloads the public draft. Authentication failures return to wallet proof and clear the private editor. Closing while a signature is still pending prevents a later callback from posting it; a request already sent can still commit and must be recovered from the version catalog.

The catalog exposes version identity, Provider, curve, public caps, requirements and parameter permissions. It independently reconstructs the signed message and verifies the exact digest/signature. It rejects changed versions or unsigned replacement parameters. Historical/withdrawn versions remain inspectable. A Maker enters both allocations and a personal title, then explicitly creates an owned instance; no asset transaction is performed. A lost instance response is retried with the same request key/input, with fields locked while the result is uncertain. The resulting conversation can narrow permitted bounds, preserve allocations and restore prior revisions through the same agent tools.

Provider withdrawal requires another explicit checkbox and wallet signature. The screen explains that it closes the version to new instances and does not itself revoke existing standing authorization. Public status is refreshed when returning to the workspace. `GET /drafts/:id/template-context?revision=N` exposes only authenticated public baseline/permissions and checks the owned revision; it has no private-table read.

## Verification

Verification uses actual browser components, the real HTTP/store/agent-tool layers and disposable local PostgreSQL. Identity, wallet and model are fixtures. The fixture workflow decryption key is generated in the local test process, never sent to the browser or recorded in artifacts. The existing workflow decryptor, schema and `computeAuthorization` verify the posted ciphertext and ordered pause/buy/sell cases, including standing report v2. This is explicitly local fixture decryption/evaluation, not a TEE or live-chain claim.

- Domain suite: 14 tests passed, including exact private encoding, reversed token order, all validation boundaries and the ciphertext-size ceiling.
- Service suite: 59 passed, one optional network case skipped; the new template-context HTTP read checks owner/revision and rejects query injection.
- Browser public-review unit tests: 2 passed, rejecting substituted draft/permissions/origin/key/version and invalid Provider signatures.
- Existing browser acceptance passed: multi-turn edits, restored caps, cancellation, lost turn responses, reconnection, session expiry and mobile/partial drafts.
- New browser acceptance passed: ordered private editing and local rejection, exact encryption/evaluator compatibility, no plaintext in outgoing API bodies or browser storage, single-signature publication retry, clear-on-close, idempotent Maker creation, pinned conversation edits, signed withdrawal, review/session expiry and mobile overflow checks. Screenshots contain only synthetic test inputs.
- Production static Next build and scoped Builder lint passed. Frontend now imports the pure public domain package; its TypeScript target is ES2020 with TS-extension imports enabled for shared bigint verifiers. No server compiler, wallet signer or OpenAI key is bundled.

Reproduction from the repository root after installing the frontend and Builder workspace dependencies:

```sh
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/private-check.mjs --bundle --platform=node --format=esm --outfile=.cache/builder/private-check.mjs
pnpm --package esbuild@0.28.2 dlx esbuild packages/builder-service/test/browser/entry.jsx --bundle --format=esm --platform=browser --jsx=automatic --conditions=style --external:/hero.svg --outdir=.cache/builder/browser '--define:process.env.NEXT_PUBLIC_MANDATE_API_URL="http://127.0.0.1:3311"' '--define:process.env.NEXT_PUBLIC_CONFIDENTIAL_WORKFLOW_PUBLIC_KEY=undefined' '--define:process.env.NODE_ENV="development"'
# Set BUILDER_TEST_DATABASE_URL to a disposable localhost PostgreSQL service.
node packages/builder-service/test/browser/server.mjs
# After the fixture reports ready, run sequentially from another terminal:
python3 packages/builder-service/test/browser/run.py
python3 packages/builder-service/test/browser/templates.py
node --test frontend/test/builder-publication.test.mjs
```

The baseline browser script expects a fresh fixture database. Stop the fixture with SIGTERM after testing; it removes only the database it created. Bundle/output artifacts stay under ignored `.cache/builder/`. The fixture routes and public test wallet are absent from the production application. A future CI browser job must install the frontend dependencies and perform both fixture builds, rather than treating the service-only test job as browser coverage.

## Remaining full-goal gates

The new UI is backed by the migration 007 application boundary; it does not add a business database migration. Production role isolation, actual Privy browser acceptance and service mounting/feature enablement are still pending rollout. Dedicated inventory/simulation/wallet review controls, complete requirement-to-artifact acceptance, Maker private limits and automation consent, trusted dynamic bindings, real CRE delivery, event/recovery workers, fee/modifier verification and Sepolia lifecycle acceptance remain required. Provider withdrawal still needs consent-aware paused delivery for existing instances. None is established by publishing an encrypted design template.
