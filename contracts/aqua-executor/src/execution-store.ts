import { chmodSync, closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TransactionReceipt } from 'viem'
import { decodeEvents, type Recorder } from './records.ts'
import type { Hex } from './types.ts'

export const json = (v: unknown): string => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)
export class ExecutionBusyError extends Error {}

/** Local-disk storage. A separate SQLite connection holds the OS writer lock while this DB commits intents. */
export class ExecutionStore {
  readonly dir: string
  private db: DatabaseSync
  private lock: DatabaseSync

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lockFile = join(dir, 'controller-lock.sqlite'), dataFile = join(dir, 'executions.sqlite')
    for (const f of [lockFile, dataFile]) { closeSync(openSync(f, 'a', 0o600)); chmodSync(f, 0o600) }
    this.lock = new DatabaseSync(lockFile, { timeout: 0 })
    try { this.lock.exec('BEGIN IMMEDIATE') }
    catch (e) {
      this.lock.close()
      if ((e as { errcode?: number }).errcode === 5) throw new ExecutionBusyError('another executor owns this state directory; retry after it finishes')
      throw e
    }
    try {
      this.db = new DatabaseSync(dataFile)
      this.db.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = EXTRA;
        CREATE TABLE IF NOT EXISTS state (bucket TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket, id)) STRICT;
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL, event_key TEXT UNIQUE, body TEXT NOT NULL) STRICT;
      `)
    } catch (e) { this.lock.close(); throw e }
  }
  close() { try { this.db.close() } finally { this.lock.close() } }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM state WHERE bucket=? AND id=?').get(bucket, id)
    return row ? JSON.parse(row.body as string) as T : undefined
  }
  put(bucket: string, id: string, body: unknown) {
    this.db.prepare('INSERT INTO state VALUES (?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET body=excluded.body').run(bucket, id, json(body))
  }
  all<T>(bucket: string): T[] {
    return this.db.prepare('SELECT body FROM state WHERE bucket=? ORDER BY id').all(bucket).map(r => JSON.parse(r.body as string))
  }
  atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  event(requestId: string, line: Record<string, unknown>, uniqueKey?: string) {
    this.db.prepare('INSERT OR IGNORE INTO events(request_id,event_key,body) VALUES (?,?,?)').run(requestId, uniqueKey ?? null, json(line))
  }
  recorder(requestId: string, chainId: number, explorer: string | null): Recorder {
    const file = join(this.dir, 'records', `${requestId}.jsonl`)
    const write = (line: { kind: string } & Record<string, unknown>, uniqueKey?: string) => this.event(requestId,
      { ...line, request_id: requestId, run_id: requestId, chain_id: chainId, at: new Date().toISOString() }, uniqueKey)
    return {
      file, write,
      execution: (action: string, r: TransactionReceipt, strategyHash?: Hex) => write({
        kind: 'execution', action, tx_hash: r.transactionHash, status: r.status, block_number: r.blockNumber,
        from: r.from, to: r.to, contract_address: r.contractAddress ?? null, gas_used: r.gasUsed,
        effective_gas_price: r.effectiveGasPrice, strategy_hash: strategyHash ?? null, events: decodeEvents(r.logs),
        explorer_url: explorer ? `${explorer}/tx/${r.transactionHash}` : null,
      }, `tx:${r.transactionHash}`),
    }
  }
  /** JSONL is an export of durable events, never the recovery source. Safe to regenerate after interruption. */
  export(requestId: string) {
    const dir = join(this.dir, 'records')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${requestId}.jsonl`), temp = `${file}.tmp`
    const rows = this.db.prepare('SELECT body FROM events WHERE request_id=? ORDER BY seq').all(requestId)
    writeFileSync(temp, rows.map(r => r.body).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 })
    renameSync(temp, file)
    return file
  }
}
