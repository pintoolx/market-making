import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { database, transaction } from './database.ts'

export async function migrate(pool: Pool, directory = new URL('../migrations/', import.meta.url)) {
  const files = (await readdir(directory)).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()
  const migrations = await Promise.all(files.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8')
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
  }))
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(1919512180, 1)')
    await client.query('CREATE SCHEMA IF NOT EXISTS builder')
    await client.query('CREATE TABLE IF NOT EXISTS builder.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())')
    const applied = new Map((await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM builder.schema_migrations')).rows.map(r => [r.name, r.checksum]))
    for (const m of migrations) {
      if (applied.has(m.name)) {
        if (applied.get(m.name) !== m.checksum) throw new Error(`Migration checksum mismatch: ${m.name}`)
        continue
      }
      // A rolled-back app may use older additive migrations; never remove newer data.
      await client.query(m.sql)
      await client.query('INSERT INTO builder.schema_migrations(name, checksum) VALUES ($1, $2)', [m.name, m.checksum])
    }
    return { available: migrations.length, applied: migrations.filter(m => !applied.has(m.name)).length }
  })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = database(process.env.DATABASE_URL ?? '')
  try { console.log(JSON.stringify(await migrate(pool))) }
  catch { console.error('Builder migration failed; inspect migration state using the authorized database console.'); process.exitCode = 1 }
  finally { await pool.end() }
}
