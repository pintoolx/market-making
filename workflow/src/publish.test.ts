import { expect } from 'bun:test'
import { getNetwork, hexToBase64, type TeeRuntime } from '@chainlink/cre-sdk'
import { EvmMock, addContractMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { zeroAddress, zeroHash } from 'viem'
import fixture from '../../docs/guard-report-v1/example.json'
import { GUARD_CONFIG } from './config/guard'
import { publishAuthorization } from './publish'
import { receiverAbi, SIMULATION_FORWARDER } from '../guard-report/config'
import { encodeGuardReportV1 } from './encode'
import { keccak256 } from 'viem'
import type { Authorization } from './types'

function setup() {
  const report = Object.fromEntries(Object.entries({ ...fixture.report, chainId: String(GUARD_CONFIG.chainId) }).map(([key, value]) => [key,
    ['schemaVersion', 'validAfter', 'validUntil', 'allowedDirections'].includes(key) ? Number(value)
      : ['chainId', 'nonce'].includes(key) || key.startsWith('max') ? BigInt(value) : value])) as unknown as Authorization['report']
  const don = newTestRuntime(null, { timeProvider: () => (report.validAfter + 1) * 1000 }, {})
  const tee = { config: { publishMode: 'don-report', transport: { profile: 'cre-simulation', forwarder: SIMULATION_FORWARDER, workflowId: zeroHash, workflowOwner: zeroAddress, gasLimit: '500000' } }, log: () => {}, usingTheDons: () => don } as unknown as TeeRuntime<{ publishMode: 'don-report' }>
  const chain = getNetwork({ chainFamily: 'evm', chainSelectorName: GUARD_CONFIG.chainSelectorName, isTestnet: true })!
  const guard = addContractMock(EvmMock.testInstance(chain.chainSelector.selector), { address: report.guard, abi: receiverAbi }) as ReturnType<typeof addContractMock> &
    Partial<Record<'forwarder' | 'router' | 'simulationMode' | 'workflowId' | 'workflowOwner' | 'getReport' | 'activeStrategyHash', (...args: readonly unknown[]) => unknown>>
  guard.router = () => report.router
  guard.activeStrategyHash = () => zeroHash
  guard.forwarder = () => SIMULATION_FORWARDER
  guard.simulationMode = () => true
  guard.workflowId = () => zeroHash
  guard.workflowOwner = () => zeroAddress
  guard.getReport = () => [report, keccak256(encodeGuardReportV1(report))]
  const txHash = `0x${'ab'.repeat(32)}` as const
  const success = { txStatus: 'TX_STATUS_SUCCESS' as const, receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' as const, txHash: hexToBase64(txHash) }
  let writes = 0
  guard.writeReport = () => { writes++; return success }
  return { tee, guard, success, txHash, result: { report } as Authorization, writes: () => writes }
}

test('confidential publisher accepts a successful receiver on the configured Sepolia domain', () => {
  const t = setup()
  expect(publishAuthorization(t.tee, t.result)).toEqual({ txHash: t.txHash })
  expect(t.writes()).toBe(1)
})

test('confidential publisher rejects earlier V2 receivers and a different router before writing', () => {
  const t = setup()
  t.guard.router = () => zeroAddress
  expect(() => publishAuthorization(t.tee, t.result)).toThrow('Guard immutable configuration')
  t.guard.router = () => t.result.report.router
  t.guard.activeStrategyHash = () => { throw new Error('unknown selector') }
  expect(() => publishAuthorization(t.tee, t.result)).toThrow('Maker-scoped active strategies')
  expect(t.writes()).toBe(0)
})

test('confidential publisher cannot report an outer success with a failed receiver or missing hash', () => {
  const t = setup()
  for (const receipt of [
    { ...t.success, receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' as const },
    { txStatus: t.success.txStatus, txHash: t.success.txHash },
    { txStatus: t.success.txStatus, receiverContractExecutionStatus: t.success.receiverContractExecutionStatus },
    { ...t.success, txHash: hexToBase64(zeroHash) },
  ]) {
    t.guard.writeReport = () => receipt
    expect(() => publishAuthorization(t.tee, t.result)).toThrow('successful receiver receipt')
  }
})
