import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { openChannelStore } from '../src/channelStore.js';
import { startJob } from '../src/job.js';
import { tiktok as platform } from '../src/platforms/tiktok.js';

const roots = [];
async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-downloader-'));
  roots.push(root);
  return root;
}
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const channel = { platform, id: 'name', url: 'https://www.tiktok.com/@name' };
const videoFor = (id, overrides = {}) => ({
  id,
  title: `video ${id}`,
  createTime: 1700000000,
  channelKey: 'stable-key',
  author: 'name',
  urls: ['https://cdn/v'],
  ...overrides,
});

// Stands in for the browser: announces posts, then finishes with a reason.
const fakeCrawl = (posts, reason = 'complete') => async ({ isSatisfied, onVideo, onSkipped }) => {
  for (const post of posts) {
    if (isSatisfied()) return { reason: 'limit' };
    if (post.kind) onSkipped(post);
    else onVideo(post);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { reason };
};
const saveFile = async (video, directory) => {
  await writeFile(path.join(directory, `2023-11-14_${video.id}.mp4`), 'video');
};

async function finished(job) {
  while (job.running) await new Promise((resolve) => setTimeout(resolve, 5));
  return job.snapshot();
}
const runJob = (root, crawl, options = {}) =>
  finished(startJob({ channel, limit: 0, root, crawl, download: saveFile, ...options }));
const readRecord = async (directory) => JSON.parse(await readFile(path.join(directory, '.channel.json'), 'utf8'));

test('a run saves videos and records that it reached the end', async () => {
  const root = await tempRoot();
  const state = await runJob(root, fakeCrawl([videoFor('1000001'), videoFor('1000002')]));
  assert.equal(state.counts.done, 2);
  assert.equal(state.channel.saved, 2);
  assert.ok(state.channel.reachedEndAt);
  assert.equal(path.basename(state.directory), 'name');
  assert.ok((await readRecord(state.directory)).reachedEndAt);
});

test('stopping early does not mark the channel as reaching the end', async () => {
  const root = await tempRoot();
  const state = await runJob(root, fakeCrawl([videoFor('1000001')], 'stalled'));
  assert.equal(state.channel.reachedEndAt, null);
  assert.equal((await readRecord(state.directory)).lastRun.reason, 'stalled');
});

test('Max videos counts only new downloads', async () => {
  const root = await tempRoot();
  await runJob(root, fakeCrawl([videoFor('1000001'), videoFor('1000002')]));
  const posts = ['1000001', '1000002', '1000003', '1000004', '1000005'].map((id) => videoFor(id));
  const state = await runJob(root, fakeCrawl(posts), { limit: 2 });
  assert.equal(state.counts.skipped, 2);
  assert.equal(state.counts.done, 2);
  assert.equal(state.channel.saved, 4);
  assert.equal(state.outcome, 'Finished: reached your video limit.');
});

test('failures are remembered, then cleared when a later run succeeds', async () => {
  const root = await tempRoot();
  const failing = async () => { throw new Error('HTTP 403'); };
  const first = await runJob(root, fakeCrawl([videoFor('1000001')]), { download: failing });
  assert.equal(first.counts.failed, 1);
  assert.equal(first.channel.failed, 1);
  assert.equal((await readRecord(first.directory)).problems['1000001'].error, 'HTTP 403');

  const second = await runJob(root, fakeCrawl([videoFor('1000001')]));
  assert.equal(second.counts.done, 1);
  assert.equal(second.channel.failed, 0);
  assert.deepEqual((await readRecord(second.directory)).problems, {});
});

test('a finished run drops problems for videos no longer on the channel', async () => {
  const root = await tempRoot();
  await runJob(root, fakeCrawl([videoFor('1000001')]), { download: async () => { throw new Error('gone'); } });
  const state = await runJob(root, fakeCrawl([videoFor('1000002')]));
  assert.equal(state.channel.failed, 0);
});

test('photo posts and unplayable videos are reported separately', async () => {
  const root = await tempRoot();
  const state = await runJob(root, fakeCrawl([
    { kind: 'photo' },
    { kind: 'unplayable', id: '1000009', title: 'no clean video', channelKey: 'stable-key', author: 'name' },
    videoFor('1000001'),
  ]));
  assert.equal(state.photoPosts, 1);
  assert.equal(state.channel.unplayable, 1);
  assert.equal(state.items.find((item) => item.id === '1000009').state, 'unplayable');
});

test('stopped videos are not counted or recorded as failures', async () => {
  const root = await tempRoot();
  const hanging = (_video, _directory, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const crawl = async ({ onVideo, signal }) => {
    for (let id = 1000001; id < 1000006; id += 1) onVideo(videoFor(String(id)));
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    return { reason: 'stopped' };
  };
  const job = startJob({ channel, limit: 0, root, crawl, download: hanging });
  await new Promise((resolve) => setTimeout(resolve, 30));
  job.stop();
  const state = await finished(job);
  assert.equal(state.counts.failed, 0);
  assert.equal(state.items.filter((item) => item.state === 'stopped').length, 5);
  assert.deepEqual((await readRecord(state.directory)).problems, {});
});

test('a renamed channel keeps its folder and skips what it has', async () => {
  const root = await tempRoot();
  const first = await runJob(root, fakeCrawl([videoFor('1000001')]));
  const second = await runJob(root, fakeCrawl([videoFor('1000001', { author: 'new-name' })]));
  assert.equal(second.directory, first.directory);
  assert.equal(second.counts.skipped, 1);
  assert.equal(second.channel.name, 'new-name');
});

test('different channels with the same name get separate folders', async () => {
  const root = await tempRoot();
  const first = await runJob(root, fakeCrawl([videoFor('1000001')]));
  const second = await runJob(root, fakeCrawl([videoFor('1000001', { channelKey: 'other-key' })]));
  assert.notEqual(second.directory, first.directory);
  assert.equal(path.basename(second.directory), 'name (2)');
  assert.equal(second.counts.done, 1);
});

test('a folder from before records existed is adopted and its videos skipped', async () => {
  const root = await tempRoot();
  const legacy = path.join(root, 'TikTok', 'name');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, '2023-11-14_1000001_old.mp4'), 'video');
  const state = await runJob(root, fakeCrawl([videoFor('1000001'), videoFor('1000002')]));
  assert.equal(state.directory, legacy);
  assert.equal(state.counts.skipped, 1);
  assert.equal(state.counts.done, 1);
  assert.equal(state.channel.saved, 2);
});

test('a deleted video downloads again', async () => {
  const root = await tempRoot();
  const first = await runJob(root, fakeCrawl([videoFor('1000001')]));
  await rm(path.join(first.directory, '2023-11-14_1000001.mp4'));
  const second = await runJob(root, fakeCrawl([videoFor('1000001')]));
  assert.equal(second.counts.done, 1);
  assert.ok((await readdir(second.directory)).includes('2023-11-14_1000001.mp4'));
});

test('a damaged record does not stop the channel from opening', async () => {
  const root = await tempRoot();
  const legacy = path.join(root, 'TikTok', 'name');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, '.channel.json'), '{not json');
  const store = await openChannelStore({ root, platform, key: 'k', name: 'name' });
  assert.equal(store.directory, legacy);
  await store.finishRun('complete');
  assert.equal((await readRecord(legacy)).channelKey, 'k');
});
