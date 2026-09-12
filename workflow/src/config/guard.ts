/**
 * Public, non-secret constants describing WHERE the authorization goes.
 *
 * Everything here is either read from `contracts/aqua-executor/deployments/84532.json`
 * or from the Chainlink CRE docs; nothing in this file is confidential.
 *
 * TODO(pengu): confirm every value marked below before the first real
 * `cre workflow simulate --broadcast`. Only this file and `publish.ts` change
 * when the Guard side is finalised.
 */

export const GUARD_CONFIG = {
	/** Base Sepolia — matches the deployed prototype (deployments/84532.json). */
	chainId: 84532n,

	/**
	 * CRE chain-selector name for Base Sepolia, from the official
	 * "Simulation Testnets" table (docs.chain.link/cre, llms-full.txt).
	 */
	chainSelectorName: 'ethereum-testnet-sepolia-base-1',

	/**
	 * TODO(pengu): AquaGuard address the workflow should target. This is the
	 * simulation-profile Guard from contracts/aqua-executor/docs/guard-sepolia-demo.md.
	 * It was deployed with the project's own GuardTestForwarder, so a CRE-delivered
	 * report will be rejected (msg.sender != forwarder) until a Guard is deployed
	 * with `forwarder = CRE_MOCK_FORWARDER_BASE_SEPOLIA` (simulation) or the
	 * production KeystoneForwarder.
	 */
	guard: '0x41fde9f1f257fc65a40eb519d22ca9bfb1d2dbeb',

	/** TODO(pengu): AquaSwapVMRouter the Guard is bound to (deployments/84532.json). */
	router: '0x072590f226e6cd53422c140f514978eae6b823a8',

	/** mWETH / mUSDC test tokens (deployments/84532.json). Order = Maker-approved program order. */
	token0: '0x051a2cae44c673c576b75b5df6f8543bf5d5cc13',
	token1: '0xa66378d3f585fd34e875cccea69061c46bce5ecc',
	decimals0: 18,
	decimals1: 6,

	/**
	 * Chainlink's Mock Forwarder on Base Sepolia for `cre workflow simulate --broadcast`
	 * (official "Simulation Testnets" table). The Guard's immutable `forwarder`
	 * must equal this address for simulated delivery to be accepted.
	 * TODO(pengu): redeploy the simulation-profile Guard with this forwarder.
	 */
	creMockForwarder: '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5',

	/**
	 * Setter the report is delivered to. CRE's forwarder calls
	 * `onReport(bytes metadata, bytes report)` on the receiver — the Guard already
	 * implements exactly this (contracts/aqua-executor/contracts/AquaGuard.sol:96).
	 */
	onReportSignature: 'onReport(bytes,bytes)',

	/** TODO(pengu): gas limit for onReport on Base Sepolia (string per CRE SDK). */
	writeReportGasLimit: '500000',
} as const

export type GuardConfig = typeof GUARD_CONFIG
