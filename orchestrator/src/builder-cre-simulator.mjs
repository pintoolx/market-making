import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseBuilderCreOutput } from './builder-cre-protocol.mjs';

/** Only failures proven to precede starting CRE may be safely retried. */
export class CreNotStartedError extends Error {}

/** An operator-owned CLI boundary. Caller identity/ciphertext must be loaded
 * with readTrustedWorkflowInput; this is not an HTTP handler. Credentials are
 * consumed by the child, never inspected, copied to temp files or logged here.
 */
export function createCreSimulator({ projectDirectory, environmentFile = '/dev/null', env = process.env,
  executable = 'cre', timeoutMs = 120000, broadcastEnabled = false }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('builder-cre-invalid-timeout');
  const cwd = resolve(projectDirectory), envPath = resolve(environmentFile);
  return async ({ config, payload }) => {
    if (payload.builder?.phase !== 'evaluate' && payload.builder?.phase !== 'deliver') throw new CreNotStartedError('builder-cre-invalid-phase');
    const deliver = payload.builder.phase === 'deliver';
    if (!config.builderSimulation || config.transport?.profile === 'cre-production' ||
      config.maker?.toLowerCase() !== payload.maker?.toLowerCase() || config.strategyHash?.toLowerCase() !== payload.strategyHash?.toLowerCase())
      throw new CreNotStartedError('builder-cre-invalid-config');
    if (deliver && (!broadcastEnabled || config.publishMode !== 'don-report' || config.transport?.profile !== 'cre-simulation'))
      throw new CreNotStartedError('builder-cre-broadcast-disabled');
    const dir = await mkdtemp(join(tmpdir(), 'pintool-builder-cre-'));
    try {
      const configPath = join(dir, 'config.json'), inputPath = join(dir, 'request.json');
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(inputPath, JSON.stringify(payload), { mode: 0o600 });
      const args = ['workflow', 'simulate', 'market-maker-auth', '--non-interactive', '--trigger-index', '1',
        '--http-payload', inputPath, '--config', configPath, '--target', 'staging-settings', '--env', envPath];
      if (deliver) args.push('--broadcast');
      const stdout = await new Promise((accept, reject) => {
        let output = '', bytes = 0, failure, started = false, killTimer;
        const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch { /* already exited */ } };
        const stop = code => {
          if (failure) return;
          failure = new Error(code); kill('SIGTERM');
          killTimer = setTimeout(() => kill('SIGKILL'), 1000);
        };
        const timer = setTimeout(() => stop('builder-cre-timeout'), timeoutMs);
        child.once('spawn', () => { started = true; });
        child.once('error', () => { failure = started ? new Error('builder-cre-process-error') : new CreNotStartedError('builder-cre-not-started'); });
        const collect = (data, keep) => {
          bytes += data.length;
          if (bytes > 1048576) { stop('builder-cre-output-limit'); return; }
          if (keep) output += data.toString('utf8');
        };
        child.stdout.on('data', data => collect(data, true));
        child.stderr.on('data', data => collect(data, false));
        child.once('close', code => {
          clearTimeout(timer); clearTimeout(killTimer);
          if (failure) reject(failure);
          else if (code !== 0) reject(new Error('builder-cre-execution-failed'));
          else accept(output);
        });
      });
      return parseBuilderCreOutput(stdout, payload);
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
}
