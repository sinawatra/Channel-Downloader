import { openChannelStore } from './channelStore.js';
import { crawlChannel } from './crawler.js';
import { downloadVideo } from './downloader.js';

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
export function startJob({
  channel,
  limit,
  root,
  profileDir,
  browserChannel,
  crawl = crawlChannel,
  download = downloadVideo,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const items = new Map();
  const queue = [];
  const workers = new Set();
  let userAgent;
  let cookies = [];
  let store = null;
  let newVideos = 0;
  let accepting = true;
  let setup = Promise.resolve();

  const limitReached = () => limit > 0 && newVideos >= limit;

  const job = {
    running: true,
    status: 'Starting Chrome…',
    needsAttention: false,
    directory: null,
    outcome: null,
    error: null,
    photoPosts: 0,
    stop: () => controller.abort(),
    snapshot() {
      const all = [...items.values()];
      const count = (state) => all.filter((item) => item.state === state).length;
      const rank = { downloading: 0, failed: 1, unplayable: 2, queued: 3, stopped: 4, done: 5, skipped: 6 };
      return {
        running: job.running,
        status: job.status,
        needsAttention: job.needsAttention,
        directory: job.directory,
        outcome: job.outcome,
        error: job.error,
        photoPosts: job.photoPosts,
        channel: store?.summary() ?? null,
        counts: {
          found: all.length,
          done: count('done'),
          skipped: count('skipped'),
          failed: count('failed') + count('unplayable'),
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
      const worker = download(video, store.directory, {
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
        store.markSaved(video.id);
      }).catch((error) => {
        if (signal.aborted) {
          item.state = 'stopped';
          return;
        }
        item.state = 'failed';
        item.error = error.message;
        store.markFailed(video.id, video.title, error.message);
      }).finally(() => {
        workers.delete(worker);
        pump();
      });
      workers.add(worker);
    }
  };

  const addItem = (id, title, state, error) => {
    items.set(id, { id, title, state, received: 0, total: 0, ...(error && { error }) });
  };

  // Chained so the channel folder opens once and posts stay in discovery order.
  const inOrder = (post, handle) => {
    if (!accepting) return;
    setup = setup.then(async () => {
      store ??= await openChannelStore({
        root,
        platform: channel.platform,
        key: post.channelKey || channel.id,
        name: post.author || channel.id,
      });
      job.directory = store.directory;
      handle();
    }).catch((error) => addItem(post.id, post.title, 'failed', error.message));
  };

  const onVideo = (video) => inOrder(video, () => {
    if (store.isSaved(video.id)) {
      addItem(video.id, video.title, 'skipped');
    } else if (!limitReached()) {
      newVideos += 1;
      addItem(video.id, video.title, 'queued');
      queue.push(video);
      pump();
    }
  });

  const onSkipped = (post) => {
    if (post.kind === 'photo') {
      job.photoPosts += 1;
      return;
    }
    inOrder(post, () => {
      if (store.isSaved(post.id)) return;
      addItem(post.id, post.title, 'unplayable', 'The site gave no watermark-free video for this post.');
      store.markUnplayable(post.id, post.title);
    });
  };

  (async () => {
    let result;
    try {
      result = await crawl({
        channel,
        profileDir,
        browserChannel,
        signal,
        isSatisfied: limitReached,
        onVideo,
        onSkipped,
        onUserAgent: (value) => { userAgent = value; },
        onCookies: (value) => { cookies = value; },
        onStatus(status, needsAttention = false) {
          job.status = status;
          job.needsAttention = needsAttention;
        },
      });
    } catch (error) {
      job.error = error.message;
    }

    accepting = false;
    job.needsAttention = false;
    job.status = 'Finishing downloads…';
    await setup;
    while (workers.size) await Promise.all(workers);

    for (const item of items.values()) {
      if (item.state === 'queued') item.state = 'stopped';
    }
    try {
      await store?.finishRun(result?.reason ?? 'error');
    } catch (error) {
      job.error ??= `Could not save the channel record: ${error.message}`;
    }
    job.outcome = result ? OUTCOMES[result.reason] : null;
    job.status = job.error ? 'Failed' : 'Finished';
    job.running = false;
  })();

  return job;
}
