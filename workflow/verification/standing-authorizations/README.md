# Standing authorization verification

The deployed `standing-v2` receiver is `0x64f6e18e85dae5ec2ee44fe7f9fc66cf2a1f056f` on Ethereum Sepolia. This run used the cloud mandate API, its CRE local simulator, real Kraken market acquisition, browser-sealed Maker inputs and the versioned `sepolia-maker-v2` Aqua programs. It does not prove production DON execution or hardware enclave attestation.

[Public verification data](verification.json) records the following observations. Private inputs, encryption envelopes and credentials are excluded.

- Creation accepted a schema-2 report with `validUntil = 0`. The API returned `expiresAt: null`.
- Re-evaluating Tight returned `authorization-unchanged`, the same report transaction, digest and nonce. No renewal report was delivered. PublicNode and Tenderly independently confirmed the original report, zero expiry and acceptance block.
- A real Tight Aqua swap succeeded with token transfers.
- Evaluating Defensive produced a new paused report under the market conditions of this run. Tight remained active; this is **not** evidence of a successful switch to Defensive. A Defensive quote was rejected by the active-profile gate. The verifier then broadcast the same trade, confirmed a reverted receipt with no logs, and verified unchanged token and Aqua balances.

| Evidence | Transaction |
|---|---|
| Initial standing report | [Report accepted](https://sepolia.etherscan.io/tx/0xb890e17e82caeecc0361ec8d5614453e784d3a1b079c8582cb201ea1f6d2b0fa) |
| Unchanged evaluation | Reuses the initial report; no new transaction |
| Tight swap | [Successful swap](https://sepolia.etherscan.io/tx/0x518b8fe0ad9e56ef5d559807187fdb6ae7df4ccdd9b766e1273b4a2794241969) |
| Defensive candidate paused | [Paused report](https://sepolia.etherscan.io/tx/0xd4ffec5a04472b138459a6dbe164ea0485aca0e955aed9862470523df9a2af42) |
| Defensive trade rejected | [Reverted transaction](https://sepolia.etherscan.io/tx/0xbb85c1ff3e3cd5ed6d5dfc3f975fc356dfec402c56ac618578591b3ed0c2e96b) |

The no-expiry time advance, cap enforcement and Maker revocation checks also run in local contract integration tests. Existing schema-1 reports retain their bounded expiry; only explicit standing consent uses schema 2. A workflow outage leaves the last standing authorization usable within its stored caps and the immutable program envelope.
