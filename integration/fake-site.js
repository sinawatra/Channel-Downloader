// Runs the real crawler in Chrome against a local fake site, with a throwaway
// browser profile. Opens visible Chrome windows and takes about 2 minutes.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { crawlChannel } from '../src/crawler.js';
import { startJob } from '../src/job.js';
import { tiktok } from '../src/platforms/tiktok.js';

const temp = await mkdtemp(path.join(os.tmpdir(), 'channel-downloader-fake-site-'));
const profileDir = path.join(temp, 'profile');

let scenario = {};
let counts = {};
let origin = '';

// The app aims its mouse at the exact center, so only input there is the app's.
const html = (script) => `<!doctype html><body style="height:5000px"><script>
  const report = (e) => {
    const atCenter = Math.abs(e.clientX - innerWidth / 2) < 2 && Math.abs(e.clientY - innerHeight / 2) < 2;
    if (atCenter) fetch('/app-input', { method: 'POST' });
  };
  addEventListener('mousemove', report);
  addEventListener('wheel', report);
  ${script}
</script></body>`;

const server = http.createServer((req, res) => {
  if (req.url === '/channel') {
    counts.loads += 1;
    res.setHeader('Content-Type', 'text/html');
    return res.end(html(scenario.page));
  }
  if (req.url === '/app-input') {
    counts.input += 1;
    counts.lastInputAt = Date.now();
    return res.end();
  }
  if (req.url === '/list') {
    counts.lists += 1;
    return res.end(scenario.list(counts.lists));
  }
  if (req.url === '/video') {
    res.setHeader('Content-Type', 'video/mp4');
    return res.end('fake video bytes');
  }
  res.statusCode = 404;
  return res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

const platform = { ...tiktok, origin, postsPath: '/list' };
const channel = { platform, id: 'fake', url: `${origin}/channel` };
const lastPage = () => JSON.stringify({
  statusCode: 0,
  hasMore: false,
  itemList: [{
    id: '7000000001',
    desc: 'last page',
    createTime: 1700000000,
    author: { uniqueId: 'fake', secUid: 'fake-key' },
    video: { playAddr: `${origin}/video`, downloadAddr: `${origin}/watermarked` },
  }],
});

async function crawl(config, stopAfterMs) {
  scenario = config;
  counts = { loads: 0, lists: 0, input: 0, lastInputAt: 0 };
  const controller = new AbortController();
  const statuses = new Set();
  const videos = [];
  const started = Date.now();
  const timer = stopAfterMs && setTimeout(() => controller.abort(), stopAfterMs);
  const result = await crawlChannel({
    channel,
    profileDir,
    browserChannel: 'chrome',
    signal: controller.signal,
    isSatisfied: () => false,
    onStatus: (status) => statuses.add(status),
    onVideo: (video) => videos.push(video.id),
    onSkipped() {},
    onUserAgent() {},
    onCookies() {},
  });
  clearTimeout(timer);
  return { result, videos, statuses: [...statuses], started, ...counts };
}

const scenarios = {
  async 'a CAPTCHA is left alone until it is solved'() {
    const run = await crawl({
      page: `const c = document.createElement('div'); c.id = 'captcha_container'; c.style = 'width:300px;height:200px;background:#ccc';
        document.body.prepend(c); fetch('/list');
        setTimeout(() => { c.remove(); fetch('/list'); }, 25000);`,
      list: (n) => (n === 1 ? '' : lastPage()),
    });
    assert.equal(run.loads, 1, 'page must not reload during the CAPTCHA');
    assert.equal(run.input, 0, 'no scrolling or mouse input during the CAPTCHA');
    assert.equal(run.result.reason, 'complete');
    assert.equal(run.videos.length, 1);
  },

  async 'an error response is not treated as the end of the channel'() {
    const run = await crawl({ page: `fetch('/list');`, list: () => '{"statusCode":10201,"hasMore":false}' });
    assert.equal(run.result.reason, 'refused');
    assert.equal(run.loads, 4, 'first load plus 3 reloads');
  },

  async 'scrolling stops once the crawl goes idle'() {
    const run = await crawl({ page: '', list: lastPage }, 42000);
    assert.equal(run.result.reason, 'stopped');
    assert.ok(run.input > 0, 'scrolls at first');
    assert.ok((run.lastInputAt - run.started) / 1000 < 34, 'input stops at about 30 seconds');
  },

  async 'a full job saves the video and the channel record'() {
    scenario = { page: `fetch('/list');`, list: lastPage };
    counts = { loads: 0, lists: 0, input: 0, lastInputAt: 0 };
    const root = path.join(temp, 'output');
    const job = startJob({ channel, limit: 0, root, profileDir, browserChannel: 'chrome' });
    while (job.running) await new Promise((resolve) => setTimeout(resolve, 100));
    const state = job.snapshot();
    assert.equal(state.outcome, 'Finished: reached the end of the channel.');
    assert.equal(state.counts.done, 1);
    assert.equal(state.channel.saved, 1);
    const files = await readdir(state.directory);
    const video = files.find((name) => name.endsWith('.mp4'));
    assert.equal(await readFile(path.join(state.directory, video), 'utf8'), 'fake video bytes');
    assert.ok(JSON.parse(await readFile(path.join(state.directory, '.channel.json'), 'utf8')).reachedEndAt);
  },
};

let failures = 0;
for (const [name, run] of Object.entries(scenarios)) {
  try {
    await run();
    console.log(`pass: ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL: ${name}\n  ${error.message}`);
  }
}

server.close();
await rm(temp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
