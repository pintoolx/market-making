import { keccak256, stringToHex } from 'viem'
import { describe, expect, test } from 'bun:test'
import type { HTTPPayload, TeeRuntime } from '@chainlink/cre-sdk'
import { xchacha20poly1305 } from '@noble/ciphers/chacha'
import { x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { configSchema, initWorkflow, onCronTrigger, onHttpTrigger, type Config } from './workflow'

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
const ENVELOPE_PRIVATE_KEY = new Uint8Array(32).fill(7)
const DOMAIN_TEXT = 'pintool/confidential-envelope/v1'
const DOMAIN = new TextEncoder().encode(DOMAIN_TEXT)
const SEALED_MAKER_ADDRESS = '0x5555555555555555555555555555555555555555'
const hex = (value: Uint8Array) => Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
const seal = (value: unknown, subject = SEALED_MAKER_ADDRESS, scope: 'maker' | 'provider' = 'maker') => {
	const ephemeralPrivateKey = new Uint8Array(32).fill(8)
	const nonce = new Uint8Array(24).fill(9)
	const shared = x25519.getSharedSecret(ephemeralPrivateKey, x25519.getPublicKey(ENVELOPE_PRIVATE_KEY))
	const key = hkdf(sha256, shared, DOMAIN, DOMAIN, 32)
	return {
		version: 1 as const,
		ephemeralPublicKey: hex(x25519.getPublicKey(ephemeralPrivateKey)),
		nonce: hex(nonce),
		ciphertext: hex(xchacha20poly1305(key, nonce, new TextEncoder().encode(`${DOMAIN_TEXT}|${scope}=${subject.toLowerCase()}`)).encrypt(new TextEncoder().encode(JSON.stringify(value)))),
	}
}
const SEALED_MAKER = seal({
	schemaVersion: 2,
	maxBudget1: '10000000000',
	maxToken0ShareBps: 6000,
	maxToken0Value1: '6000000000',
	maxSwapValue1: '2000000000',
	maxTtlSec: 240,
})

const makeConfig = (): Config =>
	configSchema.parse({
		schedule: '0 */2 * * * *',
		authorizedEVMAddress: '0x1111111111111111111111111111111111111111',
		providerSecretId: 'PROVIDER_STRATEGY',
		providerStrategies: [{ strategyHash: `0x${'6'.repeat(64)}`, secretId: 'PROVIDER_STRATEGY_DEFENSIVE' }],
		makerSecretId: 'MAKER_LIMITS',
		envelopePrivateKeySecretId: 'ENVELOPE_PRIVATE_KEY',
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
	PROVIDER_STRATEGY_DEFENSIVE: JSON.stringify({ ...PROVIDER, strategyId: 'defensive-unit-test-strategy' }),
	MAKER_LIMITS: JSON.stringify(MAKER),
	ENVELOPE_PRIVATE_KEY: hex(ENVELOPE_PRIVATE_KEY),
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

const httpPayload = (value: unknown) => ({
	input: new TextEncoder().encode(JSON.stringify(value)),
}) as HTTPPayload

describe('onCronTrigger', () => {
	test('fetches both confidential inputs in a single getSecrets() call', () => {
		const { runtime, secretCalls } = makeFakeTeeRuntime()

		onCronTrigger(runtime)

		expect(secretCalls).toEqual([['PROVIDER_STRATEGY', 'MAKER_LIMITS']])
	})

	test('rejects a strategy hash without a configured Provider secret', () => {
		const { runtime, secretCalls } = makeFakeTeeRuntime()
		expect(() => onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-unknown',
			maker: makeConfig().maker,
			strategyHash: `0x${'7'.repeat(64)}`,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: SEALED_MAKER,
		}))).toThrow('No Provider secret is configured')
		expect(secretCalls).toEqual([])
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
		expect(reportLine).toContain(`"guard":"${runtime.config.guard}"`)
		expect(reportLine).toContain(`"router":"${runtime.config.router}"`)
		expect(reportLine).toContain('"chainId":"11155111"')
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
	test('registers cron and authorized HTTP handlers with Nitro TEE constraints', () => {
		const handlers = initWorkflow(makeConfig())

		expect(handlers).toHaveLength(2)
		expect(handlers[0].fn).toBe(onCronTrigger)
		expect(handlers[1].fn).toBe(onHttpTrigger)
		expect(handlers[0].requirements).toBeDefined()
		expect(handlers[1].requirements).toBeDefined()
	})
})

describe('onHttpTrigger', () => {
	test('opens a Provider-submitted strategy and Maker limits only inside the TEE', () => {
		const provider = '0x7777777777777777777777777777777777777777'
		const providerEnvelope = seal(PROVIDER, provider, 'provider')
		const { runtime, secretCalls, logs } = makeFakeTeeRuntime()
		runtime.config.providerBindings = [{ strategyHash: runtime.config.strategyHash, provider, strategyId: PROVIDER.strategyId, envelopeHash: keccak256(stringToHex(JSON.stringify(providerEnvelope))) }]
		const summary = onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-dynamic-provider',
			maker: SEALED_MAKER_ADDRESS,
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: SEALED_MAKER,
			provider,
			providerStrategyEnvelope: providerEnvelope,
		}))

		expect(secretCalls).toEqual([['ENVELOPE_PRIVATE_KEY']])
		expect(summary).toContain('allowedDirections=3')
		expect([...logs, summary].join('\n')).not.toContain(providerEnvelope.ciphertext)
		expect(() => onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-provider-replay',
			maker: SEALED_MAKER_ADDRESS,
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: SEALED_MAKER,
			provider: '0x8888888888888888888888888888888888888888',
			providerStrategyEnvelope: providerEnvelope,
		}))).toThrow('Provider publication is not bound')
	})

	test('requires Provider identity and encrypted policy together', () => {
		const { runtime } = makeFakeTeeRuntime()
		expect(() => onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-half-provider',
			maker: SEALED_MAKER_ADDRESS,
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: SEALED_MAKER,
			provider: '0x7777777777777777777777777777777777777777',
		}))).toThrow('providerStrategyEnvelope')
	})

	test('a sealed policy cannot move to another approved publication version or replace its ciphertext', () => {
		const provider = '0x7777777777777777777777777777777777777777'
		const providerStrategyEnvelope = seal(PROVIDER, provider, 'provider')
		const { runtime, secretCalls } = makeFakeTeeRuntime()
		runtime.config.providerBindings = [{ strategyHash: runtime.config.strategyHash, provider, strategyId: 'another-version', envelopeHash: keccak256(stringToHex(JSON.stringify(providerStrategyEnvelope))) }]
		const payload = { requestId: 'version-check', maker: SEALED_MAKER_ADDRESS, strategyHash: runtime.config.strategyHash,
			marketSnapshot: runtime.config.marketSnapshot, makerLimitsEnvelope: SEALED_MAKER, provider, providerStrategyEnvelope }
		expect(() => onHttpTrigger(runtime, httpPayload(payload))).toThrow('Provider policy version mismatch')
		secretCalls.length = 0
		expect(() => onHttpTrigger(runtime, httpPayload({ ...payload, providerStrategyEnvelope: seal({ ...PROVIDER, strategyId: 'another-version' }, provider, 'provider') }))).toThrow('Provider publication is not bound')
		expect(secretCalls).toEqual([])
	})

	test('decrypts dynamic Maker limits only after entering the TEE', () => {
		const { runtime, secretCalls, logs } = makeFakeTeeRuntime()
		const sealedLimits = seal({
			schemaVersion: 2,
			maxBudget1: '10000000000',
			maxToken0ShareBps: 6000,
			maxToken0Value1: '6000000000',
			maxSwapValue1: '50000000',
			maxTtlSec: 180,
		})
		const summary = onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-sealed',
			maker: '0x5555555555555555555555555555555555555555',
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: sealedLimits,
		}))

		expect(secretCalls).toEqual([['PROVIDER_STRATEGY', 'ENVELOPE_PRIVATE_KEY']])
		expect(summary).toContain('allowedDirections=3')
		expect([...logs, summary].join('\n')).not.toContain(sealedLimits.ciphertext)
		expect(() => onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-replayed',
			maker: '0x6666666666666666666666666666666666666666',
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: sealedLimits,
		}))).toThrow('confidential envelope could not be opened')
	})

	test('uses public request identity while fetching both private inputs inside the TEE', () => {
		const { runtime, secretCalls, logs } = makeFakeTeeRuntime()
		const summary = onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-01',
			maker: makeConfig().maker,
			strategyHash: `0x${'6'.repeat(64)}`,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimitsEnvelope: seal(MAKER, makeConfig().maker),
		}))

		expect(secretCalls).toEqual([['PROVIDER_STRATEGY_DEFENSIVE', 'ENVELOPE_PRIVATE_KEY']])
		expect(summary).toContain('requestId=mandate-01')
		expect(summary).toContain('allowedDirections=3')
		const report = logs.find((line) => line.includes('report={'))
		expect(report).toContain(makeConfig().maker)
		expect(report).toContain(`0x${'6'.repeat(64)}`)
		expect(report).toContain(`"guard":"${runtime.config.guard}"`)
		expect(report).toContain(`"router":"${runtime.config.router}"`)
	})

	test('rejects private fields and malformed payloads without echoing their values', () => {
		const { runtime } = makeFakeTeeRuntime()
		expect(() => onHttpTrigger(runtime, httpPayload({
			requestId: 'mandate-unsealed',
			maker: makeConfig().maker,
			strategyHash: makeConfig().strategyHash,
			marketSnapshot: makeConfig().marketSnapshot,
			makerLimits: 'TOP-SECRET-LIMITS',
		}))).toThrow('HTTP trigger payload failed schema validation')
		let message = ''
		try {
			onHttpTrigger(runtime, httpPayload({
				requestId: 'mandate-01',
				maker: makeConfig().maker,
				strategyHash: `0x${'6'.repeat(64)}`,
				marketSnapshot: makeConfig().marketSnapshot,
				makerLimitsEnvelope: SEALED_MAKER,
				makerLimits: 'TOP-SECRET-LIMITS',
			}))
		} catch (error) { message = (error as Error).message }
		expect(message).toContain('HTTP trigger payload failed schema validation')
		expect(message).not.toContain('TOP-SECRET-LIMITS')
	})
})


