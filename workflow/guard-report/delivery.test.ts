import { expect, test as unitTest } from 'bun:test'
import { bytesToHex, hexToBase64, type TeeRuntime } from '@chainlink/cre-sdk'
import { EvmMock, REPORT_METADATA_HEADER_LENGTH, addContractMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { EVM_PB } from '@chainlink/cre-sdk/pb'
import { zeroAddress, zeroHash, type Hex } from 'viem'
import fixture from '../../docs/guard-report-v1/example.json'
import { CHAIN_ID, SIMULATION_FORWARDER, chainSelector, receiverAbi, submitPublicReport, submitPublicReportFromTee } from './delivery'
import { encodePublicReport, publicReportSchema } from './report'
import { configSchema, onCron } from './workflow'

const now = Number(fixture.report.validAfter)
const txHash = `0x${'ab'.repeat(32)}` as Hex
const report = { ...fixture.report, chainId: CHAIN_ID }
const simulation = { profile: 'cre-simulation' as const, forwarder: SIMULATION_FORWARDER,
  workflowId: zeroHash, workflowOwner: zeroAddress, gasLimit: '500000' }
const production = { ...simulation, profile: 'cre-production' as const, forwarder: `0x${'cd'.repeat(20)}`,
  workflowId: `0x${'ef'.repeat(32)}`, workflowOwner: report.maker }
const success = { txStatus: 'TX_STATUS_SUCCESS' as const, receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' as const, txHash: hexToBase64(txHash) }

function setup(transport: typeof simulation | typeof production = simulation, patch: Record<string, unknown> = {}) {
  const config = configSchema.parse({ schedule: '0 */5 * * * *', publicReport: { ...report, ...patch }, transport })
  const runtime = newTestRuntime(null, { timeProvider: () => now * 1000 }, config)
  const evm = EvmMock.testInstance(chainSelector)
  // JSON artifacts cannot retain literal ABI names in TypeScript. The mock still dispatches against the real artifact ABI.
  const guard = addContractMock(evm, { address: config.publicReport.guard, abi: receiverAbi }) as ReturnType<typeof addContractMock> &
    Partial<Record<'forwarder' | 'router' | 'simulationMode' | 'workflowId' | 'workflowOwner' | 'getReport' | 'activeStrategyHash', (...args: readonly unknown[]) => unknown>>
  guard.forwarder = () => config.transport.forwarder
  guard.router = () => config.publicReport.router
  guard.simulationMode = () => config.transport.profile === 'cre-simulation'
  guard.workflowId = () => config.transport.workflowId
  guard.workflowOwner = () => config.transport.workflowOwner
  guard.activeStrategyHash = () => zeroHash
  const encoded = encodePublicReport(config.publicReport)
  guard.getReport = () => [Object.fromEntries(Object.entries(encoded.report).map(([key, value]) => [key,
    ['schemaVersion', 'chainId', 'nonce', 'validAfter', 'validUntil', 'allowedDirections'].includes(key) || key.startsWith('max') ? BigInt(value) : value])), encoded.digest]
  let writes = 0
  guard.writeReport = input => {
    writes++
    expect(bytesToHex(input.receiver)).toBe(config.publicReport.guard)
    expect(bytesToHex(input.report.rawReport.slice(REPORT_METADATA_HEADER_LENGTH))).toBe(encoded.payload)
    expect(input.gasConfig.gasLimit).toBe(500000n)
    return success
  }
  return { config, runtime, guard, encoded, writes: () => writes }
}

unitTest('public report matches the shared 16-field ABI fixture exactly', () => {
  const encoded = encodePublicReport(fixture.report)
  expect(encoded.payload).toBe(fixture.encodedReport as Hex)
  expect(encoded.digest).toBe(fixture.reportHash as Hex)
  expect((encoded.payload.length - 2) / 2).toBe(512)
})

unitTest('public boundary rejects private/unknown fields, malformed integers and invalid Guard bounds', () => {
  for (const patch of [
    { privatePolicy: 'PRIVATE_CANARY' }, { nonce: 1 }, { nonce: '01' }, { nonce: '-1' }, { nonce: 'x' },
    { nonce: '0' }, { nonce: (1n << 64n).toString() }, { maxAmount0PerSwap: (1n << 128n).toString() },
    { maxPostBalance1: '0' }, { token1: report.token0 }, { guard: zeroAddress }, { strategyHash: zeroHash },
    { allowedDirections: '4' }, { allowedDirections: 'PRIVATE_CANARY' }, { validAfter: 'PRIVATE_CANARY' },
    { validUntil: report.validAfter }, { validUntil: String(now + 601) },
  ]) {
    expect(() => encodePublicReport({ ...report, ...patch })).toThrow('invalid public Guard report')
  }
  expect(publicReportSchema.safeParse({ ...report, allowedDirections: '0', maxAmount0PerSwap: '0', maxPostBalance1: '0' }).success).toBe(true)
})

test('public cron entry sends ABI bytes through SDK report/writeReport and verifies Guard readback', () => {
  const t = setup()
  const result = onCron(t.runtime)
  expect(result).toMatchObject({ profile: 'cre-simulation', nonce: report.nonce, reportDigest: t.encoded.digest, transactionHash: txHash })
  expect(t.writes()).toBe(1)
  expect(t.runtime.getLogs().join('\n')).not.toContain('privatePolicy')
  // A retry sends identical application bytes, nonce and validity; it never invents a fresh authorization.
  expect(onCron(t.runtime)).toEqual(result)
  expect(t.writes()).toBe(2)
})

test('production profile requires matching workflow identity and forwarder before any write', () => {
  const t = setup(production)
  expect(onCron(t.runtime).profile).toBe('cre-production')
  for (const [field, value] of [['forwarder', SIMULATION_FORWARDER], ['router', zeroAddress],
    ['simulationMode', true], ['workflowId', zeroHash], ['workflowOwner', zeroAddress]] as const) {
    const saved = t.guard[field]
    t.guard[field] = () => value
    expect(() => onCron(t.runtime)).toThrow('Guard immutable configuration')
    expect(t.writes()).toBe(1)
    t.guard[field] = saved
  }
})

test('expired, future and wrong-chain reports fail before report delivery', () => {
  const t = setup()
  for (const time of [now - 1, Number(report.validUntil)]) {
    t.runtime.setTimeProvider(() => time * 1000)
    expect(() => onCron(t.runtime)).toThrow('not current')
  }
  expect(() => submitPublicReport(t.runtime, { ...report, chainId: '84532' }, simulation)).toThrow('Ethereum Sepolia only')
  expect(t.writes()).toBe(0)
})

test('older V2 receivers without active strategy enforcement fail before any write', () => {
  const t = setup()
  t.guard.activeStrategyHash = () => { throw new Error('unknown selector') }
  expect(() => onCron(t.runtime)).toThrow('Maker-scoped active strategies')
  expect(t.writes()).toBe(0)
})

test('receiver revert, absent status, failed transaction and missing hash cannot be reported as success', () => {
  const t = setup()
  const cases: EVM_PB.WriteReportReplyJson[] = [
    { ...success, receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED' },
    { txStatus: 'TX_STATUS_SUCCESS', txHash: hexToBase64(txHash) },
    { ...success, txStatus: 'TX_STATUS_REVERTED' }, { ...success, txStatus: 'TX_STATUS_FATAL' },
    { txStatus: 'TX_STATUS_SUCCESS', receiverContractExecutionStatus: 'RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS' },
    { ...success, txHash: hexToBase64(zeroHash) }, { ...success, txHash: hexToBase64('0xab') },
  ]
  for (const receipt of cases) {
    t.guard.writeReport = () => receipt
    expect(() => onCron(t.runtime)).toThrow('successful receiver receipt')
  }
  t.guard.writeReport = () => success
  const getReport = t.guard.getReport!
  t.guard.getReport = () => [(getReport() as unknown[])[0], zeroHash]
  expect(() => onCron(t.runtime)).toThrow('Guard readback does not match')
})

test('TEE adapter validates public output before crossing to DON and uses the same delivery path', () => {
  const t = setup(production)
  let crossings = 0
  const tee = { usingTheDons: () => { crossings++; return t.runtime } } as unknown as TeeRuntime<unknown>
  expect(() => submitPublicReportFromTee(tee, { ...report, privatePolicy: 'PRIVATE_CANARY' }, production)).toThrow('invalid public Guard report')
  expect(crossings).toBe(0)
  expect(submitPublicReportFromTee(tee, report, production).reportDigest).toBe(t.encoded.digest)
  expect(crossings).toBe(1)
  expect(t.writes()).toBe(1)
  expect(t.runtime.getLogs().join('\n')).not.toContain('PRIVATE_CANARY')
})
