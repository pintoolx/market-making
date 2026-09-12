import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { fromEnv, loadDeployment } from './config.ts'
import { autopilotTick, parseAutopilotPolicy } from './autopilot.ts'
import { ExecutionBusyError, json } from './execution-store.ts'
import { createChainlinkPrices } from './prices.ts'
import { MonitorDataError, type PriceSnapshot } from './risk.ts'
import type { Deployment } from './types.ts'

const { values } = parseArgs({ options: { help: { type: 'boolean' }, network: { type: 'string', default: 'local' }, deployment: { type: 'string' },
  session: { type: 'string' }, 'state-dir': { type: 'string' }, policy: { type: 'string' }, prices: { type: 'string' },
  execute: { type: 'boolean', default: false }, watch: { type: 'boolean', default: false }, 'interval-ms': { type: 'string', default: '5000' } } })
if (values.help) {
  console.log('Usage: npm run autopilot -- --network local --session ID --state-dir DIR --policy FILE [--deployment FILE] [--prices FILE] [--execute] [--watch] [--interval-ms 5000]\nDefaults to a proposal without transactions. See docs/LP-STRATEGIES.md for policy fields and expiry rollover behavior.')
  process.exit(0)
}
const stop = new AbortController()
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort())
try {
  if (!values.session || !values['state-dir'] || !values.policy) throw new Error('--session, --state-dir and --policy are required')
  const interval = Number(values['interval-ms'])
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error('interval must be 100–60000 ms')
  const ctx = fromEnv(values.network), d: Deployment = values.deployment ? JSON.parse(readFileSync(values.deployment, 'utf8')) : loadDeployment(ctx.chain.id)
  const policy = parseAutopilotPolicy(JSON.parse(readFileSync(values.policy, 'utf8')))
  const getPrices = values.prices ? async (): Promise<PriceSnapshot> => {
    const p = JSON.parse(readFileSync(values.prices!, 'utf8')); return { ...p, mode: p.mode === 'simulated' ? 'simulated' : 'file' }
  } : createChainlinkPrices(d)
  do {
    try {
      const result = await autopilotTick(ctx, d, values.session, policy, { stateDir: resolve(values['state-dir']), getPrices, execute: values.execute, signal: stop.signal })
      console.log(json(result))
      if ('result' in result && result.result?.status === 'failed') process.exitCode = 1
    } catch (e) {
      if (!values.watch || !(e instanceof MonitorDataError || e instanceof ExecutionBusyError)) throw e
      console.error(e.message)
    }
    if (!values.watch) break
    await sleep(interval, undefined, { signal: stop.signal })
  } while (!stop.signal.aborted)
} catch (e) {
  if (!stop.signal.aborted) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1 }
}
