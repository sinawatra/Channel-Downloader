// Decides what the crawl does next. Pure, so every rule is testable without a browser.

export const SCROLL_DELAY_MS = 2000;
export const HINT_AFTER_MS = 30_000;
export const GIVE_UP_AFTER_MS = 180_000;
// An empty list response is sometimes followed by a good one on the same page load.
export const REFUSED_GRACE_MS = 10_000;
export const MAX_RELOADS = 3;

const finish = (reason) => ({ action: 'finish', reason });
const wait = (why) => ({ action: 'wait', why });

export function nextStep({
  satisfied,
  hasMore,
  captchaVisible,
  refusedForMs,
  requiresLogin,
  loggedIn,
  waitingForLogin,
  reloads,
  idleMs,
}) {
  if (satisfied) return finish('limit');
  if (hasMore === false) return finish('complete');

  // Comes before anything that reloads or scrolls, which would disturb the challenge.
  if (captchaVisible) return wait('captcha');

  const refused = refusedForMs !== null && refusedForMs > REFUSED_GRACE_MS;
  if (requiresLogin && !loggedIn && (refused || waitingForLogin)) return wait('login');
  if (waitingForLogin) return { action: 'reload', countsAsRetry: false };
  if (refused) {
    return reloads >= MAX_RELOADS ? finish('refused') : { action: 'reload', countsAsRetry: true };
  }

  if (idleMs > GIVE_UP_AFTER_MS) return finish('stalled');
  // No scrolling here, in case this is a prompt the checks above don't recognize.
  if (idleMs > HINT_AFTER_MS) return wait('idle');
  return { action: 'scroll' };
}
