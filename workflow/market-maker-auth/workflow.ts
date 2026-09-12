import { cre, decodeJson, type HTTPPayload, type TeeRuntime } from '@chainlink/cre-sdk'
import { z } from 'zod'
import { GUARD_CONFIG } from '../src/config/guard'
import { computeAuthorization } from '../src/intersect'
import { publishAuthorization } from '../src/publish'
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
	makerSecretId: z.string(),
	/** See src/publish.ts. Defaults to dry-run until pengu confirms the Guard. */
	publishMode: z.enum(['dry-run', 'don-report', 'http-rpc']).default('dry-run'),
	/** Maker wallet the report authorises (funds never leave it). */
	maker: hexAddress,
	/** Confirmed Ethereum Sepolia deployment; never reuse Base Sepolia addresses. */
	guard: hexAddress,
	router: hexAddress,
	/** TODO(pengu): router.hash(order) of the Maker-approved guarded program. */
	strategyHash: hexBytes32,
	/**
	 * TODO: replace with an HTTPClient fetch from inside the enclave (price feed +
	 * Maker balances). Kept in config for a deterministic, offline simulation.
	 */
	marketSnapshot: marketSnapshotSchema,
})
export type Config = z.infer<typeof configSchema>

/**
 * HTTP trigger data is visible to the Workflow DON. It therefore carries only
 * public execution identity and market observations; private rules and limits
 * remain Vault DON secrets fetched after the callback enters the TEE.
 */
export const httpRequestSchema = z
	.object({
		requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
		maker: hexAddress,
		strategyHash: hexBytes32,
		marketSnapshot: marketSnapshotSchema,
	})
	.strict()
export type HTTPRequest = z.infer<typeof httpRequestSchema>

type ExecutionInput = Pick<Config, 'providerSecretId' | 'makerSecretId' | 'maker' | 'strategyHash' | 'marketSnapshot'>

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
	// ── 1. Both confidential inputs, one Vault DON round-trip ──
	// Secrets are released only into the attested enclave; one getSecrets()
	// call counts once against PerWorkflow.Secrets.CallLimit (5).
	const secrets = runtime
		.getSecrets([{ id: input.providerSecretId }, { id: input.makerSecretId }])
		.result()

	const strategy = parseSecretJson(providerStrategySchema, secrets[input.providerSecretId].value, 'PROVIDER_STRATEGY')
	const limits = parseSecretJson(makerLimitsSchema, secrets[input.makerSecretId].value, 'MAKER_LIMITS')

	// ── 2. Public observation ──
	const market = input.marketSnapshot

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
		// Timestamp-based nonce: strictly increasing as long as runs are ≥1 s
		// apart, and no enclave state is needed. See docs/authorization-format.md.
		nonce: BigInt(nowSec),
	})

	// NOTE: `authorization.trace` (matched rule id, which side bound each cap)
	// is intentionally never logged or returned — it would leak the private inputs.

	// ── 4. Deliver (seam) ──
	const published = publishAuthorization(runtime, authorization)

	// Only public report fields cross out of the enclave in this summary.
	const r = authorization.report
	return (
		`allowedDirections=${r.allowedDirections} nonce=${r.nonce} ` +
		`validAfter=${r.validAfter} validUntil=${r.validUntil} ` +
		`txHash=${published.txHash ?? 'none (dry-run)'}`
	)
}

// Cron remains useful for continuous re-evaluation of the configured strategy.
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => executeAuthorization(runtime, runtime.config)

// HTTP provides an on-demand product entry point. No request value is logged.
export const onHttpTrigger = (runtime: TeeRuntime<Config>, payload: HTTPPayload): string => {
	if (!payload.input?.length) throw new Error('HTTP trigger payload is empty')
	const parsed = httpRequestSchema.safeParse(decodeJson(payload.input))
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}:${i.code}`).join(', ')
		throw new Error(`HTTP trigger payload failed schema validation (${issues})`)
	}
	const result = executeAuthorization(runtime, {
		providerSecretId: providerSecretFor(runtime.config, parsed.data.strategyHash),
		makerSecretId: runtime.config.makerSecretId,
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
