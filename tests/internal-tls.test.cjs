const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { readFileSync } = require('node:fs');
const { once } = require('node:events');

const project = process.env.INTERNAL_TLS_TEST_PROJECT;
const enabled = project?.startsWith('ds03-acceptance');
test('Infrastructure TLS requires trusted server identities and rejects plaintext', { skip: !enabled }, () => {
  const probe = `
    const assert = require('node:assert/strict');
    const { lookup } = require('node:dns/promises');
    const { Client } = require('pg');
    const { connect } = require('amqplib');
    async function pg(ssl, host = 'postgres') {
      const client = new Client({ host, database: process.env.MATCHING_DB_NAME || 'match_db',
        user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD,
        ssl, connectionTimeoutMillis: 5000 });
      try {
        await client.connect();
        return (await client.query('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
      } finally { await client.end(); }
    }
    (async () => {
      const verified = await pg(undefined);
      assert.equal(verified.ssl, true);
      assert.match(verified.version, /^TLSv1\\.[23]$/);
      await assert.rejects(pg(false), /no pg_hba.conf entry|no encryption/i);
      await assert.rejects(pg({ ca: [] }), /certificate/i);
      await assert.rejects(pg({ servername: 'invalid.ds03.test' }, (await lookup('postgres')).address),
        /altnames|hostname/i);

      const broker = await connect(process.env.RABBITMQ_URL, { timeout: 5000 });
      await broker.close();
      await assert.rejects(connect(process.env.RABBITMQ_URL, { ca: [], timeout: 5000 }), /certificate/i);
      await assert.rejects(connect(process.env.RABBITMQ_URL, { servername: 'invalid.ds03.test', timeout: 5000 }),
        /altnames|hostname/i);
      const plain = new URL(process.env.RABBITMQ_URL);
      plain.protocol = 'amqp:';
      plain.port = '5672';
      await assert.rejects(connect(plain.toString(), { timeout: 5000 }), /ECONNREFUSED/);
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  `;
  execFileSync('docker', ['exec', `${project}-matching-1`, 'node', '-e', probe],
    { stdio: 'inherit', timeout: 35_000 });
});

test('Node TLS rejects an expired CA-signed leaf with a matching hostname', {
  skip: !process.env.EXPIRED_TLS_CERT || !process.env.EXPIRED_TLS_KEY || !process.env.INTERNAL_TLS_TEST_CA,
}, async t => {
  const server = tls.createServer({
    cert: readFileSync(process.env.EXPIRED_TLS_CERT), key: readFileSync(process.env.EXPIRED_TLS_KEY),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'postgres',
    ca: readFileSync(process.env.INTERNAL_TLS_TEST_CA) });
  await assert.rejects(once(client, 'secureConnect'), { code: 'CERT_HAS_EXPIRED' });
});
