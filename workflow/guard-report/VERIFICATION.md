# Delivery adapter verification — 2026-09-12

This is local development evidence, not a CRE / TEE execution record.

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed; pinned dependency graph unchanged |
| `bun run typecheck` | Passed for workflow and separate local preparation tools |
| `bun test` | 9 passed, 0 failed; 74 assertions |
| `bun run build` | Passed with SDK type and runtime compatibility checks enabled |
| `bun run setup:guard deployment` | Generated unsigned creation data; no transaction sent |
| Preparation against the historical Base Sepolia Guard | Read-only RPC check rejected its project-owned forwarder; no config file created |
| `cre whoami --non-interactive` | Exit 1: no login / `CRE_API_KEY` |
| `cre workflow simulate … --non-interactive` | Exit 1 at authentication; no handler execution or broadcast |

Tests cover exact shared ABI bytes and digest; malformed / private-field rejection; integer boundaries; nonce and expiry validation; public cron delivery through SDK report / EVM mocks; matching production identity; wrong domain / configuration; receiver revert despite outer transaction success; absent status / invalid transaction hash; digest mismatch; unchanged retry payload; a stub TEE crossover; and unsigned simulation deployment / paused probe constraints.

The RPC rejection check used existing Guard `0x41fde9f1f257fc65a40eb519d22ca9bfb1d2dbeb` on Base Sepolia. It confirms that the setup tool cannot silently reuse the old harness receiver. It does not exercise a new Chainlink receiver deployment or successful CLI delivery.

Toolchain: Linux x64, Bun 1.4.2, TypeScript 5.9.3, CRE SDK 1.20.1, Javy plugin 1.7.0 / Javy 8.1.0, CRE CLI 1.33.0. CLI and Bun archives were checked against official release SHA-256 values:

- CLI archive: `956b2ae2b764673f34f3101b2beafd40377b851b56a39f7e49f156175f8a897a` ([release](https://github.com/smartcontractkit/cre-cli/releases/tag/v1.33.0)).
- Bun archive: `36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913` ([release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)).

The local `.cache/guard-report.wasm` has the WASM v1 magic / version header, is 2,577,780 bytes and has SHA-256 `c48f0d9c51b13857786979f9ec143900d8392a02556df236c2a94d01e1dbdd53`. This identifies that local build; it is not an attestation or a promise of byte-identical output on another toolchain. Binary build output and generated configuration are ignored by Git.

No Solidity, deployed artifact, shared report ABI or executor runtime changed. Existing contract enforcement evidence remains separate in the [Guard demo record](../../contracts/aqua-executor/docs/guard-sepolia-demo.md). Frontend behavior and dependencies are outside this increment.

The remaining chain and confidential-execution milestones are listed in the [integration decision](../../docs/CRE-GUARD-INTEGRATION.md). The first successful CLI broadcast must add its own receipts, event and independent state readback; do not replace this authentication failure with a fabricated success record.
