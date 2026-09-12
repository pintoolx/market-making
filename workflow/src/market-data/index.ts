import type { Runtime } from '@chainlink/cre-sdk'
import { marketFromObservation } from '../market-observation'
import { configSchema } from './config'
import { observeMarket } from './observe'
import defaults from './defaults.json'

/** Public acquisition; callable through TeeRuntime.usingTheDons() without
 * passing any private policy or decision trace to DON capabilities.
 */
export function acquireMarket(runtime: Runtime<unknown>, maker: string) {
	const observation = observeMarket(runtime, configSchema.parse({ ...defaults, maker }))
	const market = marketFromObservation(observation, {
		expectedMaker: maker, nowSec: Math.floor(runtime.now().getTime() / 1000),
	})
	return { observation, market }
}