test('real delivery rejects fixed fixtures and requires explicit transport', () => {
  expect(() => configSchema.parse({ ...makeConfig(), publishMode: 'don-report' })).toThrow('Fixture market data requires dry-run')
  const { marketSnapshot, ...base } = makeConfig()
  expect(() => configSchema.parse({ ...base, marketSource: 'kraken', publishMode: 'don-report' })).toThrow('explicit transport')
})

test('HTTP uses the provisioned Maker policy for a matching wallet without exposing an envelope', () => {
	const { runtime, secretCalls } = makeFakeTeeRuntime()
	const summary = onHttpTrigger(runtime, httpPayload({ requestId: 'provisioned-maker', maker: runtime.config.maker, strategyHash: runtime.config.strategyHash, marketSnapshot: runtime.config.marketSnapshot }))
	expect(summary).toContain('allowedDirections=3')
	expect(secretCalls).toEqual([['PROVIDER_STRATEGY', 'MAKER_LIMITS']])
})

test('HTTP cannot reuse the provisioned Maker policy for another wallet', () => {
	const { runtime, secretCalls } = makeFakeTeeRuntime()
	expect(() => onHttpTrigger(runtime, httpPayload({ requestId: 'wrong-maker', maker: '0x5555555555555555555555555555555555555555',
		strategyHash: runtime.config.strategyHash, marketSnapshot: runtime.config.marketSnapshot }))).toThrow('Maker does not match the provisioned confidential policy')
	expect(secretCalls).toEqual([])
})

