import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../../src/infrastructure/web/app.js';

function get(app, path) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http.get({ port, path }, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => { server.close(); resolve({ status: r.statusCode, body: JSON.parse(data) }); });
      });
    });
  });
}

test('health is ok with no opsPool configured', async () => {
  const r = await get(createApp({}), '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('health pings opsPool and reports ok', async () => {
  const opsPool = { query: async () => [[{ 1: 1 }]] };
  const r = await get(createApp({ opsPool }), '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
  assert.equal(r.body.opsDb, 'ok');
});

test('health reports degraded (503) when opsPool ping fails', async () => {
  const opsPool = { query: async () => { throw new Error('connection refused'); } };
  const r = await get(createApp({ opsPool }), '/health');
  assert.equal(r.status, 503);
  assert.equal(r.body.opsDb, 'error');
});
