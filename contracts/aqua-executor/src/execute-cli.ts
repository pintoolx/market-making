import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BaseError } from 'viem'
import { fromEnv, loadDeployment } from './config.ts'
import { executeRequest, executionStatus, watchExecution } from './execution-controller.ts'
import { parseExecutionRequest } from './execution-request.ts'
import { json } from './execution-store.ts'
import { createChainlinkPrices } from './prices.ts'
import type { PriceSnapshot } from './risk.ts'
import type { Deployment } from './types.ts'

const { values } = parseArgs({ options: {
  network: { type: 'string', default: 'local' }, request: { type: 'string' }, session: { type: 'string' },
  'state-dir': { type: 'string' }, deployment: { type: 'string' }, prices: { type: 'string' },
  watch: { type: 'boolean', default: false }, status: { type: 'boolean', default: false },
  validate: { type: 'boolean', default: false }, 'interval-ms': { type: 'string', default: '5000' },
} })
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())
try {
  if (values.validate) {
    if (!values.request || values.watch || values.status || values.session) throw new Error('--validate requires only --request <file>')
    const request = parseExecutionRequest(JSON.parse(readFileSync(values.request, 'utf8')))
    console.log(json({ valid: true, requestId: request.requestId, action: request.action, validation: 'schema only; chain state and signer are checked at execution' }))
  } else {
    if (Number(!!values.request) + Number(values.watch) + Number(values.status) !== 1) throw new Error('choose --request <file>, --session <id> --watch, or --session <id> --status')
    if ((values.watch || values.status) && !values.session) throw new Error('--watch/--status requires --session <id>')
    const ctx = fromEnv(values.network)
    const d: Deployment = values.deployment ? JSON.parse(readFileSync(values.deployment, 'utf8')) : loadDeployment(ctx.chain.id)
    const stateDir = values['state-dir'] ? resolve(values['state-dir']) : join(fileURLToPath(new URL('../.state/executor/', import.meta.url)), String(ctx.chain.id))
    const getPrices = values.prices ? async (): Promise<PriceSnapshot> => {
      const p = JSON.parse(readFileSync(values.prices!, 'utf8'))
      return { ...p, mode: p.mode === 'simulated' ? 'simulated' : 'file' }
    } : createChainlinkPrices(d)
    const options = { stateDir, getPrices, signal: stop.signal }
    const result = values.request
      ? await executeRequest(ctx, d, JSON.parse(readFileSync(values.request, 'utf8')), options)
      : values.watch
        ? await watchExecution(ctx, d, values.session!, { ...options, intervalMs: Number(values['interval-ms']), onCheck: r => console.log(json(r)) })
        : await executionStatus(ctx, d, stateDir, values.session!)
    if (!values.watch) console.log(json(result))
    if ('status' in result && result.status === 'failed') process.exitCode = 1
  }
} catch (e) {
  if (!stop.signal.aborted) {
    console.error(e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
