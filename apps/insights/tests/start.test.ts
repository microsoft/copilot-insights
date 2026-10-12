import assert from 'node:assert/strict';
import test from 'node:test';
import { plan, supervise } from '../start.ts';

const idle = ['-e', 'setInterval(() => {}, 1000)'];

test('the image runs the collector and the portal by default, with the authenticated collector profile', () => {
  const services = plan({});
  assert.deepEqual(services.map((service) => service.name), ['collector', 'portal']);
  assert.deepEqual(services[0].args, ['--config=/etc/copilot-insights/base.yaml', '--config=/etc/copilot-insights/azure.yaml']);
});

test('a role runs only its service, and the unauthenticated local profile is opt-in', () => {
  assert.deepEqual(plan({ COPILOT_INSIGHTS_ROLE: 'portal' }).map((service) => service.name), ['portal']);
  const [collector, ...others] = plan({ COPILOT_INSIGHTS_ROLE: 'collector', COPILOT_INSIGHTS_COLLECTOR_PROFILE: 'local' });
  assert.equal(others.length, 0);
  assert.equal(collector.args.at(-1), '--config=/etc/copilot-insights/local.yaml');
});

test('unknown roles and profiles are rejected before anything starts', () => {
  assert.throws(() => plan({ COPILOT_INSIGHTS_ROLE: 'everything' }), /COPILOT_INSIGHTS_ROLE/);
  for (const profile of ['forwarder', '../base', 'local.yaml']) {
    assert.throws(() => plan({ COPILOT_INSIGHTS_COLLECTOR_PROFILE: profile }), /COPILOT_INSIGHTS_COLLECTOR_PROFILE/);
  }
});

test('when one service exits, the others are stopped and its failure becomes the exit code', async () => {
  const supervisor = supervise([
    { name: 'long-running', command: process.execPath, args: idle },
    { name: 'failing', command: process.execPath, args: ['-e', 'process.exit(3)'] },
  ]);
  assert.equal(await supervisor.done, 3);
});

test('an unexpected clean exit still stops the container with a failure', async () => {
  const supervisor = supervise([
    { name: 'long-running', command: process.execPath, args: idle },
    { name: 'finished', command: process.execPath, args: ['-e', ''] },
  ]);
  assert.equal(await supervisor.done, 1);
});

test('a stop signal ends every service and exits cleanly', async () => {
  const supervisor = supervise([
    { name: 'first', command: process.execPath, args: idle },
    { name: 'second', command: process.execPath, args: idle },
  ]);
  supervisor.stop('SIGTERM');
  assert.equal(await supervisor.done, 0);
});

test('a service that cannot start stops the container', async () => {
  const supervisor = supervise([{ name: 'missing', command: 'copilot-insights-missing-binary', args: [] }]);
  assert.equal(await supervisor.done, 1);
});
