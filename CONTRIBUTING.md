# Contributing

Use English for website copy, default AI responses, documentation, code comments,
errors, committed test fixtures, commit messages and pull requests. Keep labels
and errors natural for the person using the product. Technical detail belongs in
an appropriate inspection view or developer documentation.

Run `pnpm check:english` before submitting changes. This catches accidental CJK
copy in tracked text; it does not replace an editorial review. Runtime user input,
wallet/ENS names and imported external data may be multilingual. Do not rewrite
user data to satisfy repository copy policy.

Update tests that depend on visible labels when changing copy. Review longer
English labels on mobile as well as desktop. Do not replace actual capability,
network or verification status with unsupported claims.

Recorded evaluation evidence must retain provenance. If prompts, replies or
human-readable payload fields are translated or summarized, label the edited
representation and link to the original commit. Preserve original numeric results
and cryptographic identifiers; use the original record for byte-exact verification.
A translation is not a newly executed evaluation.

Keep changes reviewable, run checks appropriate to the affected packages, and
state which integration or deployment checks were actually performed. Exclude
credentials and workstation-specific paths from committed documents and PR text.
