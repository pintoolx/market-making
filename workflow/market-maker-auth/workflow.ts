import { cre, decodeJson, type HTTPPayload, type TeeRuntime } from '@chainlink/cre-sdk'
import { z } from 'zod'
import { keccak256, stringToHex } from 'viem'
import { GUARD_CONFIG } from '../src/config/guard'
import { confidentialEnvelopeSchema, openConfidentialEnvelope, type ConfidentialEnvelope } from '../src/confidential-envelope'
import { computeAuthorization } from '../src/intersect'
import { publishAuthorization } from '../src/publish'
import { acquireMarket } from '../src/market-data'
import { acquireScenarioMarket, scenarioIdSchema } from '../src/market-scenarios'
import { transportSchema } from '../guard-report/config'
import {
	makerLimitsSchema,
	marketSnapshotSchema,
	providerStrategySchema,
	type ReportIdentity,
} from '../src/types'

// ─── Config Schema (public, non-secret) ─────────────────────
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const hexBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)

export const configSchema = z.object({
	schedule: z.string(),
	/** EVM address allowed to sign production HTTP trigger requests. */
	authorizedEVMAddress: hexAddress,
	/** Logical secret ids declared in ../secrets.yaml. */
	providerSecretId: z.string(),
	/** Additional Aqua strategy hashes and their isolated Provider secrets. */
	providerStrategies: z
		.array(z.object({ strategyHash: hexBytes32, secretId: z.string().min(1) }))
		.max(12)
		.default([]),
	/** Operator-approved publication versions, bound to the exact Maker program and ciphertext. */
	providerBindings: z.array(z.object({ strategyHash: hexBytes32, provider: hexAddress, strategyId: z.string().min(1), envelopeHash: hexBytes32 }).strict()).default([]),
	makerSecretId: z.string(),
	/** X25519 private key stored in Vault DON; its public half is embedded in the web app. */
	envelopePrivateKeySecretId: z.string().default('ENVELOPE_PRIVATE_KEY'),
	/** See src/publish.ts. Defaults to dry-run until pengu confirms the Guard. */
	publishMode: z.enum(['dry-run', 'don-report', 'http-rpc']).default('dry-run'),
	/** Maker wallet the report authorises (funds never leave it). */
	maker: hexAddress,
	/** Confirmed Ethereum Sepolia deployment; never reuse Base Sepolia addresses. */
	guard: hexAddress,
	router: hexAddress,
	/** TODO(pengu): router.hash(order) of the Maker-approved guarded program. */
	strategyHash: hexBytes32,
	/** Live mode acquires public observations itself; fixtures are dry-run only. */
	marketSource: z.enum(['fixture', 'kraken', 'scenario']).default('fixture'),
	scenarioId: scenarioIdSchema.optional(),
	marketSnapshot: marketSnapshotSchema.optional(),
	transport: transportSchema.optional(),
}).superRefine((config, ctx) => {
	if (config.marketSource === 'fixture' && (config.publishMode !== 'dry-run' || !config.marketSnapshot)) {
		ctx.addIssue({ code: 'custom', message: 'Fixture market data requires dry-run and a marketSnapshot' })
	}
	if (config.marketSource === 'kraken' && config.marketSnapshot !== undefined) {
		ctx.addIssue({ code: 'custom', message: 'Live acquisition must not carry a fixture marketSnapshot' })
	}
	if (config.marketSource === 'scenario') {
		if (!config.scenarioId || config.marketSnapshot !== undefined || config.publishMode !== 'don-report' || config.transport?.profile !== 'cre-simulation') {
			ctx.addIssue({ code: 'custom', message: 'Market scenarios require an explicit scenario ID, no fixture snapshot, and CRE simulation report transport' })
		}
	} else if (config.scenarioId !== undefined) {
		ctx.addIssue({ code: 'custom', message: 'Scenario ID is not allowed in live or fixture mode' })
	}
	if (config.publishMode === 'don-report' && !config.transport) {
		ctx.addIssue({ code: 'custom', message: 'Report delivery requires an explicit transport profile' })
	}
})
export type Config = z.infer<typeof configSchema>

/**
 * HTTP trigger data is visible to the Workflow DON. It therefore carries only
 * public execution identity, market observations and an encrypted Maker
 * envelope. Plaintext Provider rules remain Vault DON secrets; plaintext Maker
 * limits exist only in the browser and the attested enclave.
 */
