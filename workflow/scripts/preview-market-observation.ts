/** Local Bun CLI; not a CRE workflow and never signs or sends transactions.
 * Accepts only a public market-observation JSON file. No credential loading.
 * This deliberately uses public synthetic policies and an unshipped hash.
 */
import { keccak256, stringToHex, type Address } from 'viem'
import { marketFromObservation } from '../src/market-observation'
import { computeAuthorization } from '../src/intersect'
import { encodeGuardReportV1 } from '../src/encode'
import { makerLimitsSchema, providerStrategySchema } from '../src/types'
import deployment from '../../contracts/aqua-executor/deployments/11155111.json'

const [observationPath, expectedMaker, ...extra] = Bun.argv.slice(2)
if (!observationPath || !expectedMaker || extra.length) {
	throw new Error('Usage: bun run scripts/preview-market-observation.ts <public-observation.json> <expected-maker-address>')
}
const nowSec = Math.floor(Date.now() / 1000) // Host tool only; workflow uses runtime.now().
const market = marketFromObservation(await Bun.file(observationPath).json(), { expectedMaker, nowSec })
// Illustrative thresholds for rss-simple-returns-30m-v1, not a calibrated trading strategy.
const strategy = providerStrategySchema.parse({ schemaVersion: 1, strategyId: 'PUBLIC-SYNTHETIC-PREVIEW-ONLY',
	rules: [{ id: 'demo-two-sided', when: { volatilityBpsMax: 300 }, allowMakerBuyToken0: true, allowMakerSellToken0: true,
		maxAmount0PerSwap: '100000000000000', maxAmount1PerSwap: '1000000', ttlSec: 120 }],
	inventory: { maxBalance0: '1000000000000000000', maxBalance1: '1000000000' } })
const limits = makerLimitsSchema.parse({ schemaVersion: 1, maxBudget1: '100000000', maxToken0ShareBps: 6000,
	maxAmount0PerSwap: '100000000000000', maxAmount1PerSwap: '1000000', maxTtlSec: 120 })
const identity = { chainId: BigInt(deployment.chainId), guard: deployment.guard.address as Address,
	router: deployment.router as Address, maker: expectedMaker as Address,
	strategyHash: keccak256(stringToHex('public-market-observation-preview-only-unshipped-v1')),
	token0: deployment.tokens.WETH as Address, token1: deployment.tokens.USDC as Address }
const { report } = computeAuthorization({ strategy, limits, market, identity, nowSec, nonce: BigInt(nowSec) })
const encoded = encodeGuardReportV1(report)
console.log(JSON.stringify({ mode: 'local-public-synthetic-preview', signed: false, delivered: false,
	strategyShipped: false, note: 'Illustrative policy only; timestamp nonce is not a production nonce allocator.',
	volatilityMethod: 'rss-simple-returns-30m-v1', market, syntheticPolicy: { strategy, limits },
	report, reportBytes: (encoded.length - 2) / 2, reportHash: keccak256(encoded),
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2))
