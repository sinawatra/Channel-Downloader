import { connectDevice } from './android.js';

const DOUYIN_PACKAGE = 'com.ss.android.ugc.aweme';
const SHARE_LINK = /https:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/;
const MAX_PAGES = 200;
const MAX_MISSES_IN_A_ROW = 5;
const END_OF_LIST_CHECKS = 5;
const FOCUS_CHECKS = 15;
const BACK_CHECKS = 3;
const TILE_TRIES = 2;
const CLIPBOARD_CHECKS = 12;
// Otherwise each run stacks another channel page, and reading the screen can return an old one.
const NEW_CLEARED_TASK = '0x10008000';

// Layout measured on a 1080px-wide screen, and scaled for other widths.
const BASE_WIDTH = 1080;
const SHARE_BUTTON = { x: 1000, y: 1958 };
const SAME_ROW = 100;
const TILE_ABOVE_LABEL = 160;
const TILE_RIGHT_OF_LABEL = 130;
const GRID_TOP = 300;
const GRID_BOTTOM = 2250;
const SHARE_ICON_ABOVE_LABEL = 70;
const SCROLL_STARTS = [{ x: 540, y: 2200 }, { x: 540, y: 1800 }, { x: 200, y: 1500 }];
const SCROLL_TOP = 300;
const SCROLL_LAST_ROW_TO = 520;

const OUTCOMES = {
  complete: 'Reached the end of the list Douyin shows without logging in.',
  stopped: 'Stopped.',
  'too-many-misses': 'Stopped early: several videos in a row gave no link. Check the emulator, then run it again.',
  'no-grid': 'Stopped: could not find any videos on the channel page. Check the emulator, then run it again.',
  'left-channel': 'Stopped: Douyin left the channel page. Check the emulator, then run it again.',
};

// The URL ends up in a command run by the emulator's shell, so only plain links get through.
export function parseGrabUrl(input) {
  const match = String(input ?? '').match(/https?:\/\/(?:v\.douyin\.com\/[A-Za-z0-9_-]+\/?|(?:www\.)?douyin\.com\/user\/[A-Za-z0-9_-]+)/);
  if (!match) throw new Error('Paste a Douyin channel link, such as https://v.douyin.com/abc/ or https://www.douyin.com/user/MS4w...');
  return match[0].replace(/^http:/, 'https:');
}

export function extractShareLink(text) {
  return String(text ?? '').match(SHARE_LINK)?.[0] ?? null;
}

const nodesOf = (xml) => xml.match(/<node [^>]*>/g) ?? [];

function boundsOf(node) {
  const b = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  return b ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] } : null;
}

// Each grid tile has a like-count label, which also tells tiles apart when scrolling.
export function visibleTiles(xml, scale = 1) {
  const tiles = [];
  for (const node of nodesOf(xml)) {
    const label = node.match(/content-desc="点赞数([^"]*)"/)?.[1];
    const bounds = boundsOf(node);
    if (!label || !bounds) continue;
    const x = bounds.left + TILE_RIGHT_OF_LABEL * scale;
    const y = bounds.top - TILE_ABOVE_LABEL * scale;
    if (y > GRID_TOP * scale && y < GRID_BOTTOM * scale) tiles.push({ label, x, y, row: bounds.top });
  }
  return tiles;
}

// Scrolling keeps the last row on screen, so drop the tiles already opened.
export function tilesAfterOverlap(tiles, previousRow) {
  if (!previousRow.length) return tiles;
  const labels = tiles.map((tile) => tile.label);
  for (let start = 0; start + previousRow.length <= labels.length; start++) {
    if (previousRow.every((label, offset) => labels[start + offset] === label)) {
      return tiles.slice(start + previousRow.length);
    }
  }
  return tiles;
}

export function lastRow(tiles) {
  const row = tiles.at(-1)?.row;
  // Labels in one row can sit a few pixels apart.
  return tiles.filter((tile) => Math.abs(tile.row - row) < SAME_ROW).map((tile) => tile.label);
}

export function channelVideoCount(xml) {
  const count = xml.match(/作品\s*(\d+)/)?.[1];
  return count ? Number(count) : null;
}

const gridFingerprint = (tiles) => tiles.map((tile) => `${tile.label}@${tile.row}`).join('|');

export function findBackToTop(xml) {
  for (const node of nodesOf(xml)) {
    if (!/content-desc="返回顶部"/.test(node)) continue;
    const bounds = boundsOf(node);
    if (bounds) return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  }
  return null;
}

