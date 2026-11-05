import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { parseListResponse } from './parse.js';

const PROFILE_DIR = fileURLToPath(new URL('../.browser-profile', import.meta.url));
const CAPTCHA_SELECTOR = '#captcha_container, .captcha_verify_container, .captcha-verify-container, [id^="captcha-verify"], iframe[src*="verifycenter"], iframe[src*="captcha"]';
const SCROLL_DELAY_MS = 2000;
const HINT_AFTER_MS = 30_000;
const GIVE_UP_AFTER_MS = 180_000;
// An empty list response is sometimes followed by a good one on the same page load.
const REFUSED_GRACE_MS = 10_000;
const MAX_RELOADS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Opens the channel in a visible Chrome window and reads the post lists the
// page requests for itself while scrolling. Logins and CAPTCHAs are left for
// the user to complete in that window; the crawl waits for them.
export async function crawlChannel({ channel, limit, signal, onStatus, onVideo, onUserAgent, onCookies }) {
  const { platform } = channel;
  const context = await chromium.launchPersistentContext(path.resolve(PROFILE_DIR), {
    channel: 'chrome',
    headless: false,
    viewport: null,
  });

  let closed = false;
  context.on('close', () => { closed = true; });
  const closeOnAbort = () => context.close().catch(() => {});
  signal.addEventListener('abort', closeOnAbort, { once: true });

  const seen = new Set();
  let videos = 0;
  let photoPosts = 0;
  let hasMore = null;
  let lastActivity = Date.now();
  let refusedSince = null;
  let waitingForLogin = false;
  let reloads = 0;

  const page = context.pages()[0] ?? await context.newPage();
  page.on('response', async (response) => {
    try {
      if (new URL(response.url()).pathname !== platform.postsPath) return;
      const body = parseListResponse(await response.text(), platform);
      if (!body) {
        refusedSince ??= Date.now();
        return;
      }
      refusedSince = null;
      waitingForLogin = false;
      reloads = 0;
      lastActivity = Date.now();
      if (platform.sendCookies) onCookies(await context.cookies());
      for (const item of body[platform.listKey] ?? []) {
        const id = platform.itemId(item);
        if (!platform.belongsTo(item, channel.id) || seen.has(id)) continue;
        seen.add(id);
        const video = platform.toVideo(item);
        if (video) {
          videos += 1;
          onVideo(video);
        } else {
          photoPosts += 1;
        }
      }
      // Set last: the main loop ends the crawl on this, so this page must be read first.
      hasMore = Boolean(body[platform.hasMoreKey]);
    } catch {
      // Responses cut off by navigation or closing the window are expected here.
    }
  });

  try {
    onUserAgent(await page.evaluate(() => navigator.userAgent));
    onStatus('Opening channel…');
    await page.goto(channel.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    lastActivity = Date.now();

    while (!closed && !signal.aborted) {
      if (limit && videos >= limit) return { reason: 'limit', photoPosts };
      if (hasMore === false) return { reason: 'complete', photoPosts };

      // Comes first and sends no input: reloading or scrolling would disturb the challenge.
      if (await page.locator(CAPTCHA_SELECTOR).locator('visible=true').count().catch(() => 0)) {
        lastActivity = Date.now();
        refusedSince = null;
        onStatus(`${platform.name} is showing a CAPTCHA. Please complete it in the Chrome window.`, true);
        await sleep(SCROLL_DELAY_MS);
        continue;
      }

      const refused = refusedSince !== null && Date.now() - refusedSince > REFUSED_GRACE_MS;
      const cookies = await context.cookies(platform.origin);
      const loggedIn = cookies.some((cookie) => cookie.name === 'sessionid' && cookie.value);
      if (platform.requiresLogin && !loggedIn && (refused || waitingForLogin)) {
        waitingForLogin = true;
        onStatus(`${platform.name} only lists this channel for logged-in accounts. Log in in the Chrome window to continue, or press Stop if you have no account.`, true);
        await sleep(SCROLL_DELAY_MS);
        continue;
      }
      if (waitingForLogin || refused) {
        if (!waitingForLogin && ++reloads > MAX_RELOADS) return { reason: 'refused', photoPosts };
        waitingForLogin = false;
        refusedSince = null;
        onStatus('Reloading channel…');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        lastActivity = Date.now();
        await sleep(SCROLL_DELAY_MS);
        continue;
      }

      const idle = Date.now() - lastActivity;
      if (idle > GIVE_UP_AFTER_MS) return { reason: 'stalled', photoPosts };
      if (idle > HINT_AFTER_MS) {
        // Stop scrolling too, in case this is a prompt the checks above don't recognize.
        onStatus('No new videos yet. Check the Chrome window for a login prompt or CAPTCHA.', true);
        await sleep(SCROLL_DELAY_MS);
        continue;
      }
      onStatus(`Browsing channel… ${videos} videos found`);

      const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await page.mouse.move(size.width / 2, size.height / 2);
      await page.mouse.wheel(0, size.height * 2);
      await sleep(SCROLL_DELAY_MS);
    }
    return { reason: signal.aborted ? 'stopped' : 'browser-closed', photoPosts };
  } catch (error) {
    if (closed || signal.aborted) {
      return { reason: signal.aborted ? 'stopped' : 'browser-closed', photoPosts };
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    await context.close().catch(() => {});
  }
}
