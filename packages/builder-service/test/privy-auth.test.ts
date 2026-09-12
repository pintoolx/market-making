import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { generateKeyPair, SignJWT } from 'jose'
import { privateKeyToAccount } from 'viem/accounts'
import { database, migrate, createAuth, builderHandler } from '../src/index.ts'
import { createPrivyVerifier } from '../src/privy.ts'

const appId = 'pintool-test-app', origin = 'https://pintool.example'
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const keys = await generateKeyPair('ES256'), foreignKeys = await generateKeyPair('ES256')
const verifier = createPrivyVerifier(appId, keys.publicKey)
const jwt = (claims: Record<string, unknown> = {}, signingKey = keys.privateKey) => new SignJWT({
  sub: 'did:privy:alice', sid: 'session-one', aud: appId, iss: 'privy.io', iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
}).setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).sign(signingKey)
const name = 'pintool_builder_test_' + randomUUID().replaceAll('-', '')
let pool: ReturnType<typeof database>, admin: ReturnType<typeof database>
before(async () => {
  const url = new URL(process.env.BUILDER_TEST_DATABASE_URL ?? '')
  admin = database(url.toString()); await admin.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name; pool = database(url.toString()); await migrate(pool)
})
after(async () => {
  await pool?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`) } finally { await admin.end() } }
})

test('Privy verifier pins signature, app, issuer, expiry, required identity claims and token type', async () => {
  const verified = await verifier(await jwt())
  assert.equal(verified.userId, 'did:privy:alice'); assert.equal(verified.appId, appId)
  for (const claims of [{ aud: 'different-app' }, { iss: 'attacker' }, { exp: 1 }, { exp: undefined }, { sid: undefined },
    { sub: 'not-a-privy-id' }, { iat: Math.floor(Date.now() / 1000) + 300 }, { linked_accounts: '[]' }]) {
    await assert.rejects(verifier(await jwt(claims)), /privy-authentication-required/)
  }
  await assert.rejects(verifier(await jwt({}, foreignKeys.privateKey)), /privy-authentication-required/)
  await assert.rejects(verifier(), /privy-authentication-required/)
  await assert.rejects(verifier('invalid'), /privy-authentication-required/)
  const symmetric = await new SignJWT({ sub: 'did:privy:alice' }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32))
  await assert.rejects(verifier(symmetric), /privy-authentication-required/)
})

test('wallet challenges and sessions stay bound to the verified Privy app, user and session', async () => {
  const auth = createAuth(pool, { origin, chainId: 11155111, privyAppId: appId }), identity = await verifier(await jwt())
  await assert.rejects(auth.challenge({ address: account.address }), /authentication-required/)
  const challenge = await auth.challenge({ address: account.address }, identity)
  const input = { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) }
  await assert.rejects(auth.login(input, await verifier(await jwt({ sub: 'did:privy:bob' }))), /authentication-required/)
  await assert.rejects(auth.login(input, await verifier(await jwt({ sid: 'another-session' }))), /authentication-required/)
  const session = await auth.login(input, identity), authorization = 'Bearer ' + session.token
  assert.equal((await auth.authenticate(authorization, identity)).userId, identity.userId)
  await assert.rejects(auth.authenticate(authorization), /authentication-required/)
  await assert.rejects(auth.authenticate(authorization, await verifier(await jwt({ sid: 'another-session' }))), /authentication-required/)
  await assert.rejects(auth.authenticate(authorization, { ...identity, expiresAt: 1 }), /authentication-required/)
  // Token refresh preserves the same verified user/session and does not require another signature.
  assert.equal((await auth.authenticate(authorization, await verifier(await jwt()))).address, account.address.toLowerCase())
  const standalone = createAuth(pool, { origin, chainId: 11155111 })
  await assert.rejects(standalone.authenticate(authorization), /authentication-required/)
  const legacy = await standalone.challenge({ address: account.address })
  const legacySession = await standalone.login({ challengeId: legacy.id, signature: await account.signMessage({ message: legacy.message }) })
  await assert.rejects(auth.authenticate('Bearer ' + legacySession.token, identity), /authentication-required/)
  const rows = (await pool.query('SELECT * FROM builder.sessions WHERE privy_user_id=$1', [identity.userId])).rows
  assert.equal(JSON.stringify(rows).includes(session.token), false)
})

test('HTTP requires both current Privy verification and the matching wallet session, including token refresh', async () => {
  const handler = builderHandler(pool, { origin, chainId: 11155111, profileId: 'sepolia-standing-v2', privyAppId: appId }, { verifyPrivy: verifier })
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end() } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  let privyToken: string | undefined, walletToken: string | undefined
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${address.port}/v1/builder${path}`, { method: body ? 'POST' : 'GET', headers: {
      origin, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
      ...(privyToken ? { 'x-privy-access-token': privyToken } : {}), ...(walletToken ? { authorization: 'Bearer ' + walletToken } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json() as any }
  }
  try {
    assert.equal((await call('/auth/challenge', { address: account.address })).status, 401)
    privyToken = await jwt()
    const challenge = (await call('/auth/challenge', { address: account.address })).body
    walletToken = (await call('/auth/login', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) })).body.token
    assert.equal((await call('/conversations', { title: 'Privy owned draft', kind: 'template' })).status, 200)
    privyToken = await jwt({ sub: 'did:privy:bob' })
    assert.equal((await call('/conversations')).status, 401)
    privyToken = undefined
    assert.equal((await call('/auth/session')).status, 401)
    privyToken = await jwt()
    assert.equal((await call('/auth/session')).body.actor.userId, 'did:privy:alice')
    assert.equal((await call('/auth/logout', {})).status, 200)
    assert.equal((await call('/conversations')).status, 401)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
