/**
 * The ONE seam between the enclave decision and the Guard contract.
 *
 * Everything that depends on pengu's Guard deployment lives here and in
 * `config/guard.ts`; nothing else in workflow/ needs to change when the
 * delivery path is finalised.
 *
 * Facts this file is built on (see docs/AUTHORIZATION-FORMAT.md §Delivery):
 *  - `EVMClient.writeReport()` accepts only a DON `Runtime`, never a
 *    `TeeRuntime` (SDK 1.18.0 type signatures) → the enclave cannot write to the
 *    chain directly; it must cross back with `runtime.usingTheDons()`.
 *  - `HTTPClient.sendRequest()` DOES accept a `TeeRuntime` → a JSON-RPC path
 *    from inside the enclave is possible in principle (option A below).
 *  - The Guard already implements CRE's `onReport(bytes,bytes)` receiver
 *    interface and trusts the Keystone forwarder by address, which is exactly
 *    what `writeReport()` delivers through (option B below).
 */
import { bytesToHex, encodeCallMsg, EVMClient, getNetwork, hexToBase64, LATEST_BLOCK_NUMBER, TxStatus, type TeeRuntime } from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress } from 'viem'
import { GUARD_CONFIG } from './config/guard'
import { encodeGuardReportV1, guardReportV1Hash, guardReportV1ToJson } from './encode'
import type { Authorization } from './types'

export type PublishMode = 'dry-run' | 'don-report' | 'http-rpc'

export type PublishResult = {
	/** Present only when a transaction was actually broadcast. */
	txHash?: string
}

type PublishConfig = { publishMode?: PublishMode }
export const receiverCapabilitiesAbi = parseAbi([
	'function router() view returns (address)',
	'function activeStrategyHash(address maker) view returns (bytes32)',
])

/**
 * Deliver an authorization to the Guard. Returns `{ txHash }` when something
 * was broadcast, `{}` otherwise.
 *
 * Current behaviour (this sprint): `dry-run` — log the complete payload that
 * WOULD be sent and return `{}` so the whole workflow can be simulated end to end.
 */
export function publishAuthorization(runtime: TeeRuntime<PublishConfig>, result: Authorization): PublishResult {
	const encoded = encodeGuardReportV1(result.report)
	const hash = guardReportV1Hash(result.report)
	const mode: PublishMode = runtime.config.publishMode ?? 'dry-run'

	// ⚠️ TODO(remove-before-deploy): simulation-only logging. The report is
	// public by design, but production TEE handlers should not log at all.
	runtime.log(
		`[publish:${mode}] target=${result.report.guard} selector=${GUARD_CONFIG.onReportSignature} ` +
			`chainSelectorName=${GUARD_CONFIG.chainSelectorName}`,
	)
	runtime.log(`[publish:${mode}] report=${JSON.stringify(guardReportV1ToJson(result.report))}`)
	runtime.log(`[publish:${mode}] encodedReport=${encoded}`)
	runtime.log(`[publish:${mode}] reportHash=${hash}`)

	switch (mode) {
		case 'dry-run':
			return {}

		case 'don-report': {
			if (result.report.chainId !== GUARD_CONFIG.chainId || /^0x0{40}$/.test(result.report.guard) || /^0x0{40}$/.test(result.report.router)) {
				throw new Error('Ethereum Sepolia report requires a configured Guard and router')
			}
			// ── Option B: cross back to the DON, let it sign, deliver via forwarder ──
			// This is what the Guard (AquaGuard.sol) is written for: the Keystone
			// forwarder calls `onReport(metadata, report)` and the Guard checks
			// `msg.sender == forwarder` (+ workflow identity in production mode).
			//
			// TODO(pengu): confirm before enabling —
			//   1. result.report.guard is a Guard deployed with
			//      forwarder = GUARD_CONFIG.creMockForwarder (for `simulate --broadcast`)
			//      or the production KeystoneForwarder on Ethereum Sepolia.
			//   2. In production-identity mode the Guard's immutable workflowId/owner
			//      must equal this workflow's registered identity.
			//   3. GUARD_CONFIG.writeReportGasLimit covers onReport's storage writes.
			//   4. Which private key funds the broadcast (CRE_ETH_PRIVATE_KEY in .env).
			const donRuntime = runtime.usingTheDons()
			const network = getNetwork({ chainFamily: 'evm', chainSelectorName: GUARD_CONFIG.chainSelectorName, isTestnet: true })
			if (!network) throw new Error(`unknown network ${GUARD_CONFIG.chainSelectorName}`)
			const evm = new EVMClient(network.chainSelector.selector)
			const read = (functionName: 'router' | 'activeStrategyHash', args: readonly [] | readonly [`0x${string}`]) => {
				const reply = evm.callContract(donRuntime, { call: encodeCallMsg({ from: zeroAddress, to: result.report.guard,
					data: encodeFunctionData({ abi: receiverCapabilitiesAbi, functionName, args }) }), blockNumber: LATEST_BLOCK_NUMBER }).result()
				return decodeFunctionResult({ abi: receiverCapabilitiesAbi, functionName, data: bytesToHex(reply.data) })
			}
			if (read('router', []).toLowerCase() !== result.report.router.toLowerCase()) throw new Error('Guard router does not match the report domain')
			try { read('activeStrategyHash', [result.report.maker]) }
			catch { throw new Error('Guard must support Maker-scoped active strategies; replace the earlier V2 receiver') }
			const signed = donRuntime
				.report({
					encodedPayload: hexToBase64(encoded),
					encoderName: 'evm',
					signingAlgo: 'ecdsa',
					hashingAlgo: 'keccak256',
				})
				.result()

			const write = evm
				.writeReport(donRuntime, {
					receiver: result.report.guard,
					report: signed,
					gasConfig: { gasLimit: GUARD_CONFIG.writeReportGasLimit },
				})
				.result()

			if (write.txStatus !== TxStatus.SUCCESS || write.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS ||
				write.txHash?.length !== 32 || write.txHash.every(n => n === 0)) {
				throw new Error('writeReport lacks a successful receiver receipt; inspect the transaction before retrying')
			}
			return { txHash: bytesToHex(write.txHash) }
		}

		case 'http-rpc': {
			// ── Option A: stay inside the enclave, send a raw tx over JSON-RPC ──
			// `HTTPClient.sendRequest(runtime /* TeeRuntime */, …)` is the only
			// capability with a TeeRuntime overload, so the enclave could build and
			// sign a transaction itself (signing key as a Vault DON secret) and POST
			// `eth_sendRawTransaction`. The Guard would then need to trust a plain
			// EOA instead of the forwarder — a DIFFERENT contract than the one pengu
			// has built. Kept as a documented fallback only.
			//
			// TODO(pengu): only pursue if the forwarder path is blocked. Needs:
			//   - a Guard variant whose `onReport` (or a dedicated setter) accepts a
			//     configured signer EOA instead of the forwarder
			//   - an RPC URL + signer key as secrets (secrets.yaml), nonce/gas
			//     management inside the enclave (viem `signTransaction`)
			throw new Error('publishAuthorization: http-rpc path not implemented (TODO(pengu))')
		}
	}
}
