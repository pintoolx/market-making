import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { formatUnits, parseUnits } from 'viem'
import { compileLpRelease } from './lp-release.ts'

// This process only compiles public execution bytes. It never loads a wallet key.
let body = ''
for await (const chunk of process.stdin) {
  body += chunk
  if (body.length > 64_000) throw new Error('Activation request too large')
}
const input = JSON.parse(body)
const deployment = JSON.parse(await readFile(fileURLToPath(new URL('../deployments/11155111.json', import.meta.url)), 'utf8'))
const response = await fetch('https://api.kraken.com/0/public/Depth?pair=ETHUSDC&count=1', { signal: AbortSignal.timeout(10000) })
if (!response.ok) throw new Error('Reference feed unavailable')
const data = await response.json() as any
const book = data.result?.ETHUSDC
const now = Math.floor(Date.now() / 1000)
if (data.error?.length || !book || [book.bids?.[0]?.[2], book.asks?.[0]?.[2]].some(t => !Number.isFinite(t) || now - t > 90 || t > now + 15)) throw new Error('Reference feed is stale')
const price = formatUnits((parseUnits(book.bids[0][0], 8) + parseUnits(book.asks[0][0], 8)) / 2n, 8)
const reference = { price, observedAt: now }
const deadline = now + 30 * 86400
const plan = await compileLpRelease({ publication: input.publication, maker: input.maker, amounts: input.amounts,
  salt: BigInt(`0x${randomBytes(8).toString('hex')}`).toString(), deadline, reference,
  // Required compiler metadata; private Maker limits are evaluated separately by CRE.
  policy: { tokens: [deployment.tokens.WETH, deployment.tokens.USDC], baselineAmounts: input.amounts,
    maxDrawdownBps: 10000, maxPriceAgeSec: 90 } }, deployment, now)
process.stdout.write(JSON.stringify({ ...plan, reference, deployment }))
