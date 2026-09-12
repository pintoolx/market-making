/**
 * Leak scan: every scalar inside the two secret JSON blobs must be absent from
 * the simulation output — except values the report publishes BY DESIGN
 * (per-swap caps, inventory caps, TTL), which are listed separately so a
 * reviewer can see exactly what the on-chain report reveals.
 *
 * Usage: bun run scripts/leak-scan.ts <env-file> <simulate-output-file>
 */
const [envFile, outFile] = process.argv.slice(2)
if (!envFile || !outFile) {
	console.error('usage: leak-scan.ts <env-file> <simulate-output-file>')
	process.exit(2)
}

const env = await Bun.file(envFile).text()
const out = await Bun.file(outFile).text()

const readSecret = (name: string): unknown => {
	const line = env.split('\n').find((l) => l.startsWith(`${name}=`))
	if (!line) throw new Error(`${name} not found in ${envFile}`)
	let raw = line.slice(name.length + 1).trim()
	if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
	return JSON.parse(raw)
}

/** Keys whose values legitimately surface in the public report after min(). */
const PUBLISHED_BY_DESIGN = new Set([
	'maxAmount0PerSwap',
	'maxAmount1PerSwap',
	'maxBalance0',
	'maxBalance1',
	'maxBudget1',
	'ttlSec',
	'maxTtlSec',
])

type Scalar = { path: string; key: string; value: string }
const collect = (node: unknown, path: string, acc: Scalar[]): Scalar[] => {
	if (node === null || typeof node === 'boolean') return acc
	if (Array.isArray(node)) {
		node.forEach((v, i) => collect(v, `${path}[${i}]`, acc))
		return acc
	}
	if (typeof node === 'object') {
		for (const [k, v] of Object.entries(node as Record<string, unknown>)) collect(v, path ? `${path}.${k}` : k, acc)
		return acc
	}
	const value = String(node)
	const key = path.split('.').pop()?.replace(/\[\d+\]$/, '') ?? path
	if (key === 'schemaVersion') return acc // "1" is meaningless noise
	acc.push({ path, key, value })
	return acc
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const appears = (value: string) => new RegExp(`(^|[^0-9A-Za-z_-])${escape(value)}([^0-9A-Za-z_-]|$)`, 'm').test(out)

const scalars = [
	...collect(readSecret('SECRET_PROVIDER_STRATEGY'), 'provider', []),
	...collect(readSecret('SECRET_MAKER_LIMITS'), 'maker', []),
]

const leaked: Scalar[] = []
const published: Scalar[] = []
for (const s of scalars) {
	if (!appears(s.value)) continue
	;(PUBLISHED_BY_DESIGN.has(s.key) ? published : leaked).push(s)
}

// Sanity: the run must actually have executed in TEE mode and finished.
const ranInTee = out.includes('Trigger requested TEE Execution')
const finished = out.includes('Workflow Simulation Result')

console.log(`secret scalars scanned: ${scalars.length}`)
console.log(`TEE prompt box present: ${ranInTee}`)
console.log(`Simulation Result present: ${finished}`)
if (published.length) {
	console.log('\nvalues visible in output BY DESIGN (min() of the two sides, part of the public report):')
	for (const p of published) console.log(`  ${p.path} = ${p.value}`)
}
if (leaked.length) {
	console.log('\nLEAKED private values:')
	for (const l of leaked) console.log(`  ${l.path} = ${l.value}`)
}
const ok = leaked.length === 0 && ranInTee && finished
console.log(ok ? '\nLEAK CHECK: PASS' : '\nLEAK CHECK: FAIL')
process.exit(ok ? 0 : 1)
