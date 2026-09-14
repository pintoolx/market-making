# Nonzero LP fees are blocked with the current Guard recipes

Verified on 2026-09-14. This supersedes the earlier PR #84 claim that fixed input
fees preserve gross-input Guard limits. Builder currently enables **zero LP fees
only** for XYC, fixed-range CLMM and Pegged strategies.

## Reproduced behavior

In pinned [SwapVM Fee.sol](https://github.com/1inch/swap-vm/blob/32c687c2b73101fc26549e48fa1ff8a4d73afbac/src/instructions/Fee.sol),
`_flatFeeAmountInXD` subtracts a rounded input fee, runs the remaining program
recursively, and restores gross input only after that call returns. The legacy
curve and appended Guard Extruction execute inside this call. Guard therefore
sees net input even though settlement credits gross input to Aqua.

Actual router tests reproduce both consequences on all three curves in both
directions with a 30 bps fee:

- Gross input one atomic unit above the report's per-swap limit can settle.
- Actual post-swap input inventory one atomic unit above its ceiling can settle.

The earlier tests verified successful pricing and final inventory, but did not
test these fee-bearing rejection boundaries. Passing those tests was insufficient
evidence for the stated cap guarantees. The wallet browser acceptance was rerun
with zero fees after this failure was understood.

## Scope of the mitigation

The Builder validator, requirement assessment and guarded V1/V2 compiler reject
nonzero fees. Provider publication, new compilation, report input preparation,
registration and Guard unrevocation cannot enable that combination. The Agent
requires explicit acceptance of zero fees; it must not silently change a fee
requirement or claim it has been implemented.

The independent decoder still recognizes historical fee-bearing artifacts.
Owners can recover recorded transactions and prepare dock, direct Guard
revocation and shared allowance revocation for older versions. Those actions
do not require recompiling an unsupported or expired strategy. No existing Maker
position was changed as part of this mitigation.

This is an application/compiler restriction, **not a deployed Guard patch**.
Previously deployed fee-bearing programs retain the demonstrated behavior until
their Maker stops them. The generic unguarded executor still encodes input fees;
that capability is not evidence of safe Guard composition.

Re-enabling fees requires authoritative gross input and real post-swap inventory
at the Guard, rejection-boundary tests across both directions and all curves,
and target-deployment verification. It may require a revised Guard and deployment
profile. No new opcode, contract deployment or automatic migration is included.

## Regression

`contracts/aqua-executor/test/builder-compile.test.ts` reconstructs legacy fee
bytes solely in tests and proves the violations through actual local settlement.
Production compiler calls reject the same fee requirement. Run `pnpm test:contracts`
with Anvil installed; these regressions do not write to a public chain.

Service tests also prove that saved legacy artifacts remain recoverable for
dock/revoke while registration and unrevocation are blocked.
