import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { ServiceError } from './errors.ts'

export interface PrivyIdentity { appId: string; userId: string; sessionId: string; expiresAt: number }
const appSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/)

/** App-pinned public JWKS; no app secret, caller-selected URL, token logging or wallet signing. */
export function createPrivyVerifier(appId: string, verificationKey?: CryptoKey | JWTVerifyGetKey) {
  appSchema.parse(appId)
  // Endpoint and claim contract checked against @privy-io/node 0.34.0 source.
  const key = verificationKey ?? createRemoteJWKSet(new URL(`https://api.privy.io/v1/apps/${appId}/jwks.json`), {
    timeoutDuration: 5000, cacheMaxAge: 3600000, cooldownDuration: 30000,
  })
  return async (header?: string): Promise<PrivyIdentity> => {
    try {
      if (!header || header.length > 16384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(header)) throw new Error('invalid token')
      const { payload } = await jwtVerify(header, key as JWTVerifyGetKey, {
        algorithms: ['ES256'], typ: 'JWT', issuer: 'privy.io', audience: appId,
        requiredClaims: ['sub','sid','iat','exp'], maxTokenAge: '2h', clockTolerance: 5,
      })
      if (typeof payload.sub !== 'string' || !/^did:privy:[a-zA-Z0-9_-]{1,160}$/.test(payload.sub) ||
        typeof payload.sid !== 'string' || payload.sid.length < 1 || payload.sid.length > 200 ||
        typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || 'linked_accounts' in payload) throw new Error('invalid claims')
      return { appId, userId: payload.sub, sessionId: payload.sid, expiresAt: payload.exp }
    } catch { throw new ServiceError('privy-authentication-required', 401) }
  }
}
