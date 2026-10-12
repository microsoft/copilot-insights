import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Service { name: string; command: string; args: string[] }

const roles = ['all', 'collector', 'portal'];
const profiles = ['azure', 'local'];

export function plan(env: NodeJS.ProcessEnv): Service[] {
  const role = env.COPILOT_INSIGHTS_ROLE || 'all';
  // The authenticated profile is the default, so an unconfigured collector fails closed.
  const profile = env.COPILOT_INSIGHTS_COLLECTOR_PROFILE || 'azure';
  if (!roles.includes(role)) throw new Error(`COPILOT_INSIGHTS_ROLE must be one of: ${roles.join(', ')}.`);
  if (!profiles.includes(profile)) throw new Error(`COPILOT_INSIGHTS_COLLECTOR_PROFILE must be one of: ${profiles.join(', ')}.`);
  const services: Service[] = [];
  if (role !== 'portal') {
    services.push({ name: 'collector', command: 'otelcol-contrib',
      args: ['--config=/etc/copilot-insights/base.yaml', `--config=/etc/copilot-insights/${profile}.yaml`] });
  }
  if (role !== 'collector') {
    services.push({ name: 'portal', command: process.execPath, args: [fileURLToPath(new URL('server.ts', import.meta.url))] });
  }
  return services;
}

// When one service exits, the others are stopped too, so the container restarts as a unit.
export function supervise(services: Service[]) {
  const running = new Set<ChildProcess>();
  let stopping = false;
  let exitCode = 0;
  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    for (const child of running) child.kill(signal);
  };
  const done = new Promise<number>((settle) => {
    for (const service of services) {
      const child = spawn(service.command, service.args, { stdio: 'inherit' });
      running.add(child);
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!running.delete(child)) return;
        if (!stopping) {
          console.error(`The ${service.name} stopped (${signal ?? `exit code ${code}`}); stopping the container.`);
          exitCode = code !== null && code > 0 ? code : 1;
          stop('SIGTERM');
        }
        if (running.size === 0) settle(exitCode);
      };
      child.once('error', (error) => {
        console.error(`The ${service.name} could not start: ${error.message}`);
        if (child.pid === undefined) finish(null, null);
      });
      child.once('close', finish);
    }
  });
  return { done, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let services: Service[];
  try {
    services = plan(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Copilot Insights could not start.');
    process.exit(1);
  }
  const supervisor = supervise(services);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => supervisor.stop(signal));
  process.exit(await supervisor.done);
}
