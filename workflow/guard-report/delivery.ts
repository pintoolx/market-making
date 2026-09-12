import {
  EVMClient, LATEST_BLOCK_NUMBER, TxStatus,
  bytesToHex, encodeCallMsg, getNetwork, hexToBase64, type Runtime, type TeeRuntime,
} from '@chainlink/cre-sdk'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import { decodeFunctionResult, encodeFunctionData, zeroAddress, type Hex } from 'viem'
import { encodePublicReport, requireCurrent } from './report'

import { CHAIN_NAME, CHAIN_ID, receiverAbi, transportSchema } from './config'
export { CHAIN_NAME, CHAIN_ID, SIMULATION_FORWARDER, receiverAbi, transportSchema } from './config'
export const chainSelector = getNetwork({ chainFamily: 'evm', chainSelectorName: CHAIN_NAME, isTestnet: true })!.chainSelector.selector

/** B route: DON report -> EVM writeReport -> configured forwarder -> Guard.onReport. */
export function submitPublicReport(runtime: Runtime<unknown>, publicInput: unknown, transportInput: unknown) {
  const encoded = encodePublicReport(publicInput)
  const transport = transportSchema.safeParse(transportInput)
  if (!transport.success) throw new Error('invalid Guard transport configuration')
  const { report, payload, digest } = encoded
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
  const signed = runtime.report({ encodedPayload: hexToBase64(payload), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result()
  const receipt = evm.writeReport(runtime, {
    receiver: report.guard, report: signed, gasConfig: { gasLimit: expected.gasLimit },
  }).result()
  // The forwarder transaction may succeed while the receiver fails. Never accept only txStatus.
  if (receipt.txStatus !== TxStatus.SUCCESS || receipt.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS ||
    receipt.txHash?.length !== 32 || receipt.txHash.every(n => n === 0)) {
    throw new Error('CRE delivery lacks a successful receiver receipt; inspect before retrying the identical report')
  }
  const result = { profile: expected.profile, chainId: CHAIN_ID, strategyHash: report.strategyHash,
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
