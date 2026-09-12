import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDeployment } from '../src/config.ts'
import { buildProductStrategies, MAKER_STRATEGY_DEADLINE, MAKER_STRATEGY_RELEASE } from '../src/product-strategies.ts'
import { DEMO_ACCOUNTS, SEPOLIA } from '../src/sepolia.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'releases', MAKER_STRATEGY_RELEASE)
const strategies = buildProductStrategies(loadDeployment(SEPOLIA.chainId), DEMO_ACCOUNTS.maker)
mkdirSync(output, { recursive: true })

for (const item of strategies) {
  writeFileSync(join(output, `${item.listingId}.ship.json`), `${JSON.stringify(item.request, null, 2)}\n`)
}
writeFileSync(join(output, 'catalog.json'), `${JSON.stringify({
  schema: 'pintool-aqua-strategy-catalog-v1', release: MAKER_STRATEGY_RELEASE,
  chainId: SEPOLIA.chainId, maker: DEMO_ACCOUNTS.maker, deadline: MAKER_STRATEGY_DEADLINE,
  strategies: strategies.map(({ listingId, name, provider, range, strategyHash, strategy, request }) => ({
    listingId, name, provider, range, strategyHash, strategy,
    guardCaps: request.strategy.guard?.caps, amounts: request.strategy.amounts,
  })),
}, null, 2)}\n`)

console.log(JSON.stringify({ output, strategies: strategies.map(({ listingId, strategyHash }) => ({ listingId, strategyHash })) }, null, 2))
