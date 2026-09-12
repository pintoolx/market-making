import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

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
      '--http-payload', `@${payloadPath}`, '--target', config.target, '--broadcast'];
    const makeChild = dependencies.spawnImpl ?? spawn;
    await (dependencies.runImpl ?? run)(makeChild(config.executable, args, {
      cwd: config.projectDir, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    }), config.timeoutMs);
    return { workflowExecutionId: `local-simulation-${id}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
