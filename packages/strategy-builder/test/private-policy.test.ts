import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePrivatePolicy, type PrivatePolicyForm } from '../src/private-policy.ts'
import { sepoliaStandingProfile as profile, type StrategySpec } from '../src/index.ts'
const spec: StrategySpec = {title:'Private rules',profileId:profile.id,baseToken:profile.tokens[0],quoteToken:profile.tokens[1],model:{kind:'xyc'},modifiers:[],
  guardEnvelope:{maxAmountBasePerSwap:'5000000000000000',maxAmountQuotePerSwap:'12500000',maxPostBalanceBase:'20000000000000000',maxPostBalanceQuote:'50000000'}}
const fixture = (): PrivatePolicyForm => ({rules:[{id:'price-rule',priceMin:'2200',priceMax:'2800',volatilityBpsMin:'0',volatilityBpsMax:'100',
  allowMakerBuyBase:true,allowMakerSellBase:false,maxAmountBase:'0.002',maxAmountQuote:'5'},
  {id:'fallback',priceMin:'',priceMax:'',volatilityBpsMin:'',volatilityBpsMax:'',allowMakerBuyBase:false,allowMakerSellBase:false,maxAmountBase:'0',maxAmountQuote:'0'}],
  maxBalanceBase:'0.015',maxBalanceQuote:'40'})

test('private policy encoder retains order, exact human units and Maker direction without sorting the base token',()=>{
  const form=fixture(),encoded=encodePrivatePolicy(form,spec,'version-1')
  assert.deepEqual(encoded,{schemaVersion:1,strategyId:'version-1',rules:[
    {id:'price-rule',when:{priceMin:'2200',priceMax:'2800',volatilityBpsMin:0,volatilityBpsMax:100},allowMakerBuyToken0:true,allowMakerSellToken0:false,maxAmount0PerSwap:'2000000000000000',maxAmount1PerSwap:'5000000',ttlSec:600},
    {id:'fallback',when:{},allowMakerBuyToken0:false,allowMakerSellToken0:false,maxAmount0PerSwap:'0',maxAmount1PerSwap:'0',ttlSec:600}],inventory:{maxBalance0:'15000000000000000',maxBalance1:'40000000'}})
  assert.deepEqual(form,fixture())
  const reversed={...spec,baseToken:spec.quoteToken,quoteToken:spec.baseToken,guardEnvelope:{maxAmountBasePerSwap:'12500000',maxAmountQuotePerSwap:'5000000000000000',maxPostBalanceBase:'50000000',maxPostBalanceQuote:'20000000000000000'}}
  const reverse=fixture();reverse.rules[0]!.maxAmountBase='5';reverse.rules[0]!.maxAmountQuote='0.002';reverse.maxBalanceBase='40';reverse.maxBalanceQuote='0.015'
  const result=encodePrivatePolicy(reverse,reversed,'version-2')
  assert.equal(result.rules[0]!.maxAmount0PerSwap,'5000000');assert.equal(result.rules[0]!.maxAmount1PerSwap,'2000000000000000');assert.equal(result.rules[0]!.allowMakerBuyToken0,true)
})
test('private form rejects excess precision, malformed/inverted conditions, shadowed rules, public-cap overruns and oversized envelopes',()=>{
  for(const change of [(f:PrivatePolicyForm)=>{f.rules[0]!.priceMin='2200.123456789'},(f:PrivatePolicyForm)=>{f.rules[0]!.priceMax='2100'},
    (f:PrivatePolicyForm)=>{f.rules[0]!.maxAmountQuote='5.0000001'},(f:PrivatePolicyForm)=>{f.rules[0]!.maxAmountBase='0.005000000000000001'},
    (f:PrivatePolicyForm)=>{f.maxBalanceQuote='50.000001'},(f:PrivatePolicyForm)=>{f.rules[0]!.volatilityBpsMax='-1'},
    (f:PrivatePolicyForm)=>{f.rules[0]!.volatilityBpsMin='101'},(f:PrivatePolicyForm)=>{f.rules.reverse()},
    (f:PrivatePolicyForm)=>{f.rules[1]!.id=f.rules[0]!.id},(f:PrivatePolicyForm)=>{f.rules[0]!.priceMin='NaN'}]) {
    const form=fixture();change(form);assert.throws(()=>encodePrivatePolicy(form,spec,'version-1'))
  }
  const huge=fixture();huge.rules=Array.from({length:8},(_,i)=>({...huge.rules[0]!,id:`rule-${i}-`+'x'.repeat(89),priceMin:'1'.repeat(35)+'.12345678',priceMax:'2'.repeat(35)+'.12345678',volatilityBpsMin:'9007199254740990',volatilityBpsMax:'9007199254740991'}))
  huge.rules.forEach(r=>{r.maxAmountBase='99999999999999999.123456789012345678';r.maxAmountQuote='99999999999999999999999999999.999999'})
  const hugeSpec={...spec,guardEnvelope:{...spec.guardEnvelope!,maxAmountBasePerSwap:((1n<<128n)-1n).toString(),maxAmountQuotePerSwap:((1n<<128n)-1n).toString()}}
  assert.throws(()=>encodePrivatePolicy(huge,hugeSpec,'x'.repeat(95)),/可加密長度/)
  assert.throws(()=>encodePrivatePolicy({...fixture(),secret:'do-not-accept'},spec,'version-1'))
})
