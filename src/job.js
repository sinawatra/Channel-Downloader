import { crawlChannel } from './crawler.js';
import { channelDirectory, downloadVideo, existingIds } from './downloader.js';

const CONCURRENCY = 3;

const OUTCOMES = {
  complete: 'Finished: reached the end of the channel.',
  limit: 'Finished: reached your video limit.',
  stalled: 'Stopped early: the site stopped returning videos, so this channel may be incomplete. Run it again to continue; finished videos are skipped.',
  refused: 'Stopped early: the site refused to list this channel even after reloading. Try again later.',
  'browser-closed': 'The Chrome window was closed, so this channel may be incomplete. Run it again to continue.',
  stopped: 'Stopped.',
};

// One channel run: the crawl feeds a queue that a small worker pool drains.
// Video URLs expire, so downloads start while the crawl is still going.
export function startJob({ channel, limit, root }) {
  const controller = new AbortController();
  const { signal } = controller;
  const items = new Map();
  const queue = [];
  const workers = new Set();
  let userAgent;
  let cookies = [];
  let directory = null;
  let known = new Set();
  let setup = Promise.resolve();

  const job = {
    running: true,
    status: 'Starting Chrome…',
    needsAttention: false,
    crawlDone: false,
    directory: null,
    outcome: null,
    error: null,
    photoPosts: 0,
    stop: () => controller.abort(),
    snapshot() {
      const all = [...items.values()];
      const count = (state) => all.filter((item) => item.state === state).length;
      const rank = { downloading: 0, failed: 1, queued: 2, done: 3, skipped: 4 };
      return {
        running: job.running,
        status: job.status,
        needsAttention: job.needsAttention,
        directory: job.directory,
        outcome: job.outcome,
        error: job.error,
        photoPosts: job.photoPosts,
        counts: {
          found: all.length,
          done: count('done'),
          skipped: count('skipped'),
          failed: count('failed'),
          queued: count('queued'),
          downloading: count('downloading'),
        },
        items: all
          .sort((a, b) => rank[a.state] - rank[b.state])
          .slice(0, 200),
      };
    },
  };

  const pump = () => {
    while (workers.size < CONCURRENCY && queue.length && !signal.aborted) {
      const video = queue.shift();
      const item = items.get(video.id);
      item.state = 'downloading';
      const worker = downloadVideo(video, directory, {
        signal,
        platform: channel.platform,
        userAgent,
        cookies: () => cookies,
        onProgress(received, total) {
          item.received = received;
          item.total = total;
        },
      }).then(() => {
        item.state = 'done';
      }).catch((error) => {
        item.state = 'failed';
        item.error = signal.aborted ? 'Stopped' : error.message;
      }).finally(() => {
        workers.delete(worker);
        pump();
      });
      workers.add(worker);
    }
  };

  const onVideo = (video) => {
    if (limit && items.size >= limit) return;
    items.set(video.id, {
      id: video.id,
      title: video.title,
      state: 'queued',
      received: 0,
      total: 0,
    });
    // Chained so the folder is read once and videos stay in discovery order.
    setup = setup.then(async () => {
      if (!directory) {
        directory = await channelDirectory(root, channel.platform, video);
        job.directory = directory;
        known = await existingIds(directory);
      }
      if (known.has(video.id)) {
        items.get(video.id).state = 'skipped';
        return;
      }
      queue.push(video);
      pump();
    }).catch((error) => {
      items.get(video.id).state = 'failed';
      items.get(video.id).error = error.message;
    });
  };

  (async () => {
    let result;
    try {
      result = await crawlChannel({
        channel,
        limit,
        signal,
        onVideo,
        onUserAgent: (value) => { userAgent = value; },
        onCookies: (value) => { cookies = value; },
        onStatus(status, needsAttention = false) {
          job.status = status;
          job.needsAttention = needsAttention;
        },
      });
      job.photoPosts = result.photoPosts;
    } catch (error) {
      job.error = error.message;
    }

    job.needsAttention = false;
    job.status = 'Finishing downloads…';
    await setup;
    while (workers.size) await Promise.all(workers);

    for (const item of items.values()) {
      if (item.state === 'queued') {
        item.state = 'failed';
        item.error = 'Stopped';
      }
    }
    job.outcome = result ? OUTCOMES[result.reason] : null;
    job.status = job.error ? 'Failed' : 'Finished';
    job.running = false;
  })();

  return job;
}