function findShareLinkOption(xml) {
  for (const node of nodesOf(xml)) {
    if (!/ text="分享链接"/.test(node)) continue;
    const bounds = boundsOf(node);
    if (bounds) return { x: (bounds.left + bounds.right) / 2, y: bounds.top };
  }
  return null;
}

const isLogin = (focus) => focus.includes('DYLoginActivity');
const isChannel = (focus) => focus.includes('UserProfileActivity') || focus.includes('.detail.ui.DetailActivity');
const isVideo = (focus) => focus.includes('UltraDetailActivity');

// Share links redirect to a page naming the video, which is how repeats are spotted.
export async function resolveShareLink(link, fetchImpl = fetch) {
  const response = await fetchImpl(link, {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36' },
  });
  const match = (response.headers.get('location') ?? '').match(/\/(video|note|slides)\/(\d+)/);
  return { id: match?.[2] ?? null, isVideo: match?.[1] === 'video' };
}

// Only collects links, by using the Douyin app on an emulator as a person would.
// It never logs in or closes a login screen: that stays with the user.
export function startLinkGrab({
  url,
  readClipboard,
  connect = connectDevice,
  resolve = resolveShareLink,
  delays = { open: 3000, sheet: 700, settle: 400, backSettle: 1200, poll: 200, retry: 1000, scroll: 1200, loadMore: 2500, login: 1000 },
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const seen = new Set();
  const links = [];

  const job = {
    running: true,
    status: 'Connecting to the emulator…',
    needsAttention: false,
    outcome: null,
    error: null,
    expected: null,
    newestHidden: false,
    photoPosts: 0,
    missed: 0,
    stop: () => controller.abort(),
    snapshot: () => ({
      running: job.running,
      status: job.status,
      needsAttention: job.needsAttention,
      outcome: job.outcome,
      error: job.error,
      expected: job.expected,
      newestHidden: job.newestHidden,
      photoPosts: job.photoPosts,
      missed: job.missed,
      links: [...links],
    }),
  };

  const wait = (ms) => new Promise((done, fail) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
  });

  async function run() {
    const device = await connect();
    const scale = device.screen.width / BASE_WIDTH;

    async function waitWhileLoginShows() {
      const resume = job.status;
      let asked = false;
      while (isLogin(await device.focusedWindow())) {
        asked = true;
        job.needsAttention = true;
        job.status = 'Douyin is asking you to log in. Close it with the X in the emulator to continue, or press Stop.';
        await wait(delays.login);
      }
      if (asked) {
        job.needsAttention = false;
        job.status = resume;
        await wait(delays.retry);
      }
    }

    // Moves on as soon as the screen is ready, rather than always waiting the longest time.
    async function waitForScreen(isReady, tries = FOCUS_CHECKS) {
      for (let attempt = 0; attempt < tries; attempt++) {
        const focus = await device.focusedWindow();
        if (isReady(focus) || isLogin(focus)) return focus;
        await wait(delays.poll);
      }
      return device.focusedWindow();
    }

    async function returnToChannel() {
      for (let attempt = 0; attempt < 6; attempt++) {
        await waitWhileLoginShows();
        if (isChannel(await device.focusedWindow())) {
          // A tile tapped while the video is still closing can open the wrong video.
          if (attempt > 0) await wait(delays.backSettle);
          return true;
        }
        // The first press often only closes the share sheet, so don't wait long for the channel.
        await device.back();
        await waitForScreen(isChannel, BACK_CHECKS);
      }
      return false;
    }

    async function readGrid() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await device.readScreen();
        } catch {
          await wait(delays.retry);
        }
      }
      return '';
    }

    async function waitForClipboardLink(previous) {
      for (let check = 0; check < CLIPBOARD_CHECKS; check++) {
        await wait(delays.poll);
        const link = extractShareLink(await readClipboard());
        if (link && link !== previous) return link;
      }
      return null;
    }

    // The Share Link option stays in one place, so reading the screen for it is needed only once.
    let shareLinkTarget = null;

    async function copyLink(previous) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await device.tap(SHARE_BUTTON.x * scale, SHARE_BUTTON.y * scale);
        await wait(delays.sheet);
        await waitWhileLoginShows();
        if (!shareLinkTarget || attempt > 0) {
          await wait(delays.settle);
          const option = findShareLinkOption(await device.readScreen().catch(() => ''));
          if (!option) continue;
          shareLinkTarget = { x: option.x, y: option.y - SHARE_ICON_ABOVE_LABEL * scale };
        }
        await device.tap(shareLinkTarget.x, shareLinkTarget.y);
        const link = await waitForClipboardLink(previous);
        if (link) return link;
        shareLinkTarget = null;
      }
      return null;
    }

    async function openTile(tile) {
      await device.tap(tile.x, tile.y);
      if (isChannel(await waitForScreen(isVideo))) {
        // The tap didn't register, so nothing has been opened yet.
        await device.tap(tile.x, tile.y);
        await waitForScreen(isVideo);
      }
      await waitWhileLoginShows();
      await wait(delays.settle);
    }

    if (!(await device.shell('pm', 'list', 'packages', DOUYIN_PACKAGE)).includes(DOUYIN_PACKAGE)) {
      throw new Error('Douyin is not installed on the emulator.');
    }

    job.status = 'Opening the channel in Douyin…';
    await device.shell('am', 'start', '-a', 'android.intent.action.VIEW', '-f', NEW_CLEARED_TASK, '-p', DOUYIN_PACKAGE, '-d', url);
    await wait(delays.open);

    let previousLink = extractShareLink(await readClipboard());
    let previousRow = [];
    let misses = 0;

    if (!(await returnToChannel())) return 'left-channel';
    let xml = await readGrid();
    for (let attempt = 0; attempt < 5 && !visibleTiles(xml, scale).length; attempt++) {
      await wait(delays.retry);
      if (!(await returnToChannel())) return 'left-channel';
      xml = await readGrid();
    }
    // Douyin can reopen a channel where an earlier run left it.
    const toTop = findBackToTop(xml);
    if (toTop) {
      await device.tap(toTop.x, toTop.y);
      await wait(delays.scroll);
      xml = await readGrid();
    }
    job.expected = channelVideoCount(xml);
    job.newestHidden = xml.includes('最新作品');
    let tiles = visibleTiles(xml, scale);

    for (let page = 0; page < MAX_PAGES; page++) {
      if (!tiles.length) return 'no-grid';

      for (const tile of tilesAfterOverlap(tiles, previousRow)) {
        job.status = `Collecting links… ${links.length} so far`;
        // No link or a repeat usually means the tap landed badly, so each tile gets a second try.
        let gotLink = false;
        let gotNew = false;
        for (let attempt = 0; attempt < TILE_TRIES && !gotNew; attempt++) {
          await openTile(tile);
          const link = isVideo(await device.focusedWindow()) ? await copyLink(previousLink) : null;
          if (link) {
            gotLink = true;
            misses = 0;
            previousLink = link;
            const video = await resolve(link);
            gotNew = Boolean(video.id && !seen.has(video.id));
            if (gotNew && video.isVideo) links.push(link);
            else if (gotNew) job.photoPosts += 1;
            if (video.id) seen.add(video.id);
          }
          if (!(await returnToChannel())) return 'left-channel';
        }
        if (!gotLink) {
          misses += 1;
          job.missed += 1;
          if (misses >= MAX_MISSES_IN_A_ROW) return 'too-many-misses';
        }
      }

      previousRow = lastRow(tiles);
      const distance = Math.max(tiles.at(-1).row - SCROLL_LAST_ROW_TO * scale, 200 * scale);
      const current = gridFingerprint(tiles);

      // Douyin loads more videos only after a scroll reaches the bottom, and that takes
      // a moment. The page can also ignore a swipe just after a video closes, so one
      // scroll with no change doesn't mean the list has ended.
      let moved = false;
      for (let attempt = 0; attempt < END_OF_LIST_CHECKS && !moved; attempt++) {
        if (attempt > 0) job.status = `Scrolling for more videos… ${links.length} so far`;
        const start = SCROLL_STARTS[attempt % SCROLL_STARTS.length];
        const from = start.y * scale;
        await device.swipe(start.x * scale, from, Math.max(from - distance, SCROLL_TOP * scale), 500);
        await wait(attempt > 0 ? delays.loadMore : delays.scroll);
        if (!(await returnToChannel())) return 'left-channel';
        const next = visibleTiles(await readGrid(), scale);
        if (next.length && gridFingerprint(next) !== current) {
          tiles = next;
          moved = true;
        }
      }
      if (!moved) return 'complete';
    }
    return 'complete';
  }

  (async () => {
    try {
      job.outcome = OUTCOMES[await run()];
    } catch (error) {
      if (signal.aborted) job.outcome = OUTCOMES.stopped;
      else job.error = error.message;
    }
    job.needsAttention = false;
    job.status = job.error ? 'Failed' : 'Finished';
    job.running = false;
  })();

  return job;
}
