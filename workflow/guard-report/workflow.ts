import { CronCapability, handler, type Runtime } from '@chainlink/cre-sdk'
import { submitPublicReport } from './delivery'
import { type Config } from './config'
export { configSchema, type Config } from './config'

// This entry point tests PUBLIC report delivery. It does not fetch secrets or claim enclave execution.
export const onCron = (runtime: Runtime<Config>) => submitPublicReport(runtime, runtime.config.publicReport, runtime.config.transport)
export const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]
