import { Runner } from '@chainlink/cre-sdk'
import { configSchema, initWorkflow } from '../market-maker-auth/workflow'

export async function main() {
	const runner = await Runner.newRunner({ configSchema })
	await runner.run(initWorkflow)
}

main()
