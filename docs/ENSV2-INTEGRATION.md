# ENSv2 strategy publishing

PinTool uses ENSv2 on Ethereum Sepolia to discover signed Provider publications and delegate updates to their public version pointer. A Maker selects a specific immutable release. Updating the ENS entry never silently changes an existing mandate's publication or Aqua program hash.

## Product flow

1. Open `/ens/setup` with the platform owner wallet. The default namespace is `pintool.eth`; set `ENS_ROOT_NAME` on the mandate service to use a different available 3–32 character ASCII `.eth` name.
2. Prepare registration: deploy official UserRegistry and PermissionedResolver proxies through the ENS VerifiableFactory, obtain the free ENS MockUSDC fee token, approve the registrar's quoted fee, and submit the commitment. The browser saves only this public registration plan and reveal secret, keyed by chain, root and wallet, so the remaining steps can resume after a reload.
3. After the registrar's commitment waiting period, register the name. Then enable Provider names: deploy PinToolNamespaceRegistrar, grant it only `ROLE_REGISTRAR` on the platform registry, and publish its address in the root's `fun.pintool.registrar` record. These steps require the platform owner wallet's confirmations. Merely opening a page sends no transactions.
4. A Provider opens `/ens` or the ENS panel below the CLMM editor, claims `alice.pintool.eth`, and receives a separate UserRegistry and PermissionedResolver. The registrar supports one Provider label per wallet. Names expire with the platform's current registration; the standard claim does not grant transfer rights. The platform retains parent administration.
5. Publish a CLMM version using the existing signed, encrypted publication flow. In the ENS panel, choose a strategy label such as `eth-usdc`, then **Approve version for ENS**. This registers the strategy subname if needed and signs a separate public manifest.
6. **Publish approved version** writes the record onchain and reads it back. Maker search and the `/maker?ens=eth-usdc.alice.pintool.eth` link resolve and verify that name.
7. Optionally authorize a separate publisher wallet for the one `fun.pintool.release` text key. That wallet can use **Publish as delegate** on `/ens`, or run the standalone publisher service. Revoke it in the Provider panel; the UI verifies that no broader grant still permits updates.

The standard ENS fee token is distinct from Circle's Sepolia USDC used by Aqua. Platform setup does not approve Maker trading tokens. Public test funds are required for gas. The application does not possess a platform owner key.

## Verification and data

The ENS value is a single JSON text record, avoiding inconsistent reads across separate version/digest keys:

```json
{
  "schema": "pintool-ens-release-v1",
  "chainId": 11155111,
  "provider": "0x…",
  "releaseId": "<provider-address-without-0x>-clmm",
  "version": 1,
  "publicationDigest": "0x…"
}
```

These are PinTool application fields, not a new ENS standard. Private thresholds, Maker limits, ciphertext and the original ciphertext-bearing signature are never put into ENS or the public manifest API. A separate Provider signature commits to the normalized full name, pointer and hash of the canonical public release fields.

The backend checks the original publication signature and digest against its private version store, then checks the independently signed public manifest. The browser independently checks that public signature and reads canonical ENS through its own Sepolia RPC. Consequently the backend cannot replace public execution fields while retaining a valid manifest signature.

Registry traversal verifies the live `.eth` parent, platform subregistry, the pinned registrar's runtime code and immutable bindings, factory provenance of standard ENSv2 proxies, registration status/expiry, Provider and strategy ownership, and current resolver. Reads within a resolution use one recent block. The library discovers the canonical Universal Resolver; application code does not pin an implementation address as the resolver entry point. Writes look up the current resolver before simulation.

`POST /v1/mandates` accepts optional `ensSelections`, and the execution-profile endpoint accepts `ensSelection` when explicitly adding a newly reviewed version. Before invoking the runner, the service resolves the name again, compares the exact reviewed pointer, rejects withdrawn or unprovisioned versions, and verifies the catalog digest and Maker wallet. It persists the verified ENS selection with block/hash evidence. A later get/refresh carries those selections forward and remains read-only. Re-evaluating an existing standing mandate retains its original ENS version without following a newer ENS record; runner output cannot replace the saved selection. The existing runner still enforces publication/workflow/program bindings.

ENS publication does not itself compile, provision, ship, authorize or dock a Maker strategy. A named but unprovisioned release is reviewable and remains unavailable for execution until the existing onboarding gates pass. Automatic Maker provisioning remains part of the separately planned Strategy Builder. Revoking ENS publishing rights prevents future record writes; it does not revoke a Guard report already accepted onchain.

## API

| Endpoint | Purpose |
|---|---|
| `GET /v1/ens/config` | Platform name and ENS chain |
| `GET /v1/ens/status?provider=0x…` | Verified platform and optional Provider namespace |
| `POST /v1/ens/manifests` | Save a Provider-signed public manifest for an existing immutable release |
| `GET /v1/ens/manifest?name=…&releaseId=…&version=…` | Exact approved public manifest |
| `GET /v1/ens/latest-approved?name=…` | Latest published version, only when separately approved for that name |
| `GET /v1/ens/resolve?name=…` | Current canonical ENS pointer and verified manifest |
| `GET /v1/ens/names?provider=0x…` | Names from the public manifest index, with current verification status |
| `GET /v1/ens/delegation?name=…&delegate=0x…` | Effective text-key access, including broader grants |

Manifest files are separate from immutable Provider release files under `MANDATE_STATE_DIR/ens-manifests`. They are atomically created and contain public data only. The index never treats token IDs as stable identifiers; filenames use full namehash and publication digest. Root names are currently restricted to the configured platform namespace; external names, alias management, registration renewal UI, and ERC-1271 Provider publication signatures are not included.

## Configuration and publisher

