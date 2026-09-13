import { decodeAbiParameters, encodeAbiParameters, keccak256, type Hex } from 'viem'
import { AQUA_OPCODES } from './capabilities.ts'

export const orderAbi = [{ type: 'tuple', components: [
  { name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' },
] }] as const
export interface Instruction { pc: number; opcode: number; name: string; args: Hex }

export function decodeInstructions(program: Hex): Instruction[] {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(program) || program.length > 32770) throw new Error('invalid program bytes')
  const out: Instruction[] = []
  for (let pc = 0; pc < (program.length - 2) / 2;) {
    const pos = 2 + pc * 2
    if (pos + 4 > program.length) throw new Error('truncated instruction header')
    const opcode = Number.parseInt(program.slice(pos, pos + 2), 16), size = Number.parseInt(program.slice(pos + 2, pos + 4), 16)
    const name = AQUA_OPCODES[opcode]
    if (!name || name === 'reserved') throw new Error('unknown or reserved opcode')
    if (pos + 4 + size * 2 > program.length) throw new Error('truncated instruction arguments')
    out.push({ pc, opcode, name, args: `0x${program.slice(pos + 4, pos + 4 + size * 2).toLowerCase()}` })
    pc += 2 + size
  }
  return out
}

/** Independent decoder: no SwapVM SDK, no encoder-generated instruction trace. */
export function decodeGuardedOrder(encoded: Hex) {
  const [order] = decodeAbiParameters(orderAbi, encoded)
  if (encodeAbiParameters(orderAbi, [order]).toLowerCase() !== encoded.toLowerCase()) throw new Error('noncanonical encoded order')
  if (order.traits !== 1n << 254n) throw new Error('unverified traits, receiver or hooks')
  const instructions = decodeInstructions(order.data), pattern = instructions.map(i => i.opcode).join(',')
  const fee = instructions.find(i => i.opcode === 21), feeScale = fee ? Number(BigInt(fee.args)) : 0
  const hasSupportedFee = !fee || (fee.args.length === 10 && Number.isSafeInteger(feeScale) && feeScale > 0 && feeScale <= 999_900_000 && feeScale % 100_000 === 0)
  const feeBps = hasSupportedFee ? feeScale / 100_000 : -1
  const kind = pattern === '13,17,20,32' || pattern === '13,21,17,20,32' ? 'xyc' :
    pattern === '13,18,17,20,32' || pattern === '13,21,18,17,20,32' ? 'concentrated' :
    pattern === '13,31,20,32' || pattern === '13,21,31,20,32' ? 'pegged' : null
  if (!kind) throw new Error('not a verified straight-line guarded recipe')
  if (!hasSupportedFee || instructions.filter(i => i.opcode === 21).length > 1 || (fee && instructions[1]?.opcode !== 21)) throw new Error('unsupported fee encoding')
  const lengths: Record<number, number> = { 13: 5, 17: 0, 18: 64, 20: 8, 21: 4, 31: 160, 32: 125 }
  for (const instruction of instructions) if ((instruction.args.length - 2) / 2 !== lengths[instruction.opcode]) throw new Error('invalid instruction argument length')
  const deadline = Number(BigInt(instructions[0]!.args)), salt = BigInt(instructions.at(-2)!.args).toString()
  const args = instructions.at(-1)!.args
  const guard = args.slice(0, 42) as Hex, envelope = `0x${args.slice(42)}` as Hex
  if (envelope.slice(0, 4) !== '0x02') throw new Error('Guard V2 envelope required')
  const baseToken = `0x${envelope.slice(4, 44)}` as Hex, quoteToken = `0x${envelope.slice(44, 84)}` as Hex
  const values = [84, 116, 148, 180].map(offset => BigInt(`0x${envelope.slice(offset, offset + 32)}`).toString())
  if ([guard, baseToken, quoteToken, order.maker].some(a => /^0x0{40}$/i.test(a)) || baseToken === quoteToken || values.some(v => BigInt(v) === 0n) || deadline === 0) throw new Error('invalid Guard domain/envelope')
  const words = (instruction: Instruction) => Array.from({ length: (instruction.args.length - 2) / 64 }, (_, i) => BigInt(`0x${instruction.args.slice(2 + i * 64, 66 + i * 64)}`).toString())
  const curveInstruction = instructions.find(i => i.opcode === (kind === 'concentrated' ? 18 : kind === 'pegged' ? 31 : 17))
  if (!curveInstruction) throw new Error('missing curve instruction')
  return { maker: order.maker.toLowerCase() as Hex, traits: order.traits.toString(), program: order.data, kind, feeBps, deadline, salt,
    guard, envelope, baseToken, quoteToken,
    guardEnvelope: { maxAmountBasePerSwap: values[0]!, maxAmountQuotePerSwap: values[1]!, maxPostBalanceBase: values[2]!, maxPostBalanceQuote: values[3]! },
    curveArgs: kind === 'xyc' ? [] : words(curveInstruction), instructions,
    programHash: keccak256(order.data), orderHash: keccak256(encoded), strategyHash: keccak256(encoded),
  }
}
