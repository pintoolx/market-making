import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { keccak256, stringToHex } from 'viem';

function run(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('CRE local simulation timed out')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2_000_000) child.kill('SIGKILL'); });
    child.once('error', finish);
    child.once('close', code => code === 0 ? finish(null, stdout) : finish(new Error(`CRE local simulation failed with exit code ${code}`)));
  });
}

export function localSimulatorConfig(env = process.env) {
  const projectDir = env.CRE_PROJECT_DIR?.trim();
  if (!projectDir || !isAbsolute(projectDir)) throw new Error('CRE_PROJECT_DIR must be an absolute path');
  return {
    executable: env.CRE_CLI?.trim() || 'cre',
    projectDir: resolve(projectDir),
    workflowDir: env.CRE_WORKFLOW_DIR?.trim() || 'market-maker-auth',
    target: env.CRE_TARGET?.trim() || 'staging-settings',
    toolPath: env.CRE_TOOL_PATH?.trim() || '',
    timeoutMs: Number(env.MANDATE_RUNNER_TIMEOUT_MS ?? 120_000),
  };
}

/** Run the confidential handler locally, while CRE's simulator broadcasts its signed report to Sepolia. */
export async function simulateCREWorkflow(config, payload, dependencies = {}) {
  const id = randomUUID();
  const directory = resolve(tmpdir(), `pintool-cre-${id}`);
  const payloadPath = resolve(directory, 'request.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    const args = ['workflow', 'simulate', config.workflowDir, '--non-interactive', '--trigger-index', '1',
      '--http-payload', payloadPath, '--target', config.target, '--broadcast'];
    const makeChild = dependencies.spawnImpl ?? spawn;
    const env = config.toolPath ? { ...process.env, PATH: `${config.toolPath}:${process.env.PATH ?? ''}` } : process.env;
    const output = await (dependencies.runImpl ?? run)(makeChild(config.executable, args, {
      cwd: config.projectDir, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }), config.timeoutMs);
    const markers = String(output ?? '').split('\n').map(line => {
      const start = line.indexOf('{');
      if (start < 0) return null;
      try { return JSON.parse(line.slice(start)); } catch { return null; }
    });
    const unchanged = markers.find(value => value?.kind === 'cre-authorization-unchanged');
    if (unchanged && (!/^0x[0-9a-f]{64}$/i.test(unchanged.reportDigest ?? '')
      || unchanged.strategyHash?.toLowerCase() !== payload.strategyHash.toLowerCase())) throw new Error('Invalid unchanged-authorization result');
    const scenario = markers.filter(value => value?.kind === 'cre-market-scenario');
    if (config.scenarioId) {
      const value = scenario[0], o = value?.observation;
      if (scenario.length !== 1 || value.requestId !== payload.requestId
        || value.strategyHash?.toLowerCase() !== payload.strategyHash.toLowerCase()
        || o?.source !== 'synthetic-scenario' || o.scenarioId !== config.scenarioId
        || o.maker !== payload.maker.toLowerCase() || o.chainId !== 11155111
        || value.inputDigest !== keccak256(stringToHex(JSON.stringify(o)))) throw new Error('Missing or mismatched market scenario evidence');
    } else if (scenario.length) throw new Error('Unexpected synthetic scenario in the live simulator');
    return { workflowExecutionId: `local-simulation-${id}`, ...(unchanged ? { unchanged: true, reportDigest: unchanged.reportDigest } : {}),
      ...(config.scenarioId ? { marketEvaluation: { ...scenario[0], kind: undefined } } : {}) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