test('live HTTP acquisition rejects injected market data before private inputs are fetched', () => {
  const { runtime, secretCalls } = makeFakeTeeRuntime()
  const { marketSnapshot, ...base } = runtime.config
  runtime.config = configSchema.parse({ ...base, marketSource: 'kraken' })
  expect(() => onHttpTrigger(runtime, httpPayload({ requestId: 'injected-market', maker: runtime.config.maker,
    strategyHash: runtime.config.strategyHash, marketSnapshot, makerLimitsEnvelope: SEALED_MAKER }))).toThrow('rejects caller-supplied')
  expect(secretCalls).toEqual([])
})

describe('scenario isolation', () => {
  const scenario = () => ({ ...makeConfig(), marketSource: 'scenario', scenarioId: 'normal-v1', marketSnapshot: undefined, publishMode: 'don-report',
    transport: { profile: 'cre-simulation', forwarder: '0x15fc6ae953e024d975e77382eeec56a9101f9f88', workflowId: `0x${'0'.repeat(64)}`, workflowOwner: `0x${'0'.repeat(40)}`, gasLimit: '500000' } })
  test('requires a named simulation scenario and prevents production and snapshot overrides', () => {
    expect(configSchema.parse(scenario()).scenarioId).toBe('normal-v1')
    for (const patch of [{ scenarioId: undefined }, { scenarioId: 'custom' }, { marketSnapshot: makeConfig().marketSnapshot },
      { marketSource: 'kraken' }, { publishMode: 'dry-run' }, { transport: { ...scenario().transport, profile: 'cre-production' } }]) {
      expect(() => configSchema.parse({ ...scenario(), ...patch })).toThrow()
    }
  })
  test('cron and caller-supplied snapshots are rejected before any secret or capability call', () => {
    const { runtime, secretCalls, crossedToDons } = makeFakeTeeRuntime()
    runtime.config = configSchema.parse(scenario())
    expect(() => onCronTrigger(runtime)).toThrow('manual HTTP')
    expect(() => onHttpTrigger(runtime, httpPayload({ requestId: 'scenario-check', maker: runtime.config.maker,
      strategyHash: runtime.config.strategyHash, makerLimitsEnvelope: SEALED_MAKER, marketSnapshot: makeConfig().marketSnapshot }))).toThrow('without market overrides')
    expect(secretCalls).toEqual([])
    expect(crossedToDons()).toBe(0)
  })
})

