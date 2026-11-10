const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { get } = require('node:https');
const { setTimeout: pause } = require('node:timers/promises');
const { test } = require('node:test');

const project = process.env.COMPOSE_TEST_PROJECT;
const envFile = process.env.COMPOSE_TEST_ENV_FILE;
const base = process.env.GATEWAY_TEST_URL;
const enabled = Boolean(/^ds03-(hardening|acceptance)/.test(project ?? '') && envFile && base?.startsWith('https:'));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000 }).trim();
const compose = args => docker(['compose', '-p', project, '--env-file', envFile,
  '-f', 'deploy/docker-compose.yml', ...args]);
const health = path => fetch(base + path, {
  headers: { connection: 'close' }, signal: AbortSignal.timeout(5000),
});

test('Gateway HTTPS validates hostname and trust; Identity and Trip run non-root', { skip: !enabled }, async () => {
  assert.equal((await health('/ready')).status, 200);
  await assert.rejects(new Promise((resolve, reject) => {
    get(base + '/live', { ca: [] }, response => { response.resume(); resolve(); }).on('error', reject);
  }), /self.signed|certificate/i);
  for (const service of ['identity', 'trip']) {
    const uid = compose(['exec', '-T', service, 'node', '-p', 'process.getuid()']);
    assert.equal(uid, '1000');
  }
});

test('RabbitMQ denies cross-service queue, exchange, routing key and bad credentials', { skip: !enabled }, () => {
  const source = `
    const assert = require('node:assert/strict');
    const {connect} = require('amqplib');
    async function denied(operation) {
      const c = await connect(process.env.RABBITMQ_URL);
      c.on('error', () => {});
      try {
        const ch = await c.createConfirmChannel();
        const failure = new Promise(resolve => ch.once('error', resolve));
        operation(ch).catch(() => {});
        const deadline = setTimeout(() => { void c.close().catch(() => {}); }, 4000);
        try {
          const error = await Promise.race([failure, new Promise(resolve => ch.once('close', () => resolve(null)))]);
          assert.equal(error?.code, 403);
        } finally { clearTimeout(deadline); }
      } finally { await c.close().catch(() => {}); }
    }
    (async () => {
      const wrong = new URL(process.env.RABBITMQ_URL);
      wrong.password = 'invalid-probe';
      await assert.rejects(connect(wrong.toString()), /ACCESS_REFUSED/);
      if (process.argv[1] === 'matching') {
        await denied(ch => ch.get('payment.queue'));
        await denied(ch => ch.assertQueue('matching.probe'));
        await denied(async ch => { ch.publish('trip.exchange','payment.event.hold_success',Buffer.from('{}')); });
        wrong.username = 'driver';
        await assert.rejects(connect(wrong.toString()), /ACCESS_REFUSED/);
      } else {
        await denied(async ch => { ch.publish('trip.dlx','probe',Buffer.from('{}')); });
      }
    })().catch(error => { console.error(error.message); process.exitCode=1; });`;
  for (const service of ['matching', 'payment']) {
    compose(['exec', '-T', service, 'node', '-e', source, service]);
  }
  assert.equal(compose(['exec', '-T', 'driver', 'node', '-p', 'Boolean(process.env.RABBITMQ_URL)']), 'false');
});

test('Gateway liveness survives an Identity network partition and readiness recovers', {
  skip: !enabled || process.env.RUN_NETWORK_TEST !== '1', timeout: 45_000,
}, async () => {
  const id = compose(['ps', '-q', 'identity']);
  const network = project + '_default';
  docker(['network', 'disconnect', network, id]);
  try {
    assert.equal((await health('/live')).status, 200);
    assert.equal((await health('/ready')).status, 503);
  } finally {
    docker(['network', 'connect', '--alias', 'identity', network, id]);
  }
  for (let i = 0; i < 10; i++) {
    if ((await health('/ready')).status === 200) return;
    await pause(300);
  }
  assert.fail('Gateway did not regain readiness');
});

test('Gateway regains readiness after RabbitMQ restarts with service ACL', {
  skip: !enabled || process.env.RUN_NETWORK_TEST !== '1', timeout: 85_000,
}, async () => {
  const id = compose(['ps', '-q', 'rabbitmq']);
  docker(['restart', id]);
  const deadline = Date.now() + 60_000;
  do {
    if ((await health('/ready')).status === 200) return;
    await pause(1000);
  } while (Date.now() < deadline);
  assert.fail('Consumers did not recover with their existing ACL');
});
