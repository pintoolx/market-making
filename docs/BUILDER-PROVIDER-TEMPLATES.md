# Builder Provider versions and Maker instances

Verified 2026-09-13. Migration 007 adds signed immutable Provider publications and Maker instances to the Builder PostgreSQL model. This is an application publication and design boundary. Publishing or applying a template does not register Aqua liquidity, authorize Guard, verify decrypted policy, or send a chain transaction. The legacy CLMM JSON registry remains separate and unchanged.

## Publication

1. The authenticated Provider prepares a complete owned template draft, expected revision and explicit parameter permissions. A new series receives a server-generated ID; subsequent versions require ownership of the existing series. An immutable five-minute intent pins the draft content, full public specification, requirements, profile, next version, application origin and public encryption key.
2. The separate browser editor will encrypt its policy for the intent's public key using the existing x25519 / HKDF-SHA256 / XChaCha20-Poly1305 format. Provider AAD is `pintool/confidential-envelope/v1|provider=<lowercase-address>`. The plaintext policy's strategy ID must be `<templateId>.v<version>`. The policy editor is the next product batch; this API never accepts plaintext rules.
3. The wallet signs `publicationMessage(intent, envelope)`, an EIP-191 message that includes the entire public version and its encrypted-policy commitment. The API verifies this exact signature, owner, origin, manifest, encryption key, intent expiry and unchanged source revision before committing the version, private ciphertext and outbox event atomically.

`policyEnvelopeSchema` accepts only the workflow-compatible envelope shape: version 1, 32-byte ephemeral public key, 24-byte nonce and an even-length 16–4096-byte ciphertext. No plaintext, token address override, RPC, arbitrary owner, signature source or Maker field is accepted. Versions preserve a public ciphertext digest, not a hash of low-entropy plaintext thresholds. EOA wallet support matches the current Builder authentication boundary.

The operator must configure a public workflow encryption key explicitly. There is no Builder fallback key. Key ID is `digestJson({ algorithm, publicKey })`; envelope and version digests use the domain package's canonical JSON. This new commitment is not automatically interchangeable with the legacy workflow's `keccak256(JSON.stringify(envelope))` binding. The future trusted delivery adapter must verify the publication and construct the workflow's required binding explicitly; it must not disable the existing strategy/provider/envelope checks.

The service cannot decrypt or validate an encrypted policy. It reports `policyStatus: encrypted-unverified` and `registrationReady: false`. That is a deliberate prerequisite for later trusted workflow validation, not proof of DON/TEE execution. Public version reads include the original intent, exact signed message and signature, so the wallet proof can be verified without disclosing ciphertext. Private editor/browser encryption and dynamic workflow delivery remain separate work.

## Maker permissions

A Maker chooses an exact template ID, version and digest, supplies both public allocations and optionally a personal title. The authenticated wallet supplies the Maker address; fresh salt, conversation and revision 1 are generated server-side. The signed public version and immutable resolved baseline are stored separately from subsequent draft revisions. Provider-side accepted alternatives are reset for the Maker.

Default Provider permissions allow tightening all four Guard caps, shortening the program deadline and narrowing CLMM bounds. Checks always compare with the original publication, so a Maker can return from a tightened value toward the original limit without crossing it. Pair identities, profile, curve kind, fee and modifiers remain fixed. Personal title and allocations are Maker-editable; allocations still undergo compiler validation against the current public envelope. Pegged reference-price and amplification values are locked unless the Provider explicitly publishes inclusive ranges; amplification cannot exceed 5000.

Both API edits and the actual agent repository apply these checks. Historical restoration creates a new revision, retains the same pin and checks the restored parameters against that original baseline. The ordinary pure patch function still rejects pinned specification edits unless the application supplies authenticated stored template context. New Provider versions never retarget existing Maker drafts.

Natural-language requirements remain subject to artifact review. Applying a signed publication is not an assertion that every requirement is implemented or that the user has accepted an alternative.

## Relative CLMM price

Relative Provider ranges require a trusted operator price adapter; the request cannot supply a URL or snapshot. The adapter runs outside a PostgreSQL transaction with a ten-second deadline, then creation rechecks version availability, digest and observation age under the publication-series lock. The resolved pair, price, observation source/time and absolute bounds are immutable; subsequent changes may narrow those fixed bounds, not replace the snapshot or follow a new price.