describe('Builder two-phase simulation', () => {
  const envelope = { maxAmount0PerSwap: '100000000000000000', maxAmount1PerSwap: '1000000000',
    maxPostBalance0: '2000000000000000000', maxPostBalance1: '9000000000' }
  test('evaluation uses public atomic Maker caps and only a Provider secret; no write or private output', () => {
    const t = makeFakeTeeRuntime({ PROVIDER_STRATEGY: JSON.stringify(PROVIDER) })
    t.runtime.config = configSchema.parse({ ...makeConfig(), builderSimulation: true, builderEnvelope: envelope })
    const value = JSON.parse(onHttpTrigger(t.runtime, httpPayload({ requestId: 'builder-evaluate', maker: t.runtime.config.maker,
      strategyHash: t.runtime.config.strategyHash, marketSnapshot: t.runtime.config.marketSnapshot, builder: { phase: 'evaluate' } })))
    expect(value).toMatchObject({ phase: 'evaluate', status: 'evaluated', evidenceMode: 'cre-local-simulation',
      report: { schemaVersion: '2', validUntil: '0', allowedDirections: '3', ...envelope } })
    expect(t.secretCalls).toEqual([['PROVIDER_STRATEGY']])
    expect(t.crossedToDons()).toBe(0)
    expect(t.logs.join('\n')).not.toContain('calm-two-sided')
    expect(t.logs.join('\n')).not.toContain('volatilityBpsMax')
  })
  test('explicit HTTP phase and fixed Maker/hash required before secret access', () => {
    const t = makeFakeTeeRuntime()
    const input = { requestId: 'builder-test', maker: t.runtime.config.maker, strategyHash: t.runtime.config.strategyHash, builder: { phase: 'evaluate' } }
    expect(() => onHttpTrigger(t.runtime, httpPayload(input))).toThrow('disabled')
    t.runtime.config = configSchema.parse({ ...makeConfig(), builderSimulation: true, builderEnvelope: envelope })
    expect(() => onCronTrigger(t.runtime)).toThrow('HTTP event')
    expect(() => onHttpTrigger(t.runtime, httpPayload({ ...input, maker: SEALED_MAKER_ADDRESS }))).toThrow('provisioned Maker')
    expect(() => onHttpTrigger(t.runtime, httpPayload({ ...input, strategyHash: `0x${'6'.repeat(64)}` }))).toThrow('provisioned Maker')
    expect(() => onHttpTrigger(t.runtime, httpPayload({ ...input, makerLimitsEnvelope: SEALED_MAKER }))).toThrow('provisioned Maker')
    expect(() => onHttpTrigger(t.runtime, httpPayload({ ...input, builder: { phase: 'deliver', deliveryId: '12345678-1234-4234-8234-123456789012',
      nonce: '1', validAfter: '1800000000', termsHash: `0x${'1'.repeat(64)}` } }))).toThrow('simulation transport')
    expect(t.secretCalls).toEqual([])
  })
})
