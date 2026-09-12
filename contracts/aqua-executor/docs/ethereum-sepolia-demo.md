# Ethereum Sepolia public run — 2026-09-12

Completed on **Ethereum Sepolia, chain 11155111**, with existing WETH9 and Circle
testnet USDC. No mock asset was deployed or minted. Execution source commit:
`170ffd8a595f60dc14f52f451c5e8746f68289bb` ([source hashes](ethereum-sepolia-source-manifest.json)).

## Results

- **40 confirmed transactions: 39 successful and one deliberately reverted swap.**
- Standard lifecycle: 13 successful transactions, including two 0.5-USDC swaps,
  atomic dock/ship rebalance, final dock and maker approval revocation.
- Concentrated Guard V2: three successful swaps in both directions; disabling
  USDC-in rejects an already-quoted order with `DirectionDisabled`.
- The rejected transaction emits no logs. Both token balances of maker/taker and
  both Aqua inventory slots match before/after; the second RPC also read these
  values at the rejection block and its parent.
- All three strategy hashes are docked (`balance=0`, `tokensCount=255`) and all
  maker→Aqua / taker→Router token allowances are zero after cleanup.
- Total gas for deployment, allocation and both demos: **0.011059010734139363 ETH**.
  Wrapping 0.006 ETH is an asset conversion, not gas expenditure.

Primary execution RPC: PublicNode. Independent receipt/state validation:
Tenderly public Sepolia at block **11688673**. All 40 receipt statuses,
block numbers, senders/destinations and gas used match the records. Router and CRE
Guard creation inputs match the committed artifacts and constructor arguments.
Machine-readable proof: [ethereum-sepolia-verification.json](ethereum-sepolia-verification.json).

## Deployment

| Role | Address |
|---|---|
| Aqua (reused) | [0x1111113ccf1426a8e30e2bff5e005d929bf6a90a](https://sepolia.etherscan.io/address/0x1111113ccf1426a8e30e2bff5e005d929bf6a90a) |
| AquaSwapVMRouter v1.0.2 | [0x47a875f39ba4b0d0beaa928bb071d4b4da0b4092](https://sepolia.etherscan.io/address/0x47a875f39ba4b0d0beaa928bb071d4b4da0b4092) |
| WETH9 | [0xfff9976782d46cc05630d1f6ebab18b2324d6b14](https://sepolia.etherscan.io/address/0xfff9976782d46cc05630d1f6ebab18b2324d6b14) |
| Circle testnet USDC | [0x1c7d4b196cb0c7b01d743fbc6116a902379c7238](https://sepolia.etherscan.io/address/0x1c7d4b196cb0c7b01d743fbc6116a902379c7238) |
| CRE simulation Guard V2 | [0x51c4fa6a0622ffe4a9a57cbb7057b93a874f356e](https://sepolia.etherscan.io/address/0x51c4fa6a0622ffe4a9a57cbb7057b93a874f356e) |
| Synthetic enforcement Guard V2 | [0x799782cb42ae0f2803ef3c6fd3a79e50c85177fa](https://sepolia.etherscan.io/address/0x799782cb42ae0f2803ef3c6fd3a79e50c85177fa) |
| Owner-controlled test forwarder | [0x6326003d7bbc057ef29cdbf0779d0d1bf654711c](https://sepolia.etherscan.io/address/0x6326003d7bbc057ef29cdbf0779d0d1bf654711c) |

The [deployment bundle](../deployments/11155111.json) identifies the **CRE
simulation receiver**, which trusts `0x15fc6ae953e024d975e77382eeec56a9101f9f88` and zero workflow
identity. `setup:guard config` successfully checked that receiver and generated
a paused unshipped probe via read-only calls. No CRE delivery occurred.
The enforcement demo uses the separate test receiver shown above. Its reports
are synthetic; successful enforcement is **not a DON or TEE attestation**.
Neither receiver implements an atomic A/B mandate switch.

## Selected receipts

| Action | Receipt |
|---|---|
| Lifecycle ship | [0xc806049106cc6456f57e80f1a989cc8264776804fd90f2980f84985793b9b622](https://sepolia.etherscan.io/tx/0xc806049106cc6456f57e80f1a989cc8264776804fd90f2980f84985793b9b622) |
| Lifecycle swap | [0x04e63db5e770d1f1b79230cca544e379b37e96af76a7264e7ce3aa88b41f3355](https://sepolia.etherscan.io/tx/0x04e63db5e770d1f1b79230cca544e379b37e96af76a7264e7ce3aa88b41f3355) |
| Lifecycle rebalance | [0x32511ba7030e9156ffa09bf055e0f10e17856d36d81e006d935832ab6dd7db81](https://sepolia.etherscan.io/tx/0x32511ba7030e9156ffa09bf055e0f10e17856d36d81e006d935832ab6dd7db81) |
| Lifecycle dock | [0x43ee3f93425cc5c7bd1a5904bd6862d038d42788e74811a054605067ed604619](https://sepolia.etherscan.io/tx/0x43ee3f93425cc5c7bd1a5904bd6862d038d42788e74811a054605067ed604619) |
| Concentrated swap 1 | [0x09b2a866a41dfbdccf0730fa07e6c88bd121e6a5b7fc099f8957e8c529b72ea8](https://sepolia.etherscan.io/tx/0x09b2a866a41dfbdccf0730fa07e6c88bd121e6a5b7fc099f8957e8c529b72ea8) |
| Concentrated swap 2 | [0x5604844be8f7c9e302d5afe498b32d1237fa75b6352b405265a26e3e14cb1a6e](https://sepolia.etherscan.io/tx/0x5604844be8f7c9e302d5afe498b32d1237fa75b6352b405265a26e3e14cb1a6e) |
| Concentrated swap 3 | [0x0cb908b3787eabff1e34d79e7244baebcfc2c153003fc00ab78539664492da67](https://sepolia.etherscan.io/tx/0x0cb908b3787eabff1e34d79e7244baebcfc2c153003fc00ab78539664492da67) |
| Guard veto (expected revert) | [0x8a91c65378536ef42c80221e4a031476c31fe8bf570f8728fa7feef3d81b6072](https://sepolia.etherscan.io/tx/0x8a91c65378536ef42c80221e4a031476c31fe8bf570f8728fa7feef3d81b6072) |

Full records: [lifecycle](../records/11155111/2026-09-12T11-30-51-525Z.jsonl),
[Guard](../records/11155111/guard-demo-2026-09-12T11-34-16-038Z.jsonl),
[Guard summary](../records/11155111/guard-demo-2026-09-12T11-34-16-038Z.jsonl.summary.json),
[deployment](../records/11155111/sepolia-deploy-v1.jsonl),
[initial allocation](../records/11155111/sepolia-fund-v1.jsonl).
Signed transaction journals remain local and ignored; the committed JSONL exports
contain public hashes, receipts and strategy/report data only.

## Validation and continuation

Before the public run: 58 regular executor tests passed; the separate Sepolia
fork integration test passed using the real asset contracts, including
interrupted deployment/wrapping recovery. Executor typecheck, Guard V2
reproducible solc 0.8.30 check, 25 workflow tests, 10 delivery tests (76 assertions),
11 orchestrator tests, CRE WASM build and frontend production build passed.

The recorded strategy hashes are permanently docked. Start a new run to obtain
new salts/hashes; do not reuse these hashes as an active authorization. Funds
remain in the wallets and can be reused. See [the runbook](ETHEREUM-SEPOLIA.md)
for setup/recovery and the explicit 2500-USDC/WETH recording fixture. This is
execution evidence, not live-market pricing or a profitability result.
