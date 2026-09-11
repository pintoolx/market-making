import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeEventLog, erc20Abi, type Log, type TransactionReceipt } from 'viem'
import { aquaAbi, routerAbi } from './abi.ts'
import type { Hex } from './types.ts'

const eventsAbi = [...aquaAbi, ...routerAbi, ...erc20Abi].filter(x => x.type === 'event')

export interface DecodedEvent {
  logIndex: number | null
  address: Hex
  event: string
  args: Record<string, unknown>
}

/** Aqua / SwapVM events have no indexed params, so emitter address + topic0 is the only reliable filter. */
export function decodeEvents(logs: Log[], emitters?: Hex[]): DecodedEvent[] {
  const allow = emitters && new Set(emitters.map(a => a.toLowerCase()))
  return logs
    .filter(l => !allow || allow.has(l.address.toLowerCase()))
    .map(l => {
      try {
        const e = decodeEventLog({ abi: eventsAbi, data: l.data, topics: l.topics })
        return { logIndex: l.logIndex, address: l.address, event: e.eventName, args: e.args as Record<string, unknown> }
      } catch {
        return { logIndex: l.logIndex, address: l.address, event: 'unknown', args: { topic0: l.topics[0] } }
      }
    })
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
export const runStamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * JSONL transaction log, one file per run: <dir>/<chainId>/<runId>.jsonl
 * - `execution`: one line per tx (maps to a future aqua_executions table)
 * - `check`: an on-chain post-condition read after a tx (Aqua rawBalances)
 * - `cycle`: one summary line per run (maps to PinTool's private_execution_cycles)
 */
export function recorder(o: { dir: string; runId: string; chainId: number; explorer: string | null }) {
  mkdirSync(join(o.dir, String(o.chainId)), { recursive: true })
  const file = join(o.dir, String(o.chainId), `${o.runId}.jsonl`)
  const write = (line: { kind: string } & Record<string, unknown>) =>
    appendFileSync(file, json({ ...line, run_id: o.runId, chain_id: o.chainId, at: new Date().toISOString() }) + '\n')
  return {
    file,
    write,
    execution(action: string, r: TransactionReceipt, strategyHash?: Hex) {
      write({
        kind: 'execution',
        action,
        tx_hash: r.transactionHash,
        status: r.status,
        block_number: r.blockNumber,
        from: r.from,
        to: r.to,
        contract_address: r.contractAddress ?? null,
        gas_used: r.gasUsed,
        effective_gas_price: r.effectiveGasPrice,
        strategy_hash: strategyHash ?? null,
        events: decodeEvents(r.logs),
        explorer_url: o.explorer ? `${o.explorer}/tx/${r.transactionHash}` : null,
      })
    },
  }
}
export type Recorder = ReturnType<typeof recorder>
