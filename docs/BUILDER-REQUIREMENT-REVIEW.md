# Builder requirement review

Natural-language requirements from a strategy conversation are converted by
the agent into public, reviewable criteria. Criteria describe public strategy
values or checked mechanisms; they never contain private policy, ciphertext,
wallet signatures or an authorization claim.

Each requirement requires an explicit user decision:

- `confirm`: accept this concrete interpretation. Parameters must match the
  current draft; a mechanism description records the intended scope and does
  not mean a report was delivered.
- `accept-limitation`: explicitly accept a limitation that the service cannot
  implement or that the current value does not satisfy. The service records a
  traceable draft marker; the agent cannot set it automatically.

The service stores an immutable review intent and receipt in PostgreSQL,
binding owner, draft, revision, public content digest, deployment manifest and
review engine version. Editing or restoring a draft invalidates the receipt for
the current version. A waiver that creates a new revision must pass the later
compile and wallet gates again.

The HTTP interface is mounted under `/v1/builder`:

```text
POST /drafts/:draftId/requirement-review
GET  /drafts/:draftId/requirement-review?revision=N
POST /requirement-reviews/:reviewId/confirm
```

Prepare returns the public review and digest; confirm accepts only `digest` and
one decision per requirement. Requests still require the existing wallet
session, owner scope and idempotency key. Provider publication with requirements
needs a receipt for the current revision first. Maker compile, simulation and
future wallet registration remain separate gates.

The four evidence levels are shown separately: `onchain_enforced`,
`preflight_only`, `informational` and `unsupported`. Guard directions and
per-swap/inventory caps are the intersection of the program and report;
comparing a curve or allocation is not a live market observation, reserved
funding or a daily quota. A matching criterion also does not prove CRE delivery,
a standing report, Aqua ship or a completed trade.