The mandate service reads `ENS_ROOT_NAME` (default `pintool.eth`) and `ENS_SEPOLIA_RPC_URL`. The frontend's optional `NEXT_PUBLIC_ENS_SEPOLIA_RPC_URL` is a public build setting. Both RPCs must actually serve chain 11155111. Standard contract addresses and ABI source hashes are pinned in `shared/ens/deployments.json` to ENS contracts-v2 commit `97a57293f3b4279d94b571e678edb53ce62638f4`; recheck them when upgrading the beta.

The optional publisher is a separate process:

```bash
# Supply configuration through your process manager/secret store, never browser NEXT_PUBLIC variables.
# ENS_PUBLISHER_PRIVATE_KEY: a dedicated, funded publisher wallet
# ENS_PUBLISHER_NAMES: comma-separated allowlist, e.g. eth-usdc.alice.pintool.eth
# ENS_PUBLISHER_API_URL: this mandate API's HTTPS URL, or localhost
# ENS_ROOT_NAME, ENS_SEPOLIA_RPC_URL, ENS_PUBLISHER_INTERVAL_MS (minimum 30000)
pnpm start:ens-publisher
# Single checked update pass:
pnpm start:ens-publisher --once
```

Run one publisher process per signer. It reads the latest approved version, verifies the public signature and effective key permission, checks the current ENS pointer, and publishes sequentially. It skips unchanged versions and revoked grants, refuses rollbacks, and checks approval again before delivery. Failed resolution/signature/approval checks prevent writes. Restarting compares actual chain state, so it does not blindly replay an old update. This process has no Maker key, private policy input, or Guard privileges. Its logs contain public names, status codes and transaction hashes only.

The Docker image links its installed viem dependency at `/workspace/node_modules` so modules in `shared/ens` resolve correctly; no new private key is required by the main mandate service.

## Validation

```bash
SOLC=/path/to/solc-0.8.30 pnpm build:ens
SOLC=/path/to/solc-0.8.30 node scripts/ens/build-contract.mjs --check
pnpm test:orchestrator
pnpm --filter ./frontend exec tsc --noEmit
pnpm build

# Dedicated local fork only. The test rejects non-loopback RPCs and requires Anvil.
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 18547
ENS_FORK_RPC_URL=http://127.0.0.1:18547 pnpm test:ens
```

The fork test uses actual official Sepolia registry/resolver/factory bytecode. It registers a new platform name, provisions a distinct Provider, saves signed releases through the real HTTP API, resolves them, updates v1→v2 through the publisher process logic, and checks actual reverted transaction receipts for forbidden address/description writes and writes after revocation. It also checks parent-pointer invalidation. It uses public synthetic identities and reverts its Anvil snapshot afterward. These are local fork transactions, not new public Sepolia transactions or CRE/TEE evidence.

The independent service tests cover invalid name/chain/provider/version inputs, ciphertext exclusion, altered manifests, original publication validation, withdrawn versions after republication, missing approvals, conflicting ENS selections, and persistence of Maker pins across later ENS changes.

`scripts/ens/browser-entry.tsx`, `browser-server.mjs` and `browser-test.py` provide a local-only Playwright harness around the production ENS components and actual fork-backed API. The harness deliberately lives outside the Next application and has no production wallet bypass. It exercises Provider claiming, manifest approval, owner/delegate writes, Maker lookup, version updates, revocation, error states, and 375/768/1280 px layouts. Build it with Bun using local API/RPC defines, serve it on 13201, and pass the fixture server's PID to the Python test so it can publish a synthetic v2 via SIGUSR1. A fresh fork is preferable because some public RPCs do not retain historical state indefinitely.

Run these long-lived processes in separate terminals from the repository root:

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111 --port 18546
node scripts/ens/browser-server.mjs
# The fixture server prints its PID after registering the local platform namespace.
bun scripts/ens/build-browser.mjs
python -m http.server 13201 --bind 127.0.0.1 --directory .cache/ens-browser
```

Then run `python scripts/ens/browser-test.py --api-pid <printed-pid>`. Python Playwright and its Chromium browser must be installed. Use a fresh fork and fixture server for each run; the test intentionally advances the publication to v2. This harness requires `pintool.eth` to be available at the fork block. The standalone fork test uses a unique root name.

## Delivery status

Verified on 2026-09-13: after integrating the current standing-authorization Maker flow, the orchestrator suite passed 43 tests (the optional fork test was skipped in that run and passed separately against Anvil); the registrar artifact matched a fresh compiler output; Next production build and type checks passed. The fork-backed browser flow passed v1→v2 publication, delegation/revocation, retained Maker selection and three viewport sizes. The production static routes were checked separately with mocked unconfigured API responses. Existing unrelated frontend lint warnings remain.

Implementation and local Sepolia-fork verification are complete. Public Sepolia registration and deployment have not been performed by these tests. To activate the namespace, deploy the updated frontend and mandate service, then open `/ens/setup` using the intended platform owner wallet with Sepolia gas funds. Complete **Prepare registration**, **Register platform name**, and **Enable Provider registration**. The name remains subject to availability until registration succeeds; change `ENS_ROOT_NAME` if another account registers it first.

## Sources

- [ETHOnline 2026 ENS prizes](https://ethglobal.com/events/ethonline2026/prizes/ens)
- [ENSv2 app integration](https://docs.ens.domains/ensv2/tutorial-app-developers/)
- [Permissioned Resolver and text-key delegation](https://docs.ens.domains/ensv2/permissioned-resolver/)
- [Registry hierarchy](https://docs.ens.domains/ensv2/registry-hierarchy/)
- [Verifiable Factory](https://docs.ens.domains/ensv2/verifiable-factory/)
- [Official deployment table](https://docs.ens.domains/learn/deployments/)