export const httpRequestSchema = z
	.object({
		requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
		maker: hexAddress,
		strategyHash: hexBytes32,
		marketSnapshot: marketSnapshotSchema.optional(),
		/** Optional for a pre-provisioned Maker; required when using a browser-sealed policy. */
		makerLimitsEnvelope: confidentialEnvelopeSchema.optional(),
		provider: hexAddress.optional(),
		providerStrategyEnvelope: confidentialEnvelopeSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (!!value.provider !== !!value.providerStrategyEnvelope) context.addIssue({
			code: 'custom',
			path: ['providerStrategyEnvelope'],
			message: 'provider and providerStrategyEnvelope must be supplied together',
		})
	})
export type HTTPRequest = z.infer<typeof httpRequestSchema>

type ExecutionInput = Pick<Config, 'maker' | 'strategyHash' | 'marketSnapshot'> & {
	requestId?: string
	providerSecretId?: string
	provider?: string
	providerStrategyEnvelope?: ConfidentialEnvelope
	expectedStrategyId?: string
	makerSecretId?: string
	envelopePrivateKeySecretId?: string
	makerLimitsEnvelope?: ConfidentialEnvelope
}

const providerSecretFor = (config: Config, strategyHash: string): string => {
	const normalized = strategyHash.toLowerCase()
	const configured = config.providerStrategies.find((item) => item.strategyHash.toLowerCase() === normalized)
	if (configured) return configured.secretId
	if (config.strategyHash.toLowerCase() === normalized) return config.providerSecretId
	throw new Error('No Provider secret is configured for this strategy hash')
}

