import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fromEnv, loadDeployment, RECORDS_DIR } from './config.ts'
import type { MonitorPlan } from './monitor.ts'
import { createMonitorSession } from './monitor-session.ts'
import { createChainlinkPrices } from './prices.ts'
import { recorder, runStamp } from './records.ts'
import type { PriceSnapshot } from './risk.ts'

const { values } = parseArgs({ options: {
  network: { type: 'string', default: 'local' }, plan: { type: 'string' }, prices: { type: 'string' },
  'price-source': { type: 'string', default: 'chainlink' }, 'interval-ms': { type: 'string', default: '5000' },
  once: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
} })
if (!values.plan) throw new Error('use --plan <plan.json>; prices default to Chainlink, or pass --prices <file.json>')
if (values['price-source'] !== 'chainlink' && values['price-source'] !== 'file') throw new Error('price-source must be chainlink or file')
if (values['price-source'] === 'file' && !values.prices) throw new Error('file prices require --prices <file.json>')
const interval = Number(values['interval-ms'])
if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('interval-ms must be an integer >= 100')
const ctx = fromEnv(values.network)
const d = loadDeployment(ctx.chain.id)
const getPlan = async (): Promise<MonitorPlan> => JSON.parse(readFileSync(values.plan!, 'utf8'))
const getPrices = values.prices
  ? async (): Promise<PriceSnapshot> => { const p = JSON.parse(readFileSync(values.prices!, 'utf8')); return { ...p, mode: p.mode === 'simulated' ? 'simulated' : 'file' } }
  : createChainlinkPrices(d)
const rec = recorder({ dir: RECORDS_DIR, runId: `monitor-${runStamp()}`, chainId: ctx.chain.id, explorer: ctx.explorer })
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())
const session = createMonitorSession(ctx, d, await getPlan(), getPrices, rec, { getPlan, stateFile: values.plan, dryRun: values['dry-run'], signal: stop.signal })
const print = (v: unknown) => console.log(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x))
try {
  if (values.once) print(await session.check())
  else await session.run({ intervalMs: interval, onCheck: print })
} catch (e) {
  if (!stop.signal.aborted) {
    rec.write({ kind: 'monitor-error', error: e instanceof Error ? e.message : String(e) })
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
} finally { console.log(`records: ${rec.file}`) }
