import { describe, expect, test } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow, onCronTrigger, type Config } from './workflow'

// The public test surface has no TEE runtime factory (`newTestRuntime` returns
// a DON `Runtime`), so we stand up the slice of `TeeRuntime` the handler uses:
// config, getSecrets, now, log, usingTheDons.

const PROVIDER = {
	schemaVersion: 1,
	strategyId: 'unit-test-strategy',
	rules: [
		{
			id: 'calm-two-sided',
			when: { priceMin: '1000', priceMax: '10000', volatilityBpsMax: 300 },
			allowMakerBuyToken0: true,
			allowMakerSellToken0: true,
			maxAmount0PerSwap: '500000000000000000',
			maxAmount1PerSwap: '1500000000',
			ttlSec: 300,
		},
	],
	inventory: { maxBalance0: '5000000000000000000', maxBalance1: '50000000000' },
}

const MAKER = {
	schemaVersion: 1,
	maxBudget1: '10000000000',
	maxToken0ShareBps: 6000,
	maxAmount0PerSwap: '400000000000000000',
	maxAmount1PerSwap: '2000000000',
	maxTtlSec: 240,
}

const NOW = new Date(1_800_000_000_000)

const makeConfig = (): Config =>
	configSchema.parse({
		schedule: '0 */2 * * * *',
		providerSecretId: 'PROVIDER_STRATEGY',
		makerSecretId: 'MAKER_LIMITS',
		maker: '0x3333333333333333333333333333333333333333',
		guard: '0x1111111111111111111111111111111111111111',
		router: '0x2222222222222222222222222222222222222222',
		strategyHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
		marketSnapshot: {
			midPrice: '3000',
			volatilityBps: 120,
			balance0: '1000000000000000000',
			balance1: '4000000000',
			decimals0: 18,
			decimals1: 6,
		},
	})

const makeFakeTeeRuntime = (secrets: Record<string, string> = {
	PROVIDER_STRATEGY: JSON.stringify(PROVIDER),
	MAKER_LIMITS: JSON.stringify(MAKER),
}) => {
	const logs: string[] = []
	const secretCalls: string[][] = []
	let crossedToDons = 0

	const runtime = {
		config: makeConfig(),
		getSecrets: (requests: { id: string }[]) => {
			secretCalls.push(requests.map((r) => r.id))
			return {
				result: () =>
					Object.fromEntries(
						requests.map((r) => {
							if (!(r.id in secrets)) throw new Error(`missing secret ${r.id}`)
							return [r.id, { id: r.id, value: secrets[r.id] }]
						}),
					),
			}
		},
		now: () => NOW,
		log: (message: string) => logs.push(message),
		usingTheDons: () => {
			crossedToDons++
			throw new Error('usingTheDons must not be called in dry-run')
		},
	}

	return {
		runtime: runtime as unknown as TeeRuntime<Config>,
		logs,
		secretCalls,
		crossedToDons: () => crossedToDons,
	}
}

describe('onCronTrigger', () => {
	test('fetches both confidential inputs in a single getSecrets() call', () => {
		const { runtime, secretCalls } = makeFakeTeeRuntime()

		onCronTrigger(runtime)

		expect(secretCalls).toEqual([['PROVIDER_STRATEGY', 'MAKER_LIMITS']])
	})

	test('returns only public report fields and stays inside the enclave in dry-run', () => {
		const { runtime, crossedToDons } = makeFakeTeeRuntime()

		const summary = onCronTrigger(runtime)

		expect(summary).toContain('allowedDirections=3')
		expect(summary).toContain(`validAfter=${NOW.getTime() / 1000}`)
		expect(summary).toContain(`validUntil=${NOW.getTime() / 1000 + 240}`)
		expect(summary).toContain('txHash=none (dry-run)')
		expect(crossedToDons()).toBe(0)
	})

	test('dry-run logs the full payload the Guard would receive', () => {
		const { runtime, logs } = makeFakeTeeRuntime()

		onCronTrigger(runtime)

		const reportLine = logs.find((l) => l.includes('report={'))
		expect(reportLine).toBeDefined()
		expect(reportLine).toContain('"allowedDirections":"3"')
		expect(logs.some((l) => /encodedReport=0x[0-9a-f]{1024}$/.test(l))).toBe(true) // 512 bytes
		expect(logs.some((l) => /reportHash=0x[0-9a-f]{64}$/.test(l))).toBe(true)
	})

	test('never logs or returns private inputs (rule ids, thresholds, share, TTL preferences)', () => {
		const { runtime, logs } = makeFakeTeeRuntime()

		const summary = onCronTrigger(runtime)
		const everything = [...logs, summary].join('\n')

		for (const secretOnly of ['unit-test-strategy', 'calm-two-sided', '"priceMin"', '10000"', '6000', 'volatilityBpsMax']) {
			expect(everything).not.toContain(secretOnly)
		}
	})

	test('rejects a malformed secret without echoing its contents', () => {
		const { runtime } = makeFakeTeeRuntime({
			PROVIDER_STRATEGY: JSON.stringify({ ...PROVIDER, strategyId: 'TOP-SECRET-NAME', rules: [] }),
			MAKER_LIMITS: JSON.stringify(MAKER),
		})

		let message = ''
		try {
			onCronTrigger(runtime)
		} catch (e) {
			message = (e as Error).message
		}
		expect(message).toContain('PROVIDER_STRATEGY: secret failed schema validation')
		expect(message).toContain('rules:too_small')
		expect(message).not.toContain('TOP-SECRET-NAME')
	})

	test('rejects a secret that is not JSON', () => {
		const { runtime } = makeFakeTeeRuntime({ PROVIDER_STRATEGY: 'not json', MAKER_LIMITS: JSON.stringify(MAKER) })

		expect(() => onCronTrigger(runtime)).toThrow('PROVIDER_STRATEGY: secret is not valid JSON')
	})
})

describe('initWorkflow', () => {
	test('registers the cron handler with a Nitro TEE constraint', () => {
		const handlers = initWorkflow(makeConfig())

		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		expect(handlers[0].requirements).toBeDefined()
	})
})
