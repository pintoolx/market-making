/** The confidential evaluator crosses only its derived public report into the
 * shared delivery adapter. That adapter checks receiver identity, receipt status
 * and onchain report digest. Private policies and DecisionTrace never cross.
 */
import type { TeeRuntime } from '@chainlink/cre-sdk'
import type { z } from 'zod'
import { submitPublicReportFromTee } from '../guard-report/delivery'
import { transportSchema } from '../guard-report/config'
import { GUARD_CONFIG } from './config/guard'
import { encodeGuardReportV1, guardReportV1Hash, guardReportV1ToJson } from './encode'
import type { Authorization } from './types'

export type PublishMode = 'dry-run' | 'don-report' | 'http-rpc'
export type PublishResult = { txHash?: string; changed?: boolean; nonce?: string }
type PublishConfig = { publishMode?: PublishMode; transport?: z.infer<typeof transportSchema> }

export function publishAuthorization(runtime: TeeRuntime<PublishConfig>, result: Authorization): PublishResult {
	const mode = runtime.config.publishMode ?? 'dry-run'
	const report = guardReportV1ToJson(result.report)
	if (mode === 'dry-run') {
		// Simulation-only public output; no private trace or policy values.
		runtime.log(`[publish:dry-run] target=${result.report.guard} selector=${GUARD_CONFIG.onReportSignature} chainSelectorName=${GUARD_CONFIG.chainSelectorName}`)
		runtime.log(`[publish:dry-run] report=${JSON.stringify(report)}`)
		runtime.log(`[publish:dry-run] encodedReport=${encodeGuardReportV1(result.report)}`)
		runtime.log(`[publish:dry-run] reportHash=${guardReportV1Hash(result.report)}`)
		return {}
	}
	if (mode === 'http-rpc') throw new Error('publishAuthorization: http-rpc path not implemented')
	if (result.report.chainId !== GUARD_CONFIG.chainId || /^0x0{40}$/.test(result.report.guard) || /^0x0{40}$/.test(result.report.router)) {
		throw new Error('Ethereum Sepolia report requires a configured Guard and router')
	}
	const transport = transportSchema.safeParse(runtime.config.transport)
	if (!transport.success) throw new Error('Report delivery requires a valid explicit transport profile')
	const delivered = submitPublicReportFromTee(runtime, report, transport.data)
	return { txHash: delivered.transactionHash, changed: delivered.changed, nonce: delivered.nonce }
}
