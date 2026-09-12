import {
  EVMClient, LATEST_BLOCK_NUMBER, TxStatus,
  bytesToHex, encodeCallMsg, getNetwork, hexToBase64, type Runtime, type TeeRuntime,
} from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Hex } from 'viem'
import { encodePublicReport, requireCurrent, sameStandingAuthorization } from './report'

import { CHAIN_NAME, CHAIN_ID, receiverAbi, transportSchema } from './config'
export { CHAIN_NAME, CHAIN_ID, SIMULATION_FORWARDER, receiverAbi, transportSchema } from './config'
export const chainSelector = getNetwork({ chainFamily: 'evm', chainSelectorName: CHAIN_NAME, isTestnet: true })!.chainSelector.selector

/** B route: DON report -> EVM writeReport -> configured forwarder -> Guard.onReport. */
export function submitPublicReport(runtime: Runtime<unknown>, publicInput: unknown, transportInput: unknown) {
  let encoded = encodePublicReport(publicInput)
  const transport = transportSchema.safeParse(transportInput)
  if (!transport.success) throw new Error('invalid Guard transport configuration')
  let { report, payload, digest } = encoded
  const expected = transport.data
  if (report.chainId !== CHAIN_ID) throw new Error('delivery adapter supports Ethereum Sepolia only')
  requireCurrent(report, Math.floor(runtime.now().getTime() / 1000))
  const evm = new EVMClient(chainSelector)
  const read = (functionName: string, args: unknown[] = []) => {
    const response = evm.callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: report.guard,
        data: encodeFunctionData({ abi: receiverAbi, functionName, args }) }),
      blockNumber: LATEST_BLOCK_NUMBER,
    }).result()
    return decodeFunctionResult({ abi: receiverAbi, functionName, data: bytesToHex(response.data) })
  }
  // Prevent accidentally targeting the old project harness or a production Guard through the simulator.
  const configured = [read('forwarder'), read('router'), read('simulationMode'), read('workflowId'), read('workflowOwner')]
  const wanted = [expected.forwarder, report.router, expected.profile === 'cre-simulation', expected.workflowId, expected.workflowOwner]
  if (configured.some((value, i) => typeof value === 'string' ? value.toLowerCase() !== wanted[i] : value !== wanted[i])) {
    throw new Error('Guard immutable configuration does not match the requested delivery profile')
  }
  // Older V2 deployments share the report ABI but cannot enforce one active strategy per Maker.
  let activeHash: string
  try { activeHash = read('activeStrategyHash', [report.maker]) as string }
  catch { throw new Error('Guard must support Maker-scoped active strategies; replace the earlier V2 receiver before delivery') }
  if (report.schemaVersion === '2') {
    if (Number(read('reportSchemaVersion')) < 2) throw new Error('Guard does not support standing authorization')
    const [prior, priorDigest] = read('getReport', [report.maker, report.strategyHash]) as readonly [Record<string, unknown>, Hex]
    if (BigInt(String(prior.nonce)) > 0n) {
      const saved = encodePublicReport(Object.fromEntries(Object.entries(prior).map(([key, value]) => [key, String(value)])))
      if (saved.digest !== priorDigest) throw new Error('Stored Guard report digest mismatch')
      if (saved.report.schemaVersion === '2') requireCurrent(saved.report, Math.floor(runtime.now().getTime() / 1000))
      if (sameStandingAuthorization(report, saved.report, activeHash)) {
        const result = { changed: false, profile: expected.profile, chainId: CHAIN_ID, strategyHash: report.strategyHash,
          nonce: saved.report.nonce, reportDigest: priorDigest, transactionHash: undefined }
        runtime.log(JSON.stringify({ kind: 'cre-authorization-unchanged', ...result }))
        return result
      }
      // Serialize against actual Guard state, including same-second reevaluations.
      if (BigInt(report.nonce) <= BigInt(saved.report.nonce)) {
        encoded = encodePublicReport({ ...report, nonce: String(BigInt(saved.report.nonce) + 1n) })
        ;({ report, payload, digest } = encoded)
      }
    }
  }
  const signed = runtime.report({ encodedPayload: hexToBase64(payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result()
  const receipt = evm.writeReport(runtime, {
    receiver: report.guard, report: signed, gasConfig: { gasLimit: expected.gasLimit },
  }).result()
  // The forwarder transaction may succeed while the receiver fails. Never accept only txStatus.
  if (receipt.txStatus !== TxStatus.SUCCESS || receipt.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS ||
    receipt.txHash?.length !== 32 || receipt.txHash.every(n => n === 0)) {
    throw new Error('CRE delivery lacks a successful receiver receipt; inspect before retrying the identical report')
  }
  const result = { changed: true, profile: expected.profile, chainId: CHAIN_ID, strategyHash: report.strategyHash,
    nonce: report.nonce, reportDigest: digest, transactionHash: bytesToHex(receipt.txHash) }
  runtime.log(JSON.stringify({ kind: 'cre-delivery-receipt', ...result }))
  // Readback confirms the expected report, rather than just a forwarder receipt. A stale RPC fails closed.
  const saved = read('getReport', [report.maker, report.strategyHash]) as readonly [unknown, Hex]
  if (saved[1] !== digest) throw new Error('Guard readback does not match the delivered report; inspect the recorded transaction')
  return result
}

/** Integration hook for a real confidential evaluator. Only validated PUBLIC output leaves the TEE. */
export function submitPublicReportFromTee(runtime: TeeRuntime<unknown>, publicInput: unknown, transportInput: unknown) {
  const { report } = encodePublicReport(publicInput)
  return submitPublicReport(runtime.usingTheDons(), report, transportInput)
}
