# Guard prototype — Base Sepolia evidence

Completed on 2026-09-12 Taiwan time: **2026-09-11 20:19:29–20:20:53 UTC**. The existing Aqua, router and mock tokens were reused; only a Guard and project-owned test forwarder were deployed.

**Delivery mode: synthetic reports through `GuardTestForwarder`.** This is an on-chain contracts demonstration, not CRE CLI delivery or TEE attestation. The production-identity profile is tested locally with fabricated metadata, not a live workflow.

## Deployment

| Contract | Base Sepolia address |
|---|---|
| Aqua, existing | `0x51c4fa6a0622ffe4a9a57cbb7057b93a874f356e` |
| AquaSwapVMRouter v1.0.2, existing | `0x072590f226e6cd53422c140f514978eae6b823a8` |
| AquaGuard, simulation profile | `0x41fde9f1f257fc65a40eb519d22ca9bfb1d2dbeb` |
| GuardTestForwarder, project harness | `0xf79ffa7f200220f564b91f20db39d357aa50a8c4` |

Maker: `0x32F79282124EaFc681601cDCa2883C672C72D340`. Taker: `0x9C69F55b9E6836b8e096C0F61202665C869922Cc`.

The zero-fee XYC order started with 2 mWETH / 5000 mUSDC. Its envelope capped each swap at 1 mWETH / 1000 mUSDC, and resulting inventory at 3 mWETH / 7000 mUSDC. Strategy hash: `0xceb3ec6dcae1eef15b7697f064ad036e80caeab25ce08bc8c73b62769aa31abe`.

## Transactions

| Action | Receipt |
|---|---|
| Deploy Guard | [Successful](https://sepolia.basescan.org/tx/0xa15557b85ddc08265a4c6ec199abb4266f79f79532653b8a33f5dbd809ccaa5d) |
| Ship guarded order | [Successful](https://sepolia.basescan.org/tx/0x49f7fe98689b085a8415f3bb2561d0e25265e5de7454f9ecfcca087043214c80) |
| Report nonce 1: both directions | [Accepted](https://sepolia.basescan.org/tx/0x38abe46d8b557aab7a67368fbee2ddec2a6ad9ce1af26eabcdf8ed0e17ed6e44) |
| 100 mUSDC in → mWETH out | [Successful](https://sepolia.basescan.org/tx/0x7eb7adcb8baaf78c7b8b143f720f3deafcee544ca756a508405d96908ff93171) |
| 0.01 mWETH in → mUSDC out | [Successful](https://sepolia.basescan.org/tx/0x1e91c15f566447fcd57eadfe35ec8ad23b1bc55874e40c328540bab31703aaf9) |
| Report nonce 2: only mWETH-in | [Accepted](https://sepolia.basescan.org/tx/0x1dd51b7b0604fc5b8646b237bb225eb3f150502cef9646f3b8ab4d7b0148eb76) |
| Another mUSDC-in swap | **[Reverted by Guard](https://sepolia.basescan.org/tx/0xc24d1e5533f56f72134814cc98630522dabf1fd8067b8c88f3a6e9578bc94804)** |
| 0.01 mWETH-in after restriction | [Still succeeds](https://sepolia.basescan.org/tx/0x96ba3c48b123028737d7415e0b8fb6130135fdbc8886fa242013af76328f198b) |
| Report nonce 3: paused | [Accepted](https://sepolia.basescan.org/tx/0xff514516f7ad0a851e8621d78de0c7305a89fd895f72acb7ec14c2462ca61a5b) |
| Dock | [Successful](https://sepolia.basescan.org/tx/0x9d45f36430e184f8a34a22f92136ba7733e771efa68f7cd6b1b85d183f428bff) |

**21 transactions: 20 successful, one intentionally reverted.** Each successful swap emitted three ERC20 `Transfer` events. An allowed quote was captured before the restrictive report; the later swap consulted the updated report. The rejected transaction emitted no logs, and token wallet / Aqua balances remained unchanged. Only its ETH gas was spent.

The final Aqua balances were zero with `tokensCount: 255`. All four demo allowances (Maker → Aqua and taker → router for both tokens) were zero. Guard nonce 3 remained stored with both directions paused. No strategy or background monitoring process was left running by this demo.

## Evidence

- [JSONL](../records/84532/guard-demo-2026-09-11T20-19-28-999Z.jsonl): order, envelope, report payloads / digests / acceptance events, receipts and rejection balance checks.
- [Summary](../records/84532/guard-demo-2026-09-11T20-19-28-999Z.jsonl.summary.json).
- [Independent RPC verification](../records/84532/guard-demo-2026-09-11T20-19-28-999Z.jsonl.verification.json): all 21 receipts reread through `https://base-sepolia-rpc.publicnode.com`, final state / allowances checked and both deployment inputs matched against artifacts plus constructor arguments. An `eth_call` at the rejected transaction's block returned `DirectionDisabled`.
- [Source manifest](guard-source.sha256), checked from the package directory with `sha256sum -c docs/guard-source.sha256`. The demo predates the legacy-compiler rejection of guarded parameters; its earlier compiler is archived at `docs/source-snapshots/pre-guard-compile.ts` and listed directly in this manifest. That subsequent check prevents accidental unguarded recompilation without changing the Guard or valid program bytes.

Explorer links are provided for inspection; verification used RPC. The explorer UI and source-verification service were not checked.

Current validation: **42/42 local tests**, TypeScript checking, shared ABI fixture, golden program bytes, actual router execution and reproducible Guard artifacts. See [operations and limitations](guard.md) to repeat the demo; a new run creates fresh Guard addresses and order hashes.
