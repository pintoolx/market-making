import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { fetchKrakenRiskPrices } from '../src/kraken-risk-prices.ts'
const { values } = parseArgs({ options: { out: { type: 'string' } } })
if (!values.out) throw new Error('Use --out <public price snapshot.json>')
const d = JSON.parse(readFileSync(new URL('../deployments/11155111.json', import.meta.url), 'utf8'))
const prices = await fetchKrakenRiskPrices(d)
writeFileSync(values.out, JSON.stringify(prices, null, 2) + '\n')
console.log(JSON.stringify({ source: prices.source, asOf: prices.asOf, usdE8: prices.usdE8 }))
