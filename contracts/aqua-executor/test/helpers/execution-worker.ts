import { readFileSync } from 'node:fs'
import { ANVIL_KEYS, connect } from '../../src/config.ts'
import { executeRequest } from '../../src/execution-controller.ts'
import { foundry } from 'viem/chains'

const [rpc, deploymentFile, requestFile, priceFile, stateDir, phase, step, hold] = process.argv.slice(2)
const ctx = connect(foundry, rpc!, ANVIL_KEYS[0], ANVIL_KEYS[1])
await executeRequest(ctx, JSON.parse(readFileSync(deploymentFile!, 'utf8')), JSON.parse(readFileSync(requestFile!, 'utf8')), {
  stateDir: stateDir!, getPrices: async () => JSON.parse(readFileSync(priceFile!, 'utf8')),
  onTransaction: async event => {
    if (event.phase === phase && event.step === step) {
      if (hold === 'hold') {
        console.log('LOCKED')
        await new Promise(() => { setInterval(() => {}, 1000) })
      } else process.kill(process.pid, 'SIGKILL')
    }
  },
})
