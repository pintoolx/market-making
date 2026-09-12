import { cre, type TeeRuntime } from '@chainlink/cre-sdk'
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
	/** Logical secret ids declared in ../secrets.yaml. */
	providerSecretId: z.string(),
	makerSecretId: z.string(),
	/** See src/publish.ts. Defaults to dry-run until pengu confirms the Guard. */
	publishMode: z.enum(['dry-run', 'don-report', 'http-rpc']).default('dry-run'),
	/** Maker wallet the report authorises (funds never leave it). */
	maker: hexAddress,
	/** TODO(pengu): router.hash(order) of the Maker-approved guarded program. */
	strategyHash: hexBytes32,
	/**
	 * TODO: replace with an HTTPClient fetch from inside the enclave (price feed +
	 * Maker balances). Kept in config for a deterministic, offline simulation.
	 */
	marketSnapshot: marketSnapshotSchema,
})
export type Config = z.infer<typeof configSchema>

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

// ─── TEE Cron Callback ──────────────────────────────────────
// Everything here runs inside the enclave until publishAuthorization()
// explicitly crosses back with `usingTheDons()` (only in don-report mode).
export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// ── 1. Both confidential inputs, one Vault DON round-trip ──
	// Secrets are released only into the attested enclave; one getSecrets()
	// call counts once against PerWorkflow.Secrets.CallLimit (5).
	const secrets = runtime
		.getSecrets([{ id: config.providerSecretId }, { id: config.makerSecretId }])
		.result()

	const strategy = parseSecretJson(providerStrategySchema, secrets[config.providerSecretId].value, 'PROVIDER_STRATEGY')
	const limits = parseSecretJson(makerLimitsSchema, secrets[config.makerSecretId].value, 'MAKER_LIMITS')

	// ── 2. Public observation ──
	const market = config.marketSnapshot

	// ── 3. Intersect (pure, deterministic) ──
	// DON consensus time, not Date.now() — see docs "Time in workflows".
	const nowSec = Math.floor(runtime.now().getTime() / 1000)
	const identity: ReportIdentity = {
		chainId: GUARD_CONFIG.chainId,
		guard: GUARD_CONFIG.guard,
		router: GUARD_CONFIG.router,
		maker: config.maker as `0x${string}`,
		strategyHash: config.strategyHash as `0x${string}`,
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

// ─── Workflow Init ──────────────────────────────────────────
export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		// AWS Nitro in us-west-2 is currently the only registered TEE type/region.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}
