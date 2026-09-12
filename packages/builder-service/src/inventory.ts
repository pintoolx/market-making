import type { Pool } from 'pg'
import { z } from 'zod'
import { canonical, contentDigest, decodeGuardedOrder, digestJson, idSchema, revisionSchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readBuilderInventory, inventoryEngine, type BuilderInventory, type InventoryReadOptions } from 'aqua-executor/builder-inventory'
import { createStore } from './store.ts'
import { conflict, ServiceError } from './errors.ts'
import type { TurnLease } from './turn-lease.ts'
import type { CompiledPayload } from './artifacts.ts'

export type InventorySnapshot = Omit<BuilderInventory, 'mode'> & { mode: 'live-read' | 'fork-with-overrides' | 'mock' }
export type InventoryAdapter = (maker: string, hashes: readonly string[], signal?: AbortSignal) => Promise<InventorySnapshot>
export const nativeInventoryAdapter = (profile: DeploymentProfile, options: Omit<InventoryReadOptions, 'signal'>): InventoryAdapter =>
  (maker, hashes, signal) => readBuilderInventory(profile, maker, hashes, { ...options, signal })
const inputSchema = z.object({ draftId: idSchema, expectedRevision: revisionSchema }).strict()

/** On-demand read, not a durable authorization or fund reservation. No transaction
 * holds a database connection across RPC. Wallet plans must capture their own fresh
 * preflight context; assistant prose is never a wallet-state artifact. */
export function createInventoryReader(pool: Pool, profile: DeploymentProfile, adapter: InventoryAdapter, lease?: TurnLease) {
  const store = createStore(pool, profile.id, lease)
  let inFlight = 0
  return {
    async read(owner: string, input: unknown, signal?: AbortSignal) {
      const { draftId, expectedRevision } = inputSchema.parse(input), draft = await store.get(owner, draftId)
      if (draft.spec.profileId !== profile.id) throw new ServiceError('profile-mismatch')
      if (draft.kind !== 'maker') throw new ServiceError('maker-instance-required')
      if (draft.maker !== owner.slice(7)) throw new ServiceError('wallet-ownership-required', 403)
      if (draft.revision !== expectedRevision) throw conflict('draft-changed')
      if (inFlight >= 8) throw new ServiceError('inventory-busy', 429)
      inFlight++
      try {
        // An artifact can survive revision edits or restores with the same onchain hash.
        // Read each known hash once; this remains a bounded and incomplete inventory.
        const rows = (await pool.query(`SELECT DISTINCT ON (payload->>'strategyHash') payload,payload_digest
          FROM builder.compiled_artifacts WHERE owner=$1 AND manifest_hash=$2 ORDER BY payload->>'strategyHash',created_at DESC LIMIT 41`,
        [owner, digestJson(profile)])).rows
        const hashes = rows.slice(0, 40).map(row => {
          const payload = row.payload as CompiledPayload
          if (row.payload_digest !== digestJson(payload) || payload.manifestHash !== digestJson(profile) || payload.order.maker !== draft.maker ||
            canonical(decodeGuardedOrder(payload.strategy)) !== canonical(payload.decoded) || payload.strategyHash !== payload.decoded.strategyHash) throw new ServiceError('compiled-artifact-integrity', 500)
          return payload.strategyHash
        })
        const result = await adapter(draft.maker!, hashes, signal)
        const latest = await store.get(owner, draftId)
        signal?.throwIfAborted()
        if (latest.revision !== expectedRevision || contentDigest(latest) !== contentDigest(draft)) throw conflict('draft-changed')
        if (result.maker !== draft.maker || result.chainId !== profile.chainId || result.manifestHash !== digestJson(profile) || result.engineVersion !== inventoryEngine ||
          !['live-read','fork-with-overrides','mock'].includes(result.mode) || result.registrationReady !== false || result.commitmentsComplete !== false ||
          canonical(result.tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals }))) !== canonical(profile.tokens)) throw new ServiceError('inventory-binding-mismatch', 503)
        return { draftId, revision: expectedRevision, contentDigest: contentDigest(draft), knownArtifactsTruncated: rows.length > 40,
          inventory: result, requestedAllocations: draft.allocations ?? null,
          allocationChecks: [
            { token: draft.spec.baseToken, allocation: draft.allocations?.baseAtomic },
            { token: draft.spec.quoteToken, allocation: draft.allocations?.quoteAtomic },
          ].filter(item => item.token && item.allocation).map(item => {
            const token = result.tokens.find(t => t.address === item.token!.address)!
            return { token: token.address, requestedAtomic: item.allocation!, walletSufficient: BigInt(token.walletBalanceAtomic) >= BigInt(item.allocation!),
              allowanceSufficient: BigInt(token.allowanceToAquaAtomic) >= BigInt(item.allocation!), uncommittedFundsVerified: false as const }
          }), registrationReady: false as const }
      } catch (error) {
        if (error instanceof ServiceError) throw error
        throw new ServiceError('inventory-read-unavailable', 503)
      } finally { inFlight-- }
    },
  }
}
