import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { getAddress, verifyMessage } from 'viem'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import { addressSchema, idSchema } from '@pintool/strategy-builder'
import { transaction } from './database.ts'
import { ServiceError } from './errors.ts'
import type { PrivyIdentity } from './privy.ts'

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
const unauthorized = () => new ServiceError('authentication-required', 401)
export interface Actor { owner: string; address: `0x${string}`; userId?: string }

/** Uses the existing connected EOA wallet for proof of ownership; no asset permission is granted by this login. */
export function createAuth(pool: Pool, config: { origin: string; chainId: number; privyAppId?: string }) {
  const origin = new URL(config.origin)
  if (origin.origin !== config.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) throw new Error('A trusted HTTPS application origin is required')
  z.number().int().positive().parse(config.chainId)
  const audience = `${origin.origin}|${config.chainId}${config.privyAppId ? '|privy:' + config.privyAppId : ''}`
  const proof = (identity?: PrivyIdentity) => {
    if (config.privyAppId && (!identity || identity.appId !== config.privyAppId || identity.expiresAt <= Date.now() / 1000)) throw unauthorized()
    return config.privyAppId ? identity : undefined
  }
  const matches = (row: any, identity?: PrivyIdentity) => identity
    ? row.privy_app_id === identity.appId && row.privy_user_id === identity.userId && row.privy_session_id === identity.sessionId
    : row.privy_app_id === null
  return {
    async challenge(input: unknown, identity?: PrivyIdentity) {
      const verified = proof(identity)
      const { address } = z.object({ address: addressSchema }).strict().parse(input)
      const now = new Date(), expiresAt = new Date(now.getTime() + 5 * 60000), sessionUntil = new Date(now.getTime() + 24 * 3600000)
      const id = randomUUID(), nonce = randomBytes(24).toString('hex')
      const message = createSiweMessage({ address: getAddress(address), domain: origin.host, scheme: origin.protocol.slice(0, -1),
        uri: origin.origin + '/builder', chainId: config.chainId, nonce, version: '1', issuedAt: now, expirationTime: sessionUntil,
        requestId: id, statement: 'Sign in to PinTool Strategy Builder. This grants no permission to move funds or publish a strategy.' })
      await pool.query(`INSERT INTO builder.login_challenges(id,address,message,expires_at,privy_app_id,privy_user_id,privy_session_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, address, message, expiresAt, verified?.appId ?? null, verified?.userId ?? null, verified?.sessionId ?? null])
      return { id, message, expiresAt: expiresAt.toISOString() }
    },
    async login(input: unknown, identity?: PrivyIdentity) {
      const verifiedIdentity = proof(identity)
      const value = z.object({ challengeId: idSchema, signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }).strict().parse(input)
      // Verify against server-held text only; clients cannot substitute domain, nonce, chain or scope.
      const saved = (await pool.query('SELECT address,message,privy_app_id,privy_user_id,privy_session_id FROM builder.login_challenges WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp()', [value.challengeId])).rows[0]
      if (!saved || !matches(saved, verifiedIdentity)) throw unauthorized()
      const signed = parseSiweMessage(saved.message)
      if (signed.domain !== origin.host || signed.uri !== origin.origin + '/builder' || signed.chainId !== config.chainId ||
        signed.scheme !== origin.protocol.slice(0, -1) || signed.requestId !== value.challengeId || signed.address?.toLowerCase() !== saved.address ||
        !signed.expirationTime || signed.expirationTime.getTime() <= Date.now()) throw unauthorized()
      let verified = false
      try { verified = await verifyMessage({ address: saved.address, message: saved.message, signature: value.signature as `0x${string}` }) } catch { /* no signature or credential logging */ }
      if (!verified) throw unauthorized()
      const token = randomBytes(32).toString('base64url'), owner = `wallet:${saved.address}`
      const signedExpiry = signed.expirationTime.toISOString()
      return transaction(pool, async client => {
        const consumed = await client.query(`UPDATE builder.login_challenges SET consumed_at=clock_timestamp()
          WHERE id=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id`, [value.challengeId])
        if (consumed.rowCount !== 1) throw unauthorized()
        await client.query(`INSERT INTO builder.sessions(token_hash,owner,address,expires_at,audience,privy_app_id,privy_user_id,privy_session_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tokenHash(token), owner, saved.address, signedExpiry, audience, verifiedIdentity?.appId ?? null, verifiedIdentity?.userId ?? null, verifiedIdentity?.sessionId ?? null])
        return { token, expiresAt: signedExpiry, actor: { owner, address: saved.address as `0x${string}`, ...(verifiedIdentity ? { userId: verifiedIdentity.userId } : {}) } }
      })
    },
    async authenticate(authorization?: string, identity?: PrivyIdentity): Promise<Actor> {
      const verified = proof(identity)
      const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      if (!token) throw unauthorized()
      const row = (await pool.query('SELECT owner,address,privy_app_id,privy_user_id,privy_session_id FROM builder.sessions WHERE token_hash=$1 AND audience=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()', [tokenHash(token), audience])).rows[0]
      if (!row || !matches(row, verified)) throw unauthorized()
      return { owner: row.owner, address: row.address, ...(verified ? { userId: verified.userId } : {}) }
    },
    async logout(authorization?: string) {
      const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      if (!token) throw unauthorized()
      await pool.query('UPDATE builder.sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND audience=$2', [tokenHash(token), audience])
      return { loggedOut: true }
    },
  }
}
