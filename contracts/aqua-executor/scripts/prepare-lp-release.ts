import { readFileSync, writeFileSync } from 'node:fs'
import { compileLpRelease } from '../src/lp-release.ts'
import { loadDeployment } from '../src/config.ts'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath || process.argv.length !== 4) throw new Error('Usage: node scripts/prepare-lp-release.ts <public-plan-input.json> <new-output.json>')
const plan = await compileLpRelease(JSON.parse(readFileSync(inputPath, 'utf8')), loadDeployment(11155111), Math.floor(Date.now() / 1000))
writeFileSync(outputPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ output: outputPath, release: plan.release, strategyHash: plan.strategyHash, reportRequired: true }))
