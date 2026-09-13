import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { verifyMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { defaultTemplatePermissions, digestJson, publicationMessage, publicationVersion, sepoliaStandingProfile as profile,
  withdrawalMessage, type PolicyEnvelope, type PriceSnapshot, type StrategySpec } from '@pintool/strategy-builder'
import { builderHandler, createArtifacts, createStore, createTemplates, database, migrate, type TemplateOptions } from '../src/index.ts'

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
const origin = 'http://localhost:3311', workflowPublicKey = '11'.repeat(32)
const templates = (options: Partial<TemplateOptions> = {}) => createTemplates(pool, profile, { origin, workflowPublicKey, ...options })
const person = () => { const account = privateKeyToAccount(generatePrivateKey()); return { account, owner: 'wallet:' + account.address.toLowerCase() } }
// Synthetic ciphertext for the publication boundary; actual browser/workflow encryption is tested separately.
const envelope = (): PolicyEnvelope => ({ version: 1, ephemeralPublicKey: randomBytes(32).toString('hex'), nonce: randomBytes(24).toString('hex'), ciphertext: randomBytes(40).toString('hex') })
const allocations = { baseAtomic: '10000000000000000', quoteAtomic: '25000000' }
async function prepared(model: StrategySpec['model'] = { kind: 'xyc' }) {
  const p = person(), store = createStore(pool, profile.id), t = templates()
  const created = await store.create(p.owner, randomUUID(), { title: 'Public Provider template', kind: 'template' })
  const { draft } = await store.patch(p.owner, randomUUID(), { draftId: created.draft.id, expectedRevision: 1, patch: { spec: {
    baseToken: profile.tokens[0], quoteToken: profile.tokens[1], feeBps: 0, deadline: Math.floor(Date.now() / 1000) + 86400, model,
    guardEnvelope: { maxAmountBasePerSwap: '5000000000000000', maxAmountQuotePerSwap: '12500000', maxPostBalanceBase: '20000000000000000', maxPostBalanceQuote: '50000000' },
  } } })
  const prepareInput = { draftId: draft.id, expectedRevision: 2, templateId: null, permissions: defaultTemplatePermissions }
  const { intent } = await t.prepare(p.owner, randomUUID(), prepareInput), cipher = envelope()
  const input = { intentId: intent.id, envelope: cipher, signature: await p.account.signMessage({ message: publicationMessage(intent, cipher) }) }
  return { ...p, draft, store, t, intent, cipher, input, prepareInput }
}
const instanceInput = (saved: Awaited<ReturnType<ReturnType<typeof templates>['publish']>>) => ({ templateId: saved.template.templateId, version: saved.template.version, digest: saved.digest, allocations })

test('signed immutable publications commit private ciphertext once and public responses/requests/outbox never copy it', async () => {
  const p = await prepared(), key = randomUUID()
  const [a,b,c] = await Promise.all([p.t.publish(p.owner,key,p.input),p.t.publish(p.owner,key,p.input),p.t.publish(p.owner,randomUUID(),p.input)])
  assert.deepEqual(a,b); assert.deepEqual(b,c)
  assert.deepEqual(a.template, publicationVersion(p.intent,p.cipher)); assert.equal(a.registrationReady,false); assert.equal(a.policyStatus,'encrypted-unverified')
  assert.ok(await verifyMessage({ address: a.template.provider, message: a.proof.message, signature: a.proof.signature }))
  const row = (await pool.query('SELECT * FROM builder_private.provider_policies WHERE template_id=$1', [a.template.templateId])).rows[0]
  assert.deepEqual(row.envelope,p.cipher); assert.equal(row.envelope_digest,digestJson(p.cipher))
  const publicRows = [a,await p.t.list(),(await pool.query('SELECT * FROM builder.requests WHERE owner=$1',[p.owner])).rows,
    (await pool.query('SELECT * FROM builder.outbox WHERE owner=$1',[p.owner])).rows]
  assert.equal(JSON.stringify(publicRows).includes(p.cipher.ciphertext),false)
  for (const table of ['builder.template_versions','builder.publication_intents','builder_private.provider_policies']) {
    const column = table.endsWith('publication_intents') ? 'id' : 'template_id', id = column === 'id' ? p.intent.id : a.template.templateId
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE ${column}=$1`,[id]),/immutable/)
  }
  assert.equal((await pool.query("SELECT id FROM builder.outbox WHERE kind='template.published' AND resource_id=$1",[a.template.templateId])).rowCount,1)
})

test('publication rejects another wallet, changed ciphertext/origin/draft and an expired intent', async t => {
  const p = await prepared(), other = person()
  await assert.rejects(p.t.publish(other.owner,randomUUID(),p.input),/not-found/)
  await assert.rejects(p.t.publish(p.owner,randomUUID(),{ ...p.input,envelope: envelope() }),/invalid-publication-signature/)
  await assert.rejects(p.t.publish(p.owner,randomUUID(),{ ...p.input, signature: await other.account.signMessage({ message: publicationMessage(p.intent,p.cipher) }) }),/invalid-publication-signature/)
  await assert.rejects(templates({origin:'https://another.example'}).publish(p.owner,randomUUID(),p.input),/context-changed/)
  await assert.rejects(p.t.publish(p.owner,randomUUID(),{...p.input,owner:p.owner}))
  await p.store.patch(p.owner,randomUUID(),{draftId:p.draft.id,expectedRevision:2,patch:{spec:{title:'Changed after review'}}})
  await assert.rejects(p.t.publish(p.owner,randomUUID(),p.input),/draft-changed/)
  const q = await prepared()
  t.mock.timers.enable({apis:['Date'],now:Date.now() + 300001})
  try { await assert.rejects(q.t.publish(q.owner,randomUUID(),q.input),/intent-expired/) } finally { t.mock.timers.reset() }
  assert.equal((await pool.query('SELECT * FROM builder_private.provider_policies WHERE template_id=$1',[q.intent.base.templateId])).rowCount,0)
})

test('concurrent versions serialize and publishing a new version never retargets a Maker pin', async () => {
  const p = await prepared(), saved = await p.t.publish(p.owner,randomUUID(),p.input), maker = person()
  const instance = await p.t.instantiate(maker.owner,randomUUID(),instanceInput(saved))
  const make = async () => {
    const {intent} = await p.t.prepare(p.owner,randomUUID(),{...p.prepareInput,templateId:saved.template.templateId}), cipher=envelope()
    return {intentId:intent.id,envelope:cipher,signature:await p.account.signMessage({message:publicationMessage(intent,cipher)})}
  }
  const first=await make(),second=await make()
  const results=await Promise.allSettled([p.t.publish(p.owner,randomUUID(),first),p.t.publish(p.owner,randomUUID(),second)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.ok(results.some(r=>r.status==='rejected' && /version-changed/.test(r.reason.message)))
  const current=await p.store.get(maker.owner,instance.draft.id)
  assert.deepEqual(current.templatePin,instance.draft.templatePin); assert.equal(current.templatePin?.version,1)
  await assert.rejects(p.t.prepare(maker.owner,randomUUID(),{...p.prepareInput,templateId:saved.template.templateId}),/not-found/)
})

test('Maker instances retain authenticated baseline permissions across patches, restores, reloads and deterministic compilation', async () => {
  for (const model of [{kind:'xyc'},{kind:'concentrated',minPrice:'2200',maxPrice:'2800'},{kind:'pegged',referencePrice:'2500',amplification:'1'}] as const) {
    const p=await prepared(model), saved=await p.t.publish(p.owner,randomUUID(),p.input), maker=person(), key=randomUUID()
    const instance=await p.t.instantiate(maker.owner,key,instanceInput(saved)), d=instance.draft
    assert.deepEqual(await p.t.instantiate(maker.owner,key,instanceInput(saved)),instance)
    assert.equal(d.maker,maker.owner.slice(7)); assert.notEqual(d.salt,p.draft.salt)
    const change=(expectedRevision:number,patch:unknown)=>p.store.patch(maker.owner,randomUUID(),{draftId:d.id,expectedRevision,patch})
    await change(1,{spec:{guardEnvelope:{maxAmountQuotePerSwap:'10000000'}}})
    await change(2,{spec:{guardEnvelope:{maxAmountQuotePerSwap:'12500000'}}})
    await assert.rejects(change(3,{spec:{guardEnvelope:{maxAmountQuotePerSwap:'12500001'}}}),/cap-permission/)
    await assert.rejects(change(3,{spec:{feeBps:10}}),/fixed-parameter/)
    await assert.rejects(p.store.get(p.owner,d.id),/not-found/)
    const restored=await p.store.restore(maker.owner,randomUUID(),{draftId:d.id,expectedRevision:3,revision:2})
    assert.equal(restored.draft.revision,4); assert.equal(restored.draft.spec.guardEnvelope?.maxAmountQuotePerSwap,'10000000')
    const context=await createStore(pool,profile.id).templateContext(maker.owner,d.id,4)
    assert.deepEqual(context?.permissions,defaultTemplatePermissions); assert.equal(context?.baseline.guardEnvelope?.maxAmountQuotePerSwap,'12500000')
    await assert.rejects(p.store.templateContext(p.owner,d.id,4),/not-found/)
    const artifact=await createArtifacts(pool,profile).compile(maker.owner,randomUUID(),{draftId:d.id,expectedRevision:4})
    assert.ok(artifact.artifactId)
    await assert.rejects(pool.query('DELETE FROM builder.template_instances WHERE draft_id=$1',[d.id]),/immutable/)
  }
})

test('relative prices come from a bounded trusted adapter without a transaction lock and stale/wrong-pair/caller snapshots fail', async () => {
  const p=await prepared({kind:'concentrated',relativeWidthBps:1000}), saved=await p.t.publish(p.owner,randomUUID(),p.input), maker=person(), input=instanceInput(saved)
  const snapshot:PriceSnapshot={source:'trusted-test-book',observedAt:new Date().toISOString(),baseToken:profile.tokens[0]!.address,quoteToken:profile.tokens[1]!.address,price:'2500'}
  await assert.rejects(p.t.instantiate(maker.owner,randomUUID(),input),/price-unavailable/)
  await assert.rejects(templates({price:async()=>({...snapshot,observedAt:new Date(Date.now()-60001).toISOString()})}).instantiate(maker.owner,randomUUID(),input),/price-stale/)
  await assert.rejects(templates({price:async()=>({...snapshot,quoteToken:profile.tokens[0]!.address})}).instantiate(maker.owner,randomUUID(),input),/pair-mismatch/)
  await assert.rejects(templates({price:async()=>snapshot}).instantiate(maker.owner,randomUUID(),{...input,snapshot}))
  let calls=0
  const service=templates({price:async()=>{calls++;return snapshot}}),key=randomUUID(),instance=await service.instantiate(maker.owner,key,input)
  const model=instance.draft.spec.model;assert.ok(model?.kind==='concentrated');assert.equal(model.minPrice,'2250');assert.equal(model.maxPrice,'2750')
  await assert.rejects(p.store.patch(maker.owner,randomUUID(),{draftId:instance.draft.id,expectedRevision:1,patch:{spec:{model:{kind:'concentrated',snapshot:{...snapshot,price:'2600'}}}}}),/range-permission/)
  let release!:(v:PriceSnapshot)=>void,entered!:()=>void
  const started=new Promise<void>(r=>{entered=r}), pending=templates({price:()=>{entered();return new Promise(r=>{release=r})}}).instantiate(person().owner,randomUUID(),input)
  await started
  const withdraw={...input,signature:await p.account.signMessage({message:withdrawalMessage(origin,profile.chainId,saved.template)})}
  const {allocations:_allocations,...withdrawInput}=withdraw
  try { await p.t.withdraw(p.owner,randomUUID(),withdrawInput) } finally {release(snapshot)}
  await assert.rejects(pending,/template-withdrawn/)
  assert.deepEqual(await service.instantiate(maker.owner,key,input),instance);assert.equal(calls,1)
})

test('withdrawal is signed and permanent, stops new instances, preserves history and does not claim existing report revocation', async () => {
  const p=await prepared(),saved=await p.t.publish(p.owner,randomUUID(),p.input),maker=person(),input=instanceInput(saved)
  const instance=await p.t.instantiate(maker.owner,randomUUID(),input)
  const withdrawal={templateId:input.templateId,version:input.version,digest:input.digest,signature:await p.account.signMessage({message:withdrawalMessage(origin,profile.chainId,saved.template)})}
  await assert.rejects(p.t.withdraw(maker.owner,randomUUID(),withdrawal),/not-found/)
  await assert.rejects(p.t.withdraw(p.owner,randomUUID(),{...withdrawal,signature:p.input.signature}),/invalid-withdrawal-signature/)
  const withdrawn=await p.t.withdraw(p.owner,randomUUID(),withdrawal)
  assert.ok(withdrawn.withdrawnAt);assert.equal(withdrawn.registrationReady,false)
  assert.deepEqual(await p.t.withdraw(p.owner,randomUUID(),withdrawal),withdrawn)
  await assert.rejects(p.t.instantiate(person().owner,randomUUID(),input),/template-withdrawn/)
  assert.equal((await p.store.templateContext(maker.owner,instance.draft.id,1))?.withdrawn,true)
  await p.store.patch(maker.owner,randomUUID(),{draftId:instance.draft.id,expectedRevision:1,patch:{spec:{title:'History remains editable'}}})
  assert.equal((await pool.query("SELECT id FROM builder.outbox WHERE kind='template.withdrawn' AND resource_id=$1",[input.templateId])).rowCount,1)
  await assert.rejects(pool.query('DELETE FROM builder.template_withdrawals WHERE template_id=$1',[input.templateId]),/immutable/)
})

test('publication intent and Maker creation budgets are shared across concurrent service instances, while retries remain free', async () => {
  const p=await prepared(),service=templates()
  for(let i=0;i<28;i++) await p.t.prepare(p.owner,randomUUID(),p.prepareInput)
  const results=await Promise.allSettled([p.t,service].map(t=>t.prepare(p.owner,randomUUID(),p.prepareInput)))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.ok(results.some(r=>r.status==='rejected' && /budget-exhausted/.test(r.reason.message)))
  const saved=await p.t.publish(p.owner,randomUUID(),p.input),maker=person(),key=randomUUID(),input=instanceInput(saved)
  const first=await p.t.instantiate(maker.owner,key,input)
  for(let i=0;i<58;i++) await p.t.instantiate(maker.owner,randomUUID(),input)
  const instances=await Promise.allSettled([p.t,service].map(t=>t.instantiate(maker.owner,randomUUID(),input)))
  assert.equal(instances.filter(r=>r.status==='fulfilled').length,1)
  assert.ok(instances.some(r=>r.status==='rejected' && /budget-exhausted/.test(r.reason.message)))
  assert.deepEqual(await service.instantiate(maker.owner,key,input),first)
  await assert.rejects(service.instantiate(maker.owner,key,{...input,title:'Different request'}),/idempotency-key-reused/)
})

test('HTTP template endpoints require wallet authentication, configuration and strict resource/owner inputs', async () => {
  const p=await prepared(),handler=builderHandler(pool,{origin,chainId:profile.chainId,profileId:profile.id},{templates:{workflowPublicKey}})
  const server=createServer((req,res)=>{void handler(req,res).then(ok=>{if(!ok){res.statusCode=404;res.end()}})})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/builder`
  let token=''
  const call=async(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json','idempotency-key':randomUUID(),...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  try {
    assert.equal((await call('/templates')).status,401)
    const challenge=await (await call('/auth/challenge',{address:p.account.address})).json() as {id:string;message:string}
    token=(await (await call('/auth/login',{challengeId:challenge.id,signature:await p.account.signMessage({message:challenge.message})})).json() as {token:string}).token
    assert.equal((await call('/templates/publish',{...p.input,owner:p.owner})).status,400)
    const response=await call('/templates/publish',p.input);assert.equal(response.status,200)
    const saved=await response.json() as Awaited<ReturnType<typeof p.t.publish>>
    assert.equal(JSON.stringify(saved).includes(p.cipher.ciphertext),false)
    assert.equal((await call(`/templates/${saved.template.templateId}/versions/1`)).status,200)
    assert.equal((await call('/templates/instantiate',{...instanceInput(saved),maker:p.account.address})).status,400)
    const applied=await call('/templates/instantiate',instanceInput(saved));assert.equal(applied.status,200)
    const instance=await applied.json() as {draft:{id:string}}
    const context=await call(`/drafts/${instance.draft.id}/template-context?revision=1`)
    assert.equal(context.status,200)
    assert.deepEqual((await context.json() as {context:{permissions:unknown}}).context.permissions,defaultTemplatePermissions)
    assert.equal((await call(`/drafts/${instance.draft.id}/template-context?revision=2`)).status,409)
    assert.equal((await call(`/drafts/${instance.draft.id}/template-context?revision=1&owner=${p.owner}`)).status,400)
    assert.equal((await call('/templates')).status,200)
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
})
