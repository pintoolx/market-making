import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { defaultTemplatePermissions, digestJson, draftSchema, makeTemplateVersion, publicationMessage, publicationVersion,
  publicationVersionMessage, sepoliaStandingProfile as profile, templateDigest } from '@pintool/strategy-builder'
import { verifyPublicationIntent, verifyPublishedTemplate } from '../src/app/builder/publication.ts'

function fixture() {
  const account=privateKeyToAccount(generatePrivateKey()),now=new Date().toISOString(),origin='http://localhost:3311'
  const draft=draftSchema.parse({schemaVersion:1,id:'browser-review',owner:'wallet:'+account.address.toLowerCase(),kind:'template',revision:2,salt:'42',createdAt:now,updatedAt:now,requirements:[],
    spec:{title:'My reviewed curve',profileId:profile.id,baseToken:profile.tokens[0],quoteToken:profile.tokens[1],model:{kind:'xyc'},feeBps:0,deadline:Math.floor(Date.now()/1000)+3600,
      guardEnvelope:{maxAmountBasePerSwap:'5000000000000000',maxAmountQuotePerSwap:'12500000',maxPostBalanceBase:'20000000000000000',maxPostBalanceQuote:'50000000'}}})
  const encryption={algorithm:'x25519-hkdf-sha256-xchacha20poly1305',publicKey:'11'.repeat(32)}
  const keyId=digestJson(encryption),{policy:_,...base}=makeTemplateVersion(draft,profile,{templateId:'published-template',version:1,permissions:defaultTemplatePermissions,policy:{keyId,envelopeDigest:digestJson('pending')},now})
  const intent={id:'publication-intent',origin,chainId:profile.chainId,expiresAt:new Date(Date.now()+300000).toISOString(),base,encryption:{...encryption,keyId,strategyId:'published-template.v1'}}
  const envelope={version:1,ephemeralPublicKey:'aa'.repeat(32),nonce:'bb'.repeat(24),ciphertext:'cc'.repeat(32)}
  return {account,draft,origin,intent,envelope}
}
test('browser refuses a publication intent that changes the visible revision, permissions, origin, spec or key before sealing',()=>{
  const p=fixture(),verify=i=>verifyPublicationIntent(i,p.draft,defaultTemplatePermissions,null,p.origin)
  assert.deepEqual(verify(p.intent),p.intent)
  for(const change of [i=>{i.origin='https://wrong.example'},i=>{i.base.spec.guardEnvelope.maxAmountQuotePerSwap='12500001'},
    i=>{i.base.permissions.tightenCaps=false},i=>{i.base.source.revision=1},i=>{i.encryption.publicKey='22'.repeat(32)},
    i=>{i.encryption.strategyId='another-version'},i=>{i.expiresAt='2000-01-01T00:00:00.000Z'}]) {
    const i=structuredClone(p.intent);change(i);assert.throws(()=>verify(i),/publication review does not match/)
  }
})
test('browser independently verifies the Provider signature and refuses substituted versions or unsigned public changes',async()=>{
  const p=fixture(),template=publicationVersion(p.intent,p.envelope),message=publicationMessage(p.intent,p.envelope),signature=await p.account.signMessage({message})
  const saved={template,digest:templateDigest(template),proof:{intent:p.intent,message,signature},withdrawnAt:null,currentManifest:true,policyStatus:'encrypted-unverified',registrationReady:false}
  assert.deepEqual(await verifyPublishedTemplate(saved,template.templateId,1),saved)
  await assert.rejects(verifyPublishedTemplate(saved,template.templateId,2))
  await assert.rejects(verifyPublishedTemplate(saved,template.templateId,1,digestJson('different-version')))
  const changed=structuredClone(saved);changed.template.spec.title='Unsigned replacement';changed.proof.intent.base.spec.title=changed.template.spec.title
  changed.digest=templateDigest(changed.template);changed.proof.message=publicationVersionMessage(changed.proof.intent,changed.template)
  await assert.rejects(verifyPublishedTemplate(changed,template.templateId,1),/template signature or version could not be verified/)
})