The included adapter reads the fixed [Kraken ETH/USDC order-book endpoint](https://docs.kraken.com/api-reference/market-data/get-order-book) with `pair=ETHUSDC&count=1`, eight-second timeout, redirects disabled and a 16-KiB response bound. Positive quantities/prices, exact eight-decimal input, an uncrossed book, at most 60-second-old levels, five-second future skew and an upward-rounded spread no greater than 100 bps are required. The midpoint is floored at eight decimals; reversed base/quote pairs use its reciprocal floored at 18 decimals. The snapshot records the older level time so committing later cannot reset the freshness window. Relative bounds round inward at 18 decimals; the compiler independently rounds its sqrt-price bounds inward again.

The source explicitly identifies ETH/USDC as a **market proxy for Sepolia WETH/USDC**, not a market value or redemption guarantee for testnet assets. It freezes a range only. Actual execution also depends on allocations, curve math, Guard authorization and current inventory.

## API and durability

Mounting remains opt-in: `builderHandler(..., { templates: { workflowPublicKey, price: krakenTemplatePrice } })`. Existing authentication, Privy verification when configured, request-size and idempotency rules apply. No model tool publishes, withdraws, seals private policy or creates an instance.

| Method/path under `/v1/builder` | Input/result |
|---|---|
| POST `/templates/prepare` | `{ draftId, expectedRevision, templateId: null or existing ID, permissions }`; returns intent |
| POST `/templates/publish` | `{ intentId, envelope, signature }`; returns public signed version |
| GET `/templates` | Latest 100 version summaries, including withdrawn/expired metadata; no ciphertext or full proofs |
| GET `/templates/:id/versions/:version` | Exact public version, signature proof and current withdrawal status |
| POST `/templates/instantiate` | `{ templateId, version, digest, allocations, title? }`; returns owned Maker conversation/draft |
| POST `/templates/withdraw` | `{ templateId, version, digest, signature }` using `withdrawalMessage(origin, chainId, template)` |

Action receipts replay the original committed response. Reload the version endpoint for current status rather than treating a retry response as a fresh status read. A completed Maker instance retry returns the same instance even after withdrawal, and does not refetch a price. The authoritative transaction still deduplicates concurrent requests. Shared per-owner PostgreSQL budgets permit 30 publication intents and 60 new instances per hour, with retries free. HTTP processes also enforce bounded socket-address limits; production ingress requires shared protection across replicas.

Provider withdrawal is separately signed and irreversible for that version. It locks the same series as instantiation, preventing a new instance from committing after withdrawal wins that lock. Withdrawal preserves existing drafts/history and emits `template.withdrawn`; it **does not itself revoke an existing standing Guard report**. The durable consent/event delivery phase must consume that event and confirm any resulting chain revocation.

Public immutable records live in `builder`; encrypted envelopes live only in `builder_private.provider_policies`. Public catalog, model inspection, requests and outbox records never contain envelope payloads. Publication intents, versions, envelopes, withdrawals and instance baselines reject UPDATE/DELETE. Migration 007 is additive; existing migration checksums and unrelated tables are retained. Production migration and separate least-privilege publication/agent/delivery roles are still pending rollout; schema separation alone is not role isolation when using the test database owner.

## Verification

- Domain tests cover original-baseline limits, multi-turn preservation, exact Pegged ranges, immutable paired relative snapshots and non-bypassable ordinary patches.
- PostgreSQL tests cover signed owner/context/ciphertext binding, stale revision/expiry, concurrent publication, immutable storage, private/public separation, three-curve instance compilation, patch/restore authorization, no automatic version upgrade, price/withdrawal races outside database locks, durable retry, shared budgets and authenticated HTTP routes.
- Price-adapter tests reject stale/future/empty/crossed/wide/malformed data, unknown pairs, excessive precision and oversized/upstream errors. An actual read is recorded in the model evaluation.
- [Four real OpenAI turns](builder-templates/agent-evaluation.json) use local signed HTTP and disposable PostgreSQL: inspect permissions; narrow CLMM, cap and change personal title; refuse an out-of-bounds request without mutation; restore then change only USDC allocation. The signed publication uses synthetic ciphertext and does not claim policy decryption. No public-chain writes occur.

Reproduce with local `BUILDER_TEST_DATABASE_URL` and `node --test packages/builder-service/test/templates.test.ts packages/builder-service/test/template-price.test.ts`. Real model evaluation is `node packages/builder-service/scripts/eval-template-agent.ts`, consuming private server-side OpenAI configuration; it drops only its own disposable database. Private editor/product catalog, wallet preparation, real consent, event-driven delivery, fees and rollout remain required by the full goal.
