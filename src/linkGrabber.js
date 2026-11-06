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
const SHEET_CHECKS = 8;
const RESOLVE_TIMEOUT_MS = 10_000;
const LAYOUT_RATIO = 2400 / 1080;
const LAYOUT_RATIO_TOLERANCE = 0.03;
// Otherwise each run stacks another channel page, and reading the screen can return an old one.
const NEW_CLEARED_TASK = '0x10008000';

// Layout measured on a 1080px-wide screen, and scaled for other widths.
const BASE_WIDTH = 1080;
const SHARE_BUTTON = { x: 1000, y: 1958 };
const SAME_ROW = 100;
// High in the tile, because Android's clipboard preview covers the screen's bottom-left corner.
const TILE_ABOVE_LABEL = 300;
const TILE_RIGHT_OF_LABEL = 130;
const GRID_TOP = 300;
const GRID_BOTTOM = 2100;
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
  incomplete: 'Stopped early: the list stopped moving before every video Douyin lists was reached, so this may be incomplete. Run it again.',
  unreadable: 'Stopped early: could not read the emulator screen after scrolling, so this may be incomplete. Run it again.',
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
  // Like counts repeat, so skip only on a clear match. Reopening a tile costs time;
  // wrongly skipping one loses a video.
  if (previousRow.length < 2) return tiles;
  const labels = tiles.map((tile) => tile.label);
  const matches = [];
  for (let start = 0; start + previousRow.length <= labels.length; start++) {
    if (previousRow.every((label, offset) => labels[start + offset] === label)) matches.push(start);
  }
  return matches.length === 1 ? tiles.slice(matches[0] + previousRow.length) : tiles;
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
export async function resolveShareLink(link, { signal, fetchImpl = fetch } = {}) {
  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const response = await fetchImpl(link, {
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
  delays = { open: 3000, sheet: 400, settle: 400, backSettle: 1200, poll: 200, retry: 1000, scroll: 1200, loadMore: 2500, login: 1000 },
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
    repeats: 0,
    unverified: 0,
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
      repeats: job.repeats,
      unverified: job.unverified,
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
    const { width, height } = device.screen;
    if (Math.abs(height / width - LAYOUT_RATIO) > LAYOUT_RATIO_TOLERANCE) {
      throw new Error(`This emulator's ${width}x${height} screen isn't supported. Use one shaped like 1080x2400, such as Medium Phone.`);
    }
    const scale = width / BASE_WIDTH;

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

    let sheetMayBeOpen = false;

    async function returnToChannel() {
      for (let attempt = 0; attempt < 6; attempt++) {
        await waitWhileLoginShows();
        const focus = await device.focusedWindow();
        if (isChannel(focus)) {
          // A tile tapped while the video is still closing can open the wrong video.
          if (attempt > 0) await wait(delays.backSettle);
          return true;
        }
        // Pressing back while the screen is changing could leave Douyin altogether.
        if (focus.includes('mCurrentFocus=null')) {
          await waitForScreen(isChannel);
          continue;
        }
        // A press that only closes the share sheet won't bring the channel back, so
        // that wait is short. Otherwise the channel is coming, so wait for it.
        const closingSheet = sheetMayBeOpen;
        sheetMayBeOpen = false;
        await device.back();
        await waitForScreen(isChannel, closingSheet ? BACK_CHECKS : FOCUS_CHECKS);
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

    async function waitForSheet(windowsBefore) {
      for (let check = 0; check < SHEET_CHECKS; check++) {
        if (await device.windowCount() > windowsBefore) return true;
        await wait(delays.poll);
      }
      return false;
    }

    async function copyLink(previous) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const windowsBefore = await device.windowCount();
        sheetMayBeOpen = true;
        await device.tap(SHARE_BUTTON.x * scale, SHARE_BUTTON.y * scale);
        const sheetOpened = await waitForSheet(windowsBefore);
        await waitWhileLoginShows();
        // A tap with no sheet could land on the video's caption and open another page. Reading
        // the screen here wouldn't help: it blocks for about 12 seconds while a video plays.
        if (!sheetOpened) continue;
        if (shareLinkTarget && attempt === 0) {
          await wait(delays.sheet); // lets the sheet finish sliding in
        } else {
          await wait(delays.settle);
          const option = findShareLinkOption(await device.readScreen().catch(() => ''));
          if (!option) continue;
          shareLinkTarget = { x: option.x, y: option.y - SHARE_ICON_ABOVE_LABEL * scale };
        }
        await device.tap(shareLinkTarget.x, shareLinkTarget.y);
        const link = await waitForClipboardLink(previous);
        if (link) return link;
        // Douyin can reuse a video's short link, so an unchanged clipboard may still be a good copy.
        if ((await device.readScreen().catch(() => '')).includes('链接已复制')) {
          const reused = extractShareLink(await readClipboard());
          if (reused) return reused;
        }
        shareLinkTarget = null;
      }
      return null;
    }

    // A failed lookup shouldn't end the run or lose the link, which is still good.
    async function lookUp(link) {
      try {
        return await resolve(link, { signal });
      } catch {
        signal.throwIfAborted();
        return { id: null, isVideo: true };
      }
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
    let lastVideoId = null;

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
        // No link, or the video just before this one, means the tap landed badly, so try again.
        // An older repeat is a tile already collected, so opening it again wouldn't help.
        let gotLink = false;
        let gotNew = false;
        let tryAgain = true;
        for (let attempt = 0; attempt < TILE_TRIES && tryAgain; attempt++) {
          await openTile(tile);
          const link = isVideo(await device.focusedWindow()) ? await copyLink(previousLink) : null;
          tryAgain = !link;
          if (link) {
            gotLink = true;
            misses = 0;
            previousLink = link;
            const video = await lookUp(link);
            if (!video.id) {
              gotNew = true;
              if (!links.includes(link)) {
                links.push(link);
                job.unverified += 1;
              }
            } else {
              gotNew = !seen.has(video.id);
              tryAgain = !gotNew && video.id === lastVideoId;
              if (gotNew && video.isVideo) links.push(link);
              else if (gotNew) job.photoPosts += 1;
              seen.add(video.id);
              lastVideoId = video.id;
            }
          }
          if (!(await returnToChannel())) return 'left-channel';
        }
        if (!gotLink) {
          misses += 1;
          job.missed += 1;
          if (misses >= MAX_MISSES_IN_A_ROW) return 'too-many-misses';
        } else if (!gotNew) {
          job.repeats += 1;
        }
      }

      previousRow = lastRow(tiles);
      const distance = Math.max(tiles.at(-1).row - SCROLL_LAST_ROW_TO * scale, 200 * scale);
      const current = gridFingerprint(tiles);

      // Douyin loads more videos only after a scroll reaches the bottom, and that takes
      // a moment. The page can also ignore a swipe just after a video closes, so one
      // scroll with no change doesn't mean the list has ended.
      let moved = false;
      let sawGrid = false;
      let latestScreen = '';
      for (let attempt = 0; attempt < END_OF_LIST_CHECKS && !moved; attempt++) {
        if (attempt > 0) job.status = `Scrolling for more videos… ${links.length} so far`;
        const start = SCROLL_STARTS[attempt % SCROLL_STARTS.length];
        const from = start.y * scale;
        await device.swipe(start.x * scale, from, Math.max(from - distance, SCROLL_TOP * scale), 500);
        await wait(attempt > 0 ? delays.loadMore : delays.scroll);
        if (!(await returnToChannel())) return 'left-channel';
        const screen = await readGrid();
        const next = visibleTiles(screen, scale);
        if (next.length) {
          sawGrid = true;
          latestScreen = screen;
        }
        if (next.length && gridFingerprint(next) !== current) {
          tiles = next;
          moved = true;
        }
      }
      if (!moved) {
        // A list that stops moving is only finished if every video Douyin lists was accounted for.
        if (!sawGrid) return 'unreadable';
        const listed = channelVideoCount(latestScreen);
        const accounted = seen.size + job.unverified + job.missed;
        return listed && accounted < listed ? 'incomplete' : 'complete';
      }
    }
    return 'incomplete';
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