/** Zod error → path + code only. Never echo the offending value of a secret. */
const parseSecretJson = <S extends z.ZodTypeAny>(schema: S, raw: string, label: string): z.infer<S> => {
	let json: unknown
	try {
		json = JSON.parse(raw)
	} catch {
		throw new Error(`${label}: secret is not valid JSON`)
	}
	const parsed = schema.safeParse(json)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}:${i.code}`).join(', ')
		throw new Error(`${label}: secret failed schema validation (${issues})`)
	}
	return parsed.data
}

// ─── Confidential execution ─────────────────────────────────
// Everything here runs inside the enclave until publishAuthorization()
// explicitly crosses back with `usingTheDons()` (only in don-report mode).
const executeAuthorization = (runtime: TeeRuntime<Config>, input: ExecutionInput): string => {
	const config = configSchema.parse(runtime.config)
	if (!input.makerLimitsEnvelope && input.maker.toLowerCase() !== config.maker.toLowerCase()) throw new Error('Maker does not match the provisioned confidential policy')
	// Acquire and validate PUBLIC data before fetching private inputs. Only maker
	// and public data-source config are used in DON capability calls.
	if (config.marketSource === 'kraken' && input.marketSnapshot !== undefined) throw new Error('Live acquisition rejects caller-supplied marketSnapshot')
	if (config.marketSource === 'scenario' && (input.marketSnapshot !== undefined || !input.requestId || input.maker.toLowerCase() !== config.maker.toLowerCase())) throw new Error('Scenario execution requires a provisioned Maker HTTP request without market overrides')
	const scenario = config.marketSource === 'scenario'
		? acquireScenarioMarket(runtime.usingTheDons(), input.maker, config.scenarioId!) : undefined
	const market = scenario?.market ?? (config.marketSource === 'kraken'
		? acquireMarket(runtime.usingTheDons(), input.maker).market
		: marketSnapshotSchema.parse(input.marketSnapshot))
	if (scenario) runtime.log(JSON.stringify({ kind: 'cre-market-scenario', requestId: input.requestId, strategyHash: input.strategyHash, ...scenario.evidence }))

	// ── 1. Both confidential inputs, one Vault DON round-trip ──
	// Secrets are released only into the attested enclave; one getSecrets()
	// call counts once against PerWorkflow.Secrets.CallLimit (5).
	const makerSecretId = input.makerLimitsEnvelope ? input.envelopePrivateKeySecretId : input.makerSecretId
	if (!makerSecretId) throw new Error('Maker confidential input is not configured')
	if (!input.providerSecretId && (!input.provider || !input.providerStrategyEnvelope)) throw new Error('Provider confidential input is not configured')
	const secretRequests = input.providerStrategyEnvelope
		? [{ id: makerSecretId }]
		: [{ id: input.providerSecretId! }, { id: makerSecretId }]
	const secrets = runtime
		.getSecrets(secretRequests)
		.result()

	const rawStrategy = input.providerStrategyEnvelope
		? openConfidentialEnvelope(input.providerStrategyEnvelope, secrets[makerSecretId].value, input.provider!, 'provider')
		: secrets[input.providerSecretId!].value
	const strategy = parseSecretJson(providerStrategySchema, rawStrategy, 'PROVIDER_STRATEGY')
	if (input.expectedStrategyId && strategy.strategyId !== input.expectedStrategyId) throw new Error('Provider policy version mismatch')
	const rawLimits = input.makerLimitsEnvelope
		? openConfidentialEnvelope(input.makerLimitsEnvelope, secrets[makerSecretId].value, input.maker)
		: secrets[makerSecretId].value
	const limits = parseSecretJson(makerLimitsSchema, rawLimits, 'MAKER_LIMITS')

	// ── 3. Intersect (pure, deterministic) ──
	// DON consensus time, not Date.now() — see docs "Time in workflows".
	const nowSec = Math.floor(runtime.now().getTime() / 1000)
	const identity: ReportIdentity = {
		chainId: GUARD_CONFIG.chainId,
		guard: runtime.config.guard as `0x${string}`,
		router: runtime.config.router as `0x${string}`,
		maker: input.maker as `0x${string}`,
		strategyHash: input.strategyHash as `0x${string}`,
		token0: GUARD_CONFIG.token0,
		token1: GUARD_CONFIG.token1,
	}
	const authorization = computeAuthorization({
		strategy,
		limits,
		market,
		identity,
		nowSec,
		// Timestamp nonce for serialized executions. Same-second/concurrent
		// attempts can be rejected; inspect receipt/state before retrying.
		// This is not a durable production nonce allocator.
		nonce: BigInt(nowSec),
	})

	// NOTE: `authorization.trace` (matched rule id, which side bound each cap)
	// is intentionally never logged or returned — it would leak the private inputs.

	// ── 4. Deliver (seam) ──
	const published = publishAuthorization(runtime, authorization)

	// Only public report fields cross out of the enclave in this summary.
	const r = authorization.report
	return (
		`allowedDirections=${r.allowedDirections} nonce=${published.nonce ?? r.nonce} ` +
		`validAfter=${r.validAfter} validUntil=${r.validUntil} ` +
		`txHash=${published.txHash ?? (published.changed === false ? 'unchanged' : 'none (dry-run)')}`
	)
}

// Cron remains useful for continuous re-evaluation of the configured strategy.
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	if (runtime.config.marketSource === 'scenario') throw new Error('Market scenarios are manual HTTP executions only')
	return executeAuthorization(runtime, runtime.config)
}

// HTTP provides an on-demand product entry point. No request value is logged.
export const onHttpTrigger = (runtime: TeeRuntime<Config>, payload: HTTPPayload): string => {
	if (!payload.input?.length) throw new Error('HTTP trigger payload is empty')
	const parsed = httpRequestSchema.safeParse(decodeJson(payload.input))
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}:${i.code}`).join(', ')
		throw new Error(`HTTP trigger payload failed schema validation (${issues})`)
	}
	let expectedStrategyId: string | undefined
	if (parsed.data.providerStrategyEnvelope) {
		const binding = runtime.config.providerBindings.find(item => item.strategyHash.toLowerCase() === parsed.data.strategyHash.toLowerCase())
		if (!binding || binding.provider.toLowerCase() !== parsed.data.provider!.toLowerCase()
			|| binding.envelopeHash.toLowerCase() !== keccak256(stringToHex(JSON.stringify(parsed.data.providerStrategyEnvelope)))) throw new Error('Provider publication is not bound to this program')
		expectedStrategyId = binding.strategyId
	}
	const result = executeAuthorization(runtime, {
		requestId: parsed.data.requestId,
		...(parsed.data.providerStrategyEnvelope
			? { provider: parsed.data.provider, providerStrategyEnvelope: parsed.data.providerStrategyEnvelope }
			: { providerSecretId: providerSecretFor(runtime.config, parsed.data.strategyHash) }),
		makerSecretId: runtime.config.makerSecretId,
		envelopePrivateKeySecretId: runtime.config.envelopePrivateKeySecretId,
		expectedStrategyId,
		makerLimitsEnvelope: parsed.data.makerLimitsEnvelope,
		maker: parsed.data.maker,
		strategyHash: parsed.data.strategyHash,
		marketSnapshot: parsed.data.marketSnapshot,
	})
	return `requestId=${parsed.data.requestId} ${result}`
}

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()
	const httpTrigger = new cre.capabilities.HTTPCapability()
	const tee: [{ tee: 'nitro'; regions: ['us-west-2'] }] = [{ tee: 'nitro', regions: ['us-west-2'] }]

	return [
		// AWS Nitro in us-west-2 is currently the only registered TEE type/region.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, tee),
		cre.handlerInTee(
			httpTrigger.trigger({
				authorizedKeys: [{ type: 'KEY_TYPE_ECDSA_EVM', publicKey: config.authorizedEVMAddress }],
			}),
			onHttpTrigger,
			tee,
		),
	]
}
