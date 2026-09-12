# LP release integration verification — 2026-09-12

The [actual CRE HTTP simulation](cre-simulation.log) executes the current handler with Provider and Maker policies encrypted by the same browser helper used in the app. All policies and the envelope key in the launcher are explicitly public synthetic test data. No real secret was uploaded, and no chain write or DON workflow deployment was performed.

The workflow acquired Kraken ETH/USDC depth/candles and finalized Sepolia balances itself. It validated the approved publication/ciphertext binding, decrypted both inputs via the secret API and returned:

```text
requestId=public-publication-v1 allowedDirections=3 nonce=1789226476
validAfter=1789226476 validUntil=1789226776 txHash=none (dry-run)
```

The reported market observation was midpoint **2540.655 USDC/WETH**, 30-minute volatility **13 bps**, finalized block **11689664**. This exercises local confidential-handler code, not enclave attestation or a newly shipped Maker program. The configured example program hash is used only as dry-run report identity.

Reproduce from the repo root, with the installed CRE CLI on PATH:

```bash
node workflow/scripts/simulate-public-publication.mjs workflow/verification/lp-release-integration/public-config.json
```

The launcher forces dry-run, removes the broadcast key from its child environment, uses `--env /dev/null`, and deletes its temporary public config/payload files. It never logs ciphertext or plaintext private-input objects. The CLI resolves all declared secret names, so unused names are supplied with public synthetic fixtures as well.

The independent [read-only readiness observation](docked-readiness.json) checked the earlier demo's Maker/strategy at block **11689763** and correctly returned **not-ready**, with no active authorization, docked Aqua liquidity and insufficient allowance. It sent no transactions. Its timestamp is historical and must not be treated as current readiness.

Validation also includes the full local Aqua Router/journal suite (70 pass, one opt-in Sepolia-fork test skipped), workflow and delivery tests, signed registry HTTP tests, schema/range/version tests, readonly state tests, frontend TypeScript/lint/build, and a Playwright check of the rendered static export. The browser check entered asymmetric 3%/7% bounds, verified five unsupported templates cannot publish, and confirmed private threshold input does not enter browser storage and is cleared on leaving the editor. It did not automate a connected wallet's signature or claim a new frontend-to-Sepolia lifecycle.

The first full executor test attempt lacked `ANVIL` on PATH and was stopped; the full suite passed using the existing verified Anvil binary. A first cron simulation found the newly declared envelope secret name missing; the public launcher now supplies its explicitly synthetic value. The successful HTTP simulation above includes that correction.
