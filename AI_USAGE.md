# AI usage

The team used AI coding assistants during product design, implementation and documentation. All generated changes were reviewed by team members and validated with the repository's automated checks.

## Tools

- **OpenAI Codex** assisted with the Aqua executor, Guard contracts, orchestration service, strategy templates, test coverage and technical documentation.
- **Claude Code** assisted with the web application, the initial confidential workflow implementation, repository setup and UX iteration.

## Human responsibility

The team defined the product, privacy model, strategy semantics, execution constraints and user experience. Team members selected dependencies, reviewed generated code, operated deployments and verified public-chain results. AI output is not treated as an authority for protocol behavior or security.

## Verification

- Aqua and SwapVM contracts are built from pinned upstream sources.
- Guard report encoding is checked against a shared golden fixture.
- Contract behavior is covered by unit and Anvil integration tests.
- Ethereum Sepolia addresses, receipts and state checks are published under `contracts/aqua-executor/docs/` and `contracts/aqua-executor/records/`.
- Chainlink simulation, project-owned forwarding and production DON delivery are described as distinct trust profiles.

The privacy policy and terms of service require legal review before a production launch.
