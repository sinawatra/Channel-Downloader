import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppServer } from '../src/server.js';

async function withServer(options, run) {
  const server = createAppServer({ outputRoot: '/tmp/none', ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const start = (base, url = 'https://v.douyin.com/abc/') => fetch(`${base}/api/links/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url }),
});

test('a double-click cannot start two link grabbers', async () => {
  let started = 0;
  const startGrab = () => {
    started += 1;
    return { running: true, stop() {}, snapshot: () => ({ running: true, links: [] }) };
  };
  await withServer({ startGrab }, async (base) => {
    const statuses = (await Promise.all([start(base), start(base)])).map((response) => response.status);
    assert.deepEqual(statuses.sort(), [200, 409]);
    assert.equal(started, 1);
  });
});

test('rejects links that are not Douyin channels, and other sites calling the app', async () => {
  let started = 0;
  const startGrab = () => { started += 1; return { running: false, snapshot: () => ({}) }; };
  await withServer({ startGrab }, async (base) => {
    assert.equal((await start(base, 'https://www.tiktok.com/@name')).status, 400);
    const forged = await fetch(`${base}/api/links/start`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({ url: 'https://v.douyin.com/abc/' }),
    });
    assert.equal(forged.status, 403);
    assert.equal(started, 0);
  });
});
