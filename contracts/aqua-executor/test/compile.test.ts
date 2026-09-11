import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters, keccak256 } from 'viem'
import { compile } from '../src/compile.ts'
import type { AquaStrategyParams } from '../src/types.ts'

// Opcode indices of the DEPLOYED AquaSwapVMRouter v1.0.2 (swap-vm v1.0.2 src/opcodes/AquaOpcodes.sol).
// swap-vm `main` uses another table, and a wrong index is a silent no-op on-chain, so this test is the guard.
const OP = { deadline: 13, xycSwapXD: 17, salt: 20, flatFeeAmountInXD: 21 } as const

const params: AquaStrategyParams = {
  schema: 'aqua-swapvm-v1.0.2',
  chainId: 84532,
  maker: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  tokens: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
  amounts: ['2000000000000000000', '5000000000'],
  program: { kind: 'xyc', feeBps: 30, deadline: 1_800_000_000, salt: '42' },
  meta: { producer: 'fixed-params', strategyVersion: 1, paramsRevision: 1 },
}
const hex = (n: number | bigint, bytes: number) => n.toString(16).padStart(bytes * 2, '0')

test('program bytes follow the v1.0.2 AquaOpcodes table (golden)', () => {
  const c = compile(params)
  const expected =
    '0x' +
    `${hex(OP.deadline, 1)}05${hex(1_800_000_000, 5)}` + // deadline: uint40
    `${hex(OP.flatFeeAmountInXD, 1)}04${hex(3_000_000, 4)}` + // 30 bps on the 1e9 fee scale: uint32
    `${hex(OP.xycSwapXD, 1)}00` +
    `${hex(OP.salt, 1)}08${hex(42, 8)}` // salt: uint64
  assert.equal(c.order.data, expected)
  assert.equal(c.order.traits, 1n << 254n) // useAquaInsteadOfSignature, nothing else
  assert.deepEqual(c.amounts, [2_000_000_000_000_000_000n, 5_000_000_000n])
})

test('strategy bytes = abi.encode(Order) and strategyHash = keccak256(strategy)', () => {
  const c = compile(params)
  const independent = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' }] }],
    [c.order],
  )
  assert.equal(c.strategy, independent)
  assert.equal(c.strategyHash, keccak256(independent))
})

test('rejects params the executor must never ship', () => {
  const bad = (patch: object, re: RegExp) => assert.throws(() => compile({ ...params, ...patch } as AquaStrategyParams), re)
  bad({ schema: 'aqua-swapvm-main' }, /unsupported schema/)
  bad({ tokens: [params.tokens[0], params.tokens[0]] }, /duplicate token/)
  bad({ amounts: ['0', '1'] }, /amounts must be > 0/)
  bad({ program: { ...params.program, feeBps: 10_000 } }, /bad feeBps/)
  bad({ program: { ...params.program, feeBps: 1.5 } }, /bad feeBps/)
})
