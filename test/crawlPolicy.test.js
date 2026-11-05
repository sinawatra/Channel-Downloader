import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GIVE_UP_AFTER_MS, HINT_AFTER_MS, MAX_RELOADS, nextStep, REFUSED_GRACE_MS } from '../src/crawlPolicy.js';

const browsing = {
  satisfied: false,
  hasMore: true,
  captchaVisible: false,
  refusedForMs: null,
  requiresLogin: false,
  loggedIn: false,
  waitingForLogin: false,
  reloads: 0,
  idleMs: 0,
};
const refused = REFUSED_GRACE_MS + 1;

test('scrolls while browsing normally', () => {
  assert.deepEqual(nextStep(browsing), { action: 'scroll' });
});

test('finishes on the limit or the end of the list', () => {
  assert.deepEqual(nextStep({ ...browsing, satisfied: true }), { action: 'finish', reason: 'limit' });
  assert.deepEqual(nextStep({ ...browsing, hasMore: false }), { action: 'finish', reason: 'complete' });
});

test('a CAPTCHA blocks reloads, scrolling and giving up', () => {
  const expected = { action: 'wait', why: 'captcha' };
  assert.deepEqual(nextStep({ ...browsing, captchaVisible: true }), expected);
  assert.deepEqual(nextStep({ ...browsing, captchaVisible: true, refusedForMs: refused }), expected);
  assert.deepEqual(nextStep({ ...browsing, captchaVisible: true, refusedForMs: refused, reloads: MAX_RELOADS }), expected);
  assert.deepEqual(nextStep({ ...browsing, captchaVisible: true, idleMs: GIVE_UP_AFTER_MS + 1 }), expected);
});

test('an empty response gets a grace period before reloading', () => {
  assert.deepEqual(nextStep({ ...browsing, refusedForMs: REFUSED_GRACE_MS }), { action: 'scroll' });
  assert.deepEqual(nextStep({ ...browsing, refusedForMs: refused }), { action: 'reload', countsAsRetry: true });
});

test('stops as refused once reloads run out', () => {
  assert.deepEqual(nextStep({ ...browsing, refusedForMs: refused, reloads: MAX_RELOADS - 1 }), { action: 'reload', countsAsRetry: true });
  assert.deepEqual(nextStep({ ...browsing, refusedForMs: refused, reloads: MAX_RELOADS }), { action: 'finish', reason: 'refused' });
});

test('login-only sites wait for login, then reload without using a retry', () => {
  const site = { ...browsing, requiresLogin: true };
  assert.deepEqual(nextStep({ ...site, refusedForMs: refused }), { action: 'wait', why: 'login' });
  assert.deepEqual(nextStep({ ...site, waitingForLogin: true }), { action: 'wait', why: 'login' });
  assert.deepEqual(nextStep({ ...site, waitingForLogin: true, loggedIn: true }), { action: 'reload', countsAsRetry: false });
});

test('sites without a login requirement never wait for login', () => {
  assert.equal(nextStep({ ...browsing, refusedForMs: refused }).why, undefined);
});

test('going idle stops scrolling, then gives up', () => {
  assert.deepEqual(nextStep({ ...browsing, idleMs: HINT_AFTER_MS }), { action: 'scroll' });
  assert.deepEqual(nextStep({ ...browsing, idleMs: HINT_AFTER_MS + 1 }), { action: 'wait', why: 'idle' });
  assert.deepEqual(nextStep({ ...browsing, idleMs: GIVE_UP_AFTER_MS + 1 }), { action: 'finish', reason: 'stalled' });
});
