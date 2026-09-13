import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultTemplatePermissions, digestJson, sepoliaStandingProfile as profile, templateVersionSchema } from '@pintool/strategy-builder'
import { krakenTemplatePrice, priceFromKrakenBook, TEMPLATE_PRICE_SOURCE } from '../src/template-price.ts'
const now = 1789260000000
const template = () => templateVersionSchema.parse({ schemaVersion:1,templateId:'price-template',version:1,provider:'0x1111111111111111111111111111111111111111',
  manifestHash:digestJson(profile),source:{draftId:'provider',revision:1,contentDigest:digestJson('draft')},createdAt:new Date(now).toISOString(),
  spec:{title:'Relative range',profileId:profile.id,baseToken:profile.tokens[0],quoteToken:profile.tokens[1],model:{kind:'concentrated',relativeWidthBps:1000}},
  requirements:[],permissions:defaultTemplatePermissions,policy:{keyId:digestJson('key'),envelopeDigest:digestJson('ciphertext')} })
const book=()=>({error:[],result:{ETHUSDC:{bids:[['2499','0.02',now/1000]],asks:[['2501','0.03',now/1000]]}}})
test('trusted price freezes exact midpoint or reciprocal, preserves the pair and rejects stale/empty/crossed/wide/unknown market data',()=>{
  const t=template(),p=priceFromKrakenBook(t,book(),now)
  assert.equal(p.price,'2500');assert.equal(p.baseToken,profile.tokens[0]!.address);assert.ok(p.source.includes('proxy'))
  assert.equal(priceFromKrakenBook({...t,spec:{...t.spec,baseToken:t.spec.quoteToken,quoteToken:t.spec.baseToken}},book(),now).price,'0.0004')
  for(const edit of [(b:ReturnType<typeof book>)=>{b.result.ETHUSDC.bids[0]![2]=now/1000-61},
    (b:ReturnType<typeof book>)=>{b.result.ETHUSDC.asks[0]![2]=now/1000+6},
    (b:ReturnType<typeof book>)=>{b.result.ETHUSDC.bids[0]![1]='0'},
    (b:ReturnType<typeof book>)=>{b.result.ETHUSDC.asks[0]![0]='2498'},
    (b:ReturnType<typeof book>)=>{b.result.ETHUSDC.asks[0]![0]='2800'},
    (b:ReturnType<typeof book>)=>{b.result.ETHUSDC.asks[0]![0]='2500.000000001'}]) {const value=book();edit(value);assert.throws(()=>priceFromKrakenBook(t,value,now))}
  assert.throws(()=>priceFromKrakenBook(t,{...book(),result:{ETHUSD:book().result.ETHUSDC}},now))
})
test('public price adapter fixes the URL, blocks redirects, bounds the body and redacts upstream diagnostics',async()=>{
  const original=globalThis.fetch
  try {
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,TEMPLATE_PRICE_SOURCE);assert.equal(init?.redirect,'error');assert.ok(init?.signal)
      const b=book();b.result.ETHUSDC.bids[0]![2]=b.result.ETHUSDC.asks[0]![2]=Math.floor(Date.now()/1000)
      return new Response(JSON.stringify(b))
    }
    assert.equal((await krakenTemplatePrice(template())).price,'2500')
    for(const fetcher of [async()=>new Response('x'.repeat(16385)),async()=>{throw new Error('sensitive-upstream-diagnostics')}]) {
      globalThis.fetch=fetcher
      await assert.rejects(krakenTemplatePrice(template()),e=>{assert.equal(String(e),'Error: template-price-unavailable');return true})
    }
  }finally{globalThis.fetch=original}
})
