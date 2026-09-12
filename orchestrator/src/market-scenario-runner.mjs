import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configFromEnv } from './server.mjs';
import { createService } from './service.mjs';
import { mandateRunnerConfig, runDirectMandate } from './cre-mandate-runner.mjs';
import { localSimulatorConfig, simulateCREWorkflow } from './cre-local-simulator.mjs';

/** Operator-only command. No HTTP route accepts a market scenario or raw snapshot. */
export async function scenarioRunConfig(scenarioId, listingId, env = process.env) {
  if (!['normal-v1', 'stress-v1'].includes(scenarioId)) throw new Error('Choose normal-v1 or stress-v1');
  const service = configFromEnv(env), runner = mandateRunnerConfig(env);
  if (service.chainId !== 11155111 || runner.chainId !== 11155111) throw new Error('Market scenarios require Ethereum Sepolia');
  const simulation = { ...localSimulatorConfig(env), workflowDir: 'market-scenarios',
    target: `${scenarioId.split('-')[0]}-scenario-settings`, scenarioId };
  const workflow = JSON.parse(await readFile(resolve(simulation.projectDir, 'market-scenarios', `config.${scenarioId.split('-')[0]}.json`), 'utf8'));
  const listing = runner.catalog[listingId];
  const provisionedHashes = [workflow.strategyHash, ...(workflow.providerStrategies ?? []).map(p => p.strategyHash)];
  if (!listing || !provisionedHashes.some(hash => hash.toLowerCase() === listing.strategyHash.toLowerCase())) throw new Error('Strategy is not provisioned for scenario execution');
  if (workflow.marketSource !== 'scenario' || workflow.scenarioId !== scenarioId || workflow.publishMode !== 'don-report'
    || workflow.transport?.profile !== 'cre-simulation'
    || workflow.maker.toLowerCase() !== service.strategyMaker || workflow.guard.toLowerCase() !== service.guard?.toLowerCase()
    || workflow.guard.toLowerCase() !== runner.guard.toLowerCase() || workflow.router.toLowerCase() !== service.router.toLowerCase()) throw new Error('Scenario deployment does not match the configured service');
  return { service, runner, simulation };
}

export async function runMarketScenario({ mandateId, listingId, scenarioId }, env = process.env) {
  if (!/^mandate-[a-f0-9-]{36}$/.test(mandateId ?? '')) throw new Error('A stored mandate ID is required');
  const config = await scenarioRunConfig(scenarioId, listingId, env);
  const service = createService(config.service, { runner: request => {
    if (request.current?.maker.toLowerCase() !== config.service.strategyMaker) throw new Error('Scenario mandate belongs to a different Maker');
    return runDirectMandate(request, config.runner, { triggerConfig: config.simulation, trigger: simulateCREWorkflow });
  } });
  // Reuses stored encrypted limits, report verification, readiness checks and persistence.
  return service.add(mandateId, { providerStrategyId: listingId });
}
