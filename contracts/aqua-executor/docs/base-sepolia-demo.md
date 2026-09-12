# Base Sepolia execution evidence

The complete Aqua lifecycle with atomic rebalance succeeded on Base Sepolia (chain ID **84532**): **13/13 successful transactions**, both strategies docked, and both maker allowances revoked.

- Run: `2026-09-11T17-31-09-909Z`
- Taiwan time: `2026-09-12T01:31:09.910000+08:00` → `2026-09-12T01:32:03.176000+08:00`
- Source snapshot used for the run: `707a52ac3309bb1837ba0b239053588991c0e3fc`. No executor source or contract artifact changed during funding, deployment, or execution.
- [Lifecycle JSONL](../records/84532/2026-09-11T17-31-09-909Z.jsonl)
- [Deployment JSONL](../records/84532/deploy-2026-09-11T17-30-31-800Z.jsonl)
- [Funding JSONL](../records/84532/funding-2026-09-11T17-30-24-212Z.jsonl)
- [Deployment addresses](../deployments/84532.json)
- [Confidential executor interface](confidential-executor-interface.md)

## Contracts

These are our Base Sepolia deployments of the pinned, unmodified upstream contracts, plus mock tokens. They are not official 1inch deployment addresses.

| Contract | Basescan address |
|---|---|
| Aqua | [`0x51c4fa6a0622ffe4a9a57cbb7057b93a874f356e`](https://sepolia.basescan.org/address/0x51c4fa6a0622ffe4a9a57cbb7057b93a874f356e) |
| AquaSwapVMRouter | [`0x072590f226e6cd53422c140f514978eae6b823a8`](https://sepolia.basescan.org/address/0x072590f226e6cd53422c140f514978eae6b823a8) |
| mWETH | [`0x051a2cae44c673c576b75b5df6f8543bf5d5cc13`](https://sepolia.basescan.org/address/0x051a2cae44c673c576b75b5df6f8543bf5d5cc13) |
| mUSDC | [`0xa66378d3f585fd34e875cccea69061c46bce5ecc`](https://sepolia.basescan.org/address/0xa66378d3f585fd34e875cccea69061c46bce5ecc) |

The four creation transactions were compared with `encodeDeployData()` using the committed artifacts and constructor arguments; all matched exactly. Aqua runtime is 5,619 bytes; AquaSwapVMRouter runtime is 20,541 bytes. Source verification on Basescan has not been submitted.

## Lifecycle transactions

| # | Action | Status | Block | Explorer |
|---|---|---|---|---|
| 1 | maker-approve | success | 46689794 | [Basescan](https://sepolia.basescan.org/tx/0x16b7b80afbbd01a496afb3bc30f09b7cd99d93a360d7df78a7ff8c2a7a544655) · [Blockscout](https://base-sepolia.blockscout.com/tx/0x16b7b80afbbd01a496afb3bc30f09b7cd99d93a360d7df78a7ff8c2a7a544655) |
| 2 | maker-approve | success | 46689796 | [Basescan](https://sepolia.basescan.org/tx/0xd6f89d9fb03673833a55b3a03c38e9649f9d4bd24bd03882a4197a53c8776d5e) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xd6f89d9fb03673833a55b3a03c38e9649f9d4bd24bd03882a4197a53c8776d5e) |
| 3 | ship | success | 46689798 | [Basescan](https://sepolia.basescan.org/tx/0xf680484c5cd3dc586cef81406b90e4e7b49ebb2ff03bf8c2ff5bc0c009c111a5) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xf680484c5cd3dc586cef81406b90e4e7b49ebb2ff03bf8c2ff5bc0c009c111a5) |
| 4 | taker-approve | success | 46689800 | [Basescan](https://sepolia.basescan.org/tx/0xb77320819278bf515692d39dd2839c766dd8ca632db5b67652963dec8e35a7a0) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xb77320819278bf515692d39dd2839c766dd8ca632db5b67652963dec8e35a7a0) |
| 5 | swap | success | 46689802 | [Basescan](https://sepolia.basescan.org/tx/0xccd7f27ab95fd11bfac9b1dabb71c91eb4dfb972c4a6b755f00cc40be4c253f0) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xccd7f27ab95fd11bfac9b1dabb71c91eb4dfb972c4a6b755f00cc40be4c253f0) |
| 6 | maker-approve | success | 46689804 | [Basescan](https://sepolia.basescan.org/tx/0xb3e0e33caa8315189c012546abe82900496f53ab97a82a9d58a0a6712457ade9) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xb3e0e33caa8315189c012546abe82900496f53ab97a82a9d58a0a6712457ade9) |
| 7 | maker-approve | success | 46689806 | [Basescan](https://sepolia.basescan.org/tx/0xe666f06eef45f1dfc6117f09238c086dd1907b05a76b9c74b0315e17fe3e6526) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xe666f06eef45f1dfc6117f09238c086dd1907b05a76b9c74b0315e17fe3e6526) |
| 8 | rebalance | success | 46689808 | [Basescan](https://sepolia.basescan.org/tx/0xc482cb16849ba5916ce05734157d7d98428db6791b5d4ebb2597d582c95a20c5) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xc482cb16849ba5916ce05734157d7d98428db6791b5d4ebb2597d582c95a20c5) |
| 9 | taker-approve | success | 46689810 | [Basescan](https://sepolia.basescan.org/tx/0xe4a6b34fad86a20882ecee0ba9682ac438db7ff943f582760ce36c618a047764) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xe4a6b34fad86a20882ecee0ba9682ac438db7ff943f582760ce36c618a047764) |
| 10 | swap | success | 46689812 | [Basescan](https://sepolia.basescan.org/tx/0x1c532754fac5e085993f8ceffc8cf313f7959d80002b76886892283da9229bf2) · [Blockscout](https://base-sepolia.blockscout.com/tx/0x1c532754fac5e085993f8ceffc8cf313f7959d80002b76886892283da9229bf2) |
| 11 | dock | success | 46689814 | [Basescan](https://sepolia.basescan.org/tx/0x1ff62b523aa57efe4dd32b70956bd263f82ca5021c5ad143fc2aeb40f3352204) · [Blockscout](https://base-sepolia.blockscout.com/tx/0x1ff62b523aa57efe4dd32b70956bd263f82ca5021c5ad143fc2aeb40f3352204) |
| 12 | maker-revoke | success | 46689816 | [Basescan](https://sepolia.basescan.org/tx/0x2c036c46567b476e5e0b9a560d2e3cc77f25ef53a30d00acf48ca047a97ba60a) · [Blockscout](https://base-sepolia.blockscout.com/tx/0x2c036c46567b476e5e0b9a560d2e3cc77f25ef53a30d00acf48ca047a97ba60a) |
| 13 | maker-revoke | success | 46689818 | [Basescan](https://sepolia.basescan.org/tx/0xc2268d131923c0fd3e5c45a4558ce8578e7c2f26721c9084415086af0f4980f1) · [Blockscout](https://base-sepolia.blockscout.com/tx/0xc2268d131923c0fd3e5c45a4558ce8578e7c2f26721c9084415086af0f4980f1) |

Both swaps paid 100 mUSDC. The first received 0.039100339235641312 mWETH at 30 bps; the second received 0.037524668957794728 mWETH after rebalance to 50 bps. Both matched their quotes and exceeded min-out.

Each swap emitted three ERC20 transfers: mWETH from maker to taker, mUSDC from taker to router, and mUSDC from router to maker. These addresses and amounts were checked against the recorded swap output.

## Verification

- `npm run lifecycle -- --network base-sepolia --rebalance` exited 0 and printed the JSONL path.
- The lifecycle JSONL has 13 `execution` rows, all `success`, with matching explorer URLs.
- Its final row is `kind: cycle`, `status: completed`.
- The `after dock` check has `tokensCount: 255` for both tokens. Fresh RPC reads confirmed both old and new strategies have zero virtual balances and `tokensCount: 255`.
- Fresh RPC reads confirmed maker allowances to Aqua are zero for both tokens.
- Independent `cast receipt <hash> status --rpc-url https://sepolia.base.org` checks returned `true` for ship, the first swap, rebalance, and dock.
- The first swap was independently indexed by Blockscout with `result: success`, at block 46689802. Automated access to Basescan returned HTTP 403, so Basescan page rendering was not independently verified; both explorer links are provided above.
- Before execution, local tests passed 12/12 and `npm run typecheck` passed.

## Funding and rerunning

The agent obtained **0.0005 Base Sepolia ETH** through the documented [A2AWire faucet](https://a2awire.com/content/getting-testnet-eth-from-the-faucet/) agent-invoke API. [Faucet transfer](https://sepolia.basescan.org/tx/0x6b2901c01172307d5998db4a69dbfb4b793c31b0b5385239e844e0d81ccb5ae6).

Before deployment, 0.0001 ETH was transferred from maker to taker. This satisfies the deployer's existing taker-balance threshold, so it skips its default 0.0005 ETH top-up. At the observed 0.006 gwei gas price, the single faucet drip covered the entire deployment and lifecycle. The README's 0.001 ETH recommendation remains the budget for a fresh deploy with the default top-up.

The faucet's documented unauthenticated request is:

```bash
curl --request POST https://a2awire.com/agents/faucet/invoke \
  --header 'Content-Type: application/json' \
  --data '{"task":"request_testnet_eth","input":{"address":"0x32F79282124EaFc681601cDCa2883C672C72D340"}}'
```

The faucet limits claims to one drip per recipient/owner per 24 hours. Verify receipt and balance after a claim.

To run another lifecycle against these deployments, keep the testnet keys in the ignored `.env`, check both gas balances, then run:

```bash
npm run lifecycle -- --network base-sepolia --rebalance
```

No redeployment is needed. The CLI generates fresh salts and deadlines. The strategy snapshots in the completed record are already docked and cannot be shipped again.

## Deferred scope

Basescan source verification was not requested and no Etherscan API key is configured. The optional Base mainnet fork demo was not requested. This P0 run predates the [P1 risk monitor](risk-monitor.md); its transaction records are unchanged. Separate [P1 Base Sepolia evidence](risk-monitor-sepolia.md) covers live prices, rebalance continuation and automatic risk-dock. Actual TEE integration has not started. Git is paused at the user's request; P1 changes are uncommitted and nothing has been pushed.
