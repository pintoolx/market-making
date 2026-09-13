# Builder deployment and execution boundaries

This document consolidates the initial integration decisions. Current implementation status belongs in package documentation and test/deployment evidence; these requirements are not proof of a completed release. [Event-driven authorization](SWAPVM-BUILDER-EVENT-TRIGGERS.md) supersedes the original TTL-renewal proposal.

## Scope

Use the existing TypeScript architecture, static Next frontend, Ethereum Sepolia WETH/USDC, verified AquaSwapVMRouter and Aqua interfaces. The Builder creates compositions of existing verified instructions; it does not generate arbitrary Solidity or calldata. A fixed PinTool Guard Extruction is permitted and required. Arbitrary hooks, targets, opcodes, custom routers/AquaApps, auto-recenter, DCA, cross-protocol actions and backend custody are excluded.

The original three product choices are settled: Provider publishes a template, Maker instantiates it; fixed Guard integration is mandatory; zero fees precede separately verified fixed LP input fees. Automatic event evaluation is permitted with consent, but it does not sign Maker asset transactions.

## Deployment evidence

Pin chain/profile, contract addresses, ABI/code hashes, source commits, opcode table, SDK versions, router-to-Aqua binding, observation block/hash/time, recipe compatibility and routing evidence. A matching address, example README or SDK feature is insufficient proof of runtime compatibility. Missing evidence keeps execution unavailable while permitting offline design.

The initial read at finalized Sepolia block `11690067` observed 20,541 bytes at router `0x47a875f39ba4b0d0beaa928bb071d4b4da0b4092`, 5,619 bytes at Aqua, 5,963 bytes at the former Guard and no code at the canonical router checked in that record. See [deployment read](strategy-builder-research/deployment-read.json) for exact identities. It is historical evidence for the old Guard, not a readback of standing-v2 or a source-to-runtime rebuild.

The source review used SwapVM v1.0.2 and SDK 0.4.4; verify exact commits in the evidence/manifests. No Aqua SDK was installed; record the ABI/viem adapter honestly. Preserve pinned dependency isolation rather than blindly upgrading shared packages.

Capability records separate `sourceImplemented`, `sdkEncodable`, `runtimeVerified`, `compositionTested`, `productEnabled` and `routingCompatible`. Each requires schema, units, constraints, preconditions, side effects, compatible recipes and evidence or a concrete blocked reason. Reserved opcode gaps, unknown traits and unsafe instruction paths are rejected even if an upstream runtime might accept them.

## Recipes and amounts

XYC, fixed-range concentrated and verified Pegged need compatible Guard recipes, markers, independent decoders and real-router lifecycle tests. Earlier V1 guarded tests do not prove V2 active-hash semantics. Nonzero fees require gross input, net pricing input, Aqua credit/debit and Guard cap agreement; unguarded fee tests do not prove this composition.

Use exact arithmetic for atomic amounts, square-root prices, reciprocals, token ordering and internal fee scales. Avoid double conversion when SDK helpers already scale values. Verify 6/18 decimals, reversed base/quote, min/max inversion, rounding and tiny/large inputs. A concentrated curve is not inherently a 50/50 inventory requirement. WETH and native ETH remain distinct.

`specHash` identifies application JSON; `programHash` identifies bytes. In this Aqua profile, `orderHash = router.hash(order) = keccak256(abi.encode(order)) = strategyHash`. The same validated spec, manifest, recipe and salt must produce identical bytes. Independent decoding must confirm the original semantics.

A relative range is resolved against a recorded source/time and fixed during Maker instantiation; it does not autorecenter. Deadline opcode zero is not unlimited. Product-enabled exact-in, fee and modifier support follows the current capability registry and tests, not generic upstream feature lists.

## Ownership and lifecycle

Provider templates and immutable versions differ from Maker instances. Provider publication does not authorize Maker funds. Maker edits respect the original pinned version's allowed bounds; new Provider versions do not silently upgrade existing instances.

Authorization binds verified owner, revision, recipe/profile/spec commitments, compiled hashes, chain/router/Guard, Provider policy commitment, Maker consent and active generation. Verify signatures, recompile and decode server-side rather than trusting submitted catalog hashes. Separate report sequence from Ethereum transaction nonce and persist pending receipts.

A substantive revision invalidates unsent confirmations and stale artifacts, not transactions already broadcast. Plans are generated from decoded payloads and show chain, maker, target, selector, parameters, calldata digest, value, spender, limited allowance, gas and preconditions. Maker approves Aqua; the existing EOA taker approves Router. Wallet signing follows explicit review.

Ship records virtual balances without depositing assets. Wallet funds, allowances and virtual balances are distinct, shared resources. Do not sum virtual balances, claim global reservation or imply one strategy's fill automatically decrements every other strategy ledger. Dock, Guard revoke, worker stop and allowance revoke are distinct.

## Agent and evidence

The design agent uses typed read/prepare tools, never unrestricted signing, approval, Solidity evaluation or transaction execution. Public chat and encrypted private policy stay isolated. Server authentication, wallet ownership, resource isolation, revision checks and quotas are required; CORS is not authorization. External metadata is untrusted.

Keep separate models for drafts, validated strategies, compiled artifacts, simulation reports and transaction plans. A model statement is not domain evidence. The frontend remains static; the independent Builder API owns authenticated persistence and streaming.

Distinguish mathematical preview, fixed-context quote and complete settlement simulation. Preserve `mock`, `local-upstream`, `fork-with-overrides`, `fork-real-context` and `live-read` labels. Fork workers write only to isolated chains, never the public RPC. Compare quote and swap from identical state, time and caller context.

Test both directions, sequential fills, actual transfer paths, low inventory, allowance failures, cap boundaries, range/deadline boundaries, docking, revocation and active-hash changes. Exact-out must be explicitly rejected where unsupported. Quote success is not settlement readiness; registration is not routing inclusion or guaranteed returns.

Historical local test totals establish only their recorded baseline. They are not evidence that later Builder UI, worker, production model, cloud rollout or real CRE attestation has passed.

## Licensing

Verify SwapVM, Aqua and SDK license terms before commercial distribution; avoiding a new contract deployment does not remove those obligations. Preserve required attribution, including `Powered by SwapVM — © Degensoft Ltd 2025.` where applicable. Passing tests is not a third-party audit.
