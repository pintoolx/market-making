import { keccak256, stringToHex, verifyMessage } from 'viem'
import { parseRelease, parseEnvelope, publicationMessage } from '../../../shared/lp-release.mjs'
import { concentrationBounds, priceE18 } from './concentrated.ts'
import { compileExecution } from './execution-compile.ts'
import { parseExecutionRequest } from './execution-request.ts'
import type { RiskPolicy } from './risk.ts'
import type { Deployment, Hex } from './types.ts'

const display = (n: bigint) => `${n / 10n ** 18n}.${(n % 10n ** 18n).toString().padStart(18, '0')}`

/** Compile an immutable signed publication into the existing journal's ship request. No signing or broadcasting. */
export async function compileLpRelease(input: {
  publication: { release: unknown; envelope: unknown; signature: Hex; digest: Hex }
  maker: Hex; amounts: [string, string]; salt: string; deadline: number
  reference: { price: string; observedAt: number }; policy: RiskPolicy
}, deployment: Deployment, nowSec: number) {
  const { publication } = input, release = parseRelease(publication.release), envelope = parseEnvelope(publication.envelope)
  const message = publicationMessage(release, envelope), digest = keccak256(stringToHex(message))
  if (publication.digest !== digest || !await verifyMessage({ address: release.provider as Hex, message, signature: publication.signature })) throw new Error('Invalid signed publication')
  if (release.state !== 'published' || deployment.chainId !== 11155111 || deployment.guard?.version !== 2) throw new Error('Release requires the Sepolia Guard V2 deployment')
  if (!Number.isSafeInteger(nowSec) || !Number.isSafeInteger(input.reference.observedAt) || input.reference.observedAt > nowSec || nowSec - input.reference.observedAt > 90) throw new Error('Reference price is stale or invalid')
  if (!Number.isSafeInteger(input.deadline) || input.deadline <= nowSec || !/^(0|[1-9][0-9]{0,19})$/.test(input.salt)) throw new Error('Invalid program deadline or salt')
  const e = release.execution, price = priceE18(input.reference.price)
  // Round human bounds inward before converting to address-sorted raw square roots.
  const min = display((price * BigInt(10000 - e.rangeBelowBps) + 9999n) / 10000n)
  const max = display(price * BigInt(10000 + e.rangeAboveBps) / 10000n)
  const tokens: [Hex, Hex] = [deployment.tokens.WETH!, deployment.tokens.USDC!]
  if (tokens[0]?.toLowerCase() !== '0xfff9976782d46cc05630d1f6ebab18b2324d6b14' || tokens[1]?.toLowerCase() !== '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') throw new Error('Release token domain mismatch')
  const caps = { maxAmount0PerSwap: e.maxAmount0PerSwap, maxAmount1PerSwap: e.maxAmount1PerSwap, maxPostBalance0: e.maxPostBalance0, maxPostBalance1: e.maxPostBalance1 }
  if (input.amounts.some((amount, i) => !/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > BigInt(i === 0 ? e.maxPostBalance0 : e.maxPostBalance1))) throw new Error('Allocation exceeds the published envelope')
  const salt = (BigInt(keccak256(stringToHex(`${digest}:${input.salt}`))) & ((1n << 64n) - 1n)).toString()
  const reference = `${release.id}.v${release.version}.${salt}`
  const request = parseExecutionRequest({ schema: 'aqua-execution-v1', requestId: `ship-${reference}`, sessionId: reference, action: 'ship',
    strategy: { schema: 'aqua-swapvm-v1.0.2', chainId: deployment.chainId, maker: input.maker, tokens, amounts: input.amounts,
      program: { kind: 'concentrated', feeBps: 0, deadline: input.deadline, salt, ...concentrationBounds(tokens, [18, 6], min, max) },
      guard: { address: deployment.guard.address, version: 2, caps },
      meta: { producer: 'fixed-params', strategyVersion: release.version, paramsRevision: 1 } }, policy: input.policy })
  if (request.action !== 'ship') throw new Error('Expected ship request')
  const compiled = compileExecution(request.strategy)
  return { release: { id: release.id, version: release.version, digest }, range: { min, max }, request,
    strategyHash: compiled.strategyHash, strategy: compiled.strategy, reportRequired: true,
    workflowBinding: { strategyHash: compiled.strategyHash, provider: release.provider, strategyId: `${release.id}.v${release.version}`,
      envelopeHash: keccak256(stringToHex(JSON.stringify(envelope))) },
    catalogEntry: { name: release.name, provider: release.provider, strategyHash: compiled.strategyHash, programDeadline: input.deadline,
      release: { id: release.id, version: release.version, digest } } }
}
