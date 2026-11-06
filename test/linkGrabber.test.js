import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectDevice, findAdb, parseDevices, parseScreenSize } from '../src/android.js';
import {
  channelVideoCount,
  extractShareLink,
  lastRow,
  parseGrabUrl,
  resolveShareLink,
  startLinkGrab,
  tilesAfterOverlap,
  visibleTiles,
} from '../src/linkGrabber.js';

const tile = (label, row = 100) => ({ label, row, x: 0, y: 0 });
const labelNode = (label, top, left = 20) => `<node text="" content-desc="点赞数${label}" bounds="[${left},${top}][${left + 100},${top + 40}]" />`;
const finish = async (grab) => {
  while (grab.running) await new Promise((resolve) => setTimeout(resolve, 1));
  return grab.snapshot();
};
const NO_DELAYS = { open: 0, sheet: 0, settle: 0, backSettle: 0, poll: 0, retry: 0, scroll: 0, loadMore: 0, login: 0 };

// Plays the Douyin app: a grid of tiles that opens videos and copies a link for each.
function fakeDevice({ pages, loginAfterOpens = Infinity, loginStaysFor = 1, noLinkFor = [], installed = true, ignoreFirstTapOf = null, startPage = 0, listed = null, screen = { width: 1080, height: 2400 }, sameLink = null, sheetNeverOpensOnce = false }) {
  let ignored = false;
  let sheetSkipped = false;
  const state = { copied: false, page: startPage, screen: 'channel', opens: 0, loginLeft: 0, sheet: false, current: null, clipboard: 'something else', copies: 0, taps: 0, logins: 0 };
  const allTiles = pages.map((labels) => visibleTiles(labels.map((label, index) => labelNode(label, 700 + Math.floor(index / 3) * 480, 20 + (index % 3) * 360)).join(''), 1));
  const device = {
    screen,
    windowCount: async () => (state.sheet ? 21 : 20),
    shell: async (...args) => {
      if (args[0] === 'pm') return installed ? 'package:com.ss.android.ugc.aweme' : '';
      return '';
    },
    tap: async (x, y) => {
      state.taps += 1;
      if (state.screen === 'channel') {
        if (state.page > 0 && y < 200) {
          state.page = 0;
          return;
        }
        const found = allTiles[state.page].find((t) => Math.abs(t.x - x) < 1 && Math.abs(t.y - y) < 1);
        if (!found) return;
        if (found.label === ignoreFirstTapOf && !ignored) {
          ignored = true;
          return;
        }
        state.opens += 1;
        state.current = found.label;
        state.screen = 'video';
        if (state.opens > loginAfterOpens && !state.logins) {
          state.logins += 1;
          state.loginLeft = loginStaysFor;
        }
      } else if (state.screen === 'video' && !state.sheet) {
        if (y > 2000) {
          state.blindCaptionTaps = (state.blindCaptionTaps ?? 0) + 1;
          return;
        }
        if (sheetNeverOpensOnce && state.copies > 0 && !sheetSkipped) {
          sheetSkipped = true;
          return;
        }
        state.sheet = true;
      } else if (state.sheet && !noLinkFor.includes(state.current)) {
        state.copies += 1;
        state.copied = true;
        state.clipboard = sameLink ?? `5.38 复制打开抖音 https://v.douyin.com/${state.current.replace('.', '')}x${state.copies}/ 7@5.com`;
      }
    },
    swipe: async () => { state.page = Math.min(state.page + 1, pages.length - 1); },
    back: async () => {
      state.copied = false;
      if (state.sheet) state.sheet = false;
      else state.screen = 'channel';
    },
    focusedWindow: async () => {
      if (state.loginLeft > 0) {
        state.loginLeft -= 1;
        return 'mCurrentFocus=Window{1 com.ss.android.ugc.aweme.account.business.login.DYLoginActivity}';
      }
      return state.screen === 'channel'
        ? 'mCurrentFocus=Window{1 com.ss.android.ugc.aweme.profile.ui.UserProfileActivity}'
        : 'mCurrentFocus=Window{1 com.ss.android.ugc.aweme.detail.ultra.ui.UltraDetailActivity}';
    },
    readScreen: async () => {
      if (state.copied) return '<node text="链接已复制成功，去粘贴分享：" content-desc="" bounds="[42,1803][954,1861]" />';
      if (state.sheet) return '<node text="分享链接" content-desc="" bounds="[221,2226][400,2270]" />';
      if (state.screen === 'video') return '';
      const rows = pages[state.page].map((label, index) => labelNode(label, 700 + Math.floor(index / 3) * 480, 20 + (index % 3) * 360));
      const backToTop = state.page > 0 ? '<node text="" content-desc="返回顶部" bounds="[0,63][1080,200]" />' : '';
      const count = listed ?? pages.at(-1).length;
      return `<node content-desc="作品 ${count}" text="作品 ${count}" bounds="[0,0][1,1]" />${backToTop}${rows.join('')}`;
    },
  };
  return { device, state };
}

const grabWith = (fake, overrides = {}) => startLinkGrab({
  url: 'https://v.douyin.com/abc/',
  readClipboard: async () => fake.state.clipboard,
  connect: async () => fake.device,
  resolve: async (link) => ({ id: link.match(/com\/(.+)x\d+/)[1], isVideo: true }),
  delays: NO_DELAYS,
  ...overrides,
});

test('accepts only plain Douyin links, even from pasted share text', () => {
  assert.equal(parseGrabUrl('长按复制此条消息 https://v.douyin.com/sample-Link_1/ 7@5.com :7pm'), 'https://v.douyin.com/sample-Link_1/');
  assert.equal(parseGrabUrl('https://www.douyin.com/user/MS4wLjAB_x-y?from=share'), 'https://www.douyin.com/user/MS4wLjAB_x-y');
  assert.throws(() => parseGrabUrl('https://www.tiktok.com/@name'));
  assert.throws(() => parseGrabUrl('https://evil.example/v.douyin.com/abc'));
  assert.throws(() => parseGrabUrl(''));
});

test('a link cannot carry shell commands to the emulator', () => {
  assert.equal(parseGrabUrl('https://v.douyin.com/abc;reboot'), 'https://v.douyin.com/abc');
  assert.equal(parseGrabUrl('https://www.douyin.com/user/a$(reboot)'), 'https://www.douyin.com/user/a');
});

test('finds the share link inside copied text', () => {
  assert.equal(extractShareLink('2.82 复制打开抖音，看看【作者的作品】 https://v.douyin.com/sampleLink2/ a@b.com'), 'https://v.douyin.com/sampleLink2/');
  assert.equal(extractShareLink('nothing here'), null);
  assert.equal(extractShareLink(undefined), null);
});

test('reads grid tiles from like-count labels, scaled to the screen', () => {
  const xml = `${labelNode('6425', 1700, 380)}<node text="登录" content-desc="" bounds="[0,0][9,9]" />${labelNode('hidden', 2500)}${labelNode('above', 100)}`;
  assert.deepEqual(visibleTiles(xml), [{ label: '6425', x: 510, y: 1400, row: 1700 }]);
  assert.deepEqual(visibleTiles(labelNode('6425', 1700, 380), 2)[0], { label: '6425', x: 640, y: 1100, row: 1700 });
});

test('skips the row that stays on screen after scrolling', () => {
  const tiles = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => tile(label));
  assert.deepEqual(tilesAfterOverlap(tiles, []).length, 6);
  assert.deepEqual(tilesAfterOverlap(tiles, ['a', 'b', 'c']).map((t) => t.label), ['d', 'e', 'f']);
  assert.deepEqual(tilesAfterOverlap(tiles, ['x', 'y', 'z']).length, 6);
});

test('never skips tiles on an unclear match, because like counts repeat', () => {
  const tiles = ['a', 'b', 'c', 'a', 'b', 'd'].map((label) => tile(label));
  assert.equal(tilesAfterOverlap(tiles, ['b']).length, 6);
  assert.equal(tilesAfterOverlap(tiles, ['a', 'b']).length, 6);
  assert.deepEqual(tilesAfterOverlap(tiles, ['b', 'c']).map((t) => t.label), ['a', 'b', 'd']);
});

test('finds the last row and the channel size', () => {
  assert.deepEqual(lastRow([tile('a', 1), tile('b', 500), tile('c', 500)]), ['b', 'c']);
  assert.deepEqual(lastRow([tile('a', 1155), tile('b', 1160), tile('c', 1155)]), ['a', 'b', 'c']);
  assert.deepEqual(lastRow([]), []);
  assert.equal(channelVideoCount('<node text="作品 34" />'), 34);
  assert.equal(channelVideoCount('<node />'), null);
});

test('reads the video id and type from the share redirect', async () => {
  const redirect = (location) => ({ fetchImpl: async () => ({ headers: new Headers({ location }) }) });
  assert.deepEqual(await resolveShareLink('x', redirect('https://www.iesdouyin.com/share/video/123/?a=1')), { id: '123', isVideo: true });
  assert.deepEqual(await resolveShareLink('x', redirect('https://www.iesdouyin.com/share/note/456/')), { id: '456', isVideo: false });
  assert.deepEqual(await resolveShareLink('x', redirect('https://www.iesdouyin.com/other')), { id: null, isVideo: false });
});

test('uses only emulators, never a real phone', async () => {
  const execWith = (devices) => async (adb, args) => {
    if (args[0] === 'devices') return `List of devices attached\n${devices}\n`;
    if (args.includes('wm')) return 'Physical size: 1080x2400\n';
    return '';
  };
  await assert.rejects(connectDevice({ adb: 'adb', exec: execWith('R5CT123\tdevice') }), /No Android emulator/);

  const used = [];
  const exec = execWith('R5CT123\tdevice\nemulator-5554\tdevice');
  const device = await connectDevice({ adb: 'adb', exec: async (adb, args) => { used.push(args[1]); return exec(adb, args); } });
  await device.back();
  assert.ok(used.includes('emulator-5554'));
  assert.ok(!used.includes('R5CT123'));
});

test('refuses a screen shape whose button positions are unknown', async () => {
  const result = await finish(grabWith(fakeDevice({ pages: [['a']], screen: { width: 1080, height: 1920 } })));
  assert.match(result.error, /1080x1920 screen isn't supported/);
  const scaled = await finish(grabWith(fakeDevice({ pages: [['a']], screen: { width: 1440, height: 3200 } })));
  assert.equal(scaled.error, null);
});

test('keeps a link whose video could not be looked up', async () => {
  const noId = fakeDevice({ pages: [['a', 'b']] });
  const silent = await finish(grabWith(noId, { resolve: async () => ({ id: null, isVideo: false }) }));
  assert.equal(silent.links.length, 2);
  assert.equal(silent.unverified, 2);
  assert.equal(silent.missed, 0);

  const offline = fakeDevice({ pages: [['a', 'b']] });
  const failed = await finish(grabWith(offline, { resolve: async () => { throw new Error('fetch failed'); } }));
  assert.equal(failed.error, null);
  assert.equal(failed.links.length, 2);
});

test('Stop works while a link lookup is hanging', async () => {
  const fake = fakeDevice({ pages: [['a', 'b']] });
  let looking = false;
  const grab = grabWith(fake, {
    resolve: (link, { signal }) => new Promise((_, reject) => {
      looking = true;
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  while (!looking) await new Promise((resolve) => setTimeout(resolve, 1));
  grab.stop();
  assert.equal((await finish(grab)).outcome, 'Stopped.');
});

test('does not claim the end when the list stops moving early', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']], listed: 28 });
  const result = await finish(grabWith(fake));
  assert.match(result.outcome, /list stopped moving/);
  assert.equal(result.links.length, 3);
});

test('does not claim the end when the screen cannot be read after scrolling', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']] });
  fake.device.swipe = async () => { fake.device.readScreen = async () => ''; };
  const result = await finish(grabWith(fake));
  assert.match(result.outcome, /could not read the emulator screen/);
});

test('checks the screen instead of tapping blindly when the share sheet did not open', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']], sheetNeverOpensOnce: true });
  const result = await finish(grabWith(fake));
  assert.equal(fake.state.blindCaptionTaps ?? 0, 0);
  assert.equal(result.links.length, 3);
});

test('accepts a reused short link when Douyin confirms the copy', async () => {
  const link = 'https://v.douyin.com/reusedLink/';
  const fake = fakeDevice({ pages: [['a']], sameLink: `复制打开抖音 ${link}` });
  fake.state.clipboard = link;
  const result = await finish(grabWith(fake, { resolve: async () => ({ id: '1', isVideo: true }) }));
  assert.deepEqual(result.links, [link]);
  assert.equal(result.missed, 0);
});

test('backs out of an unexpected screen, like the clipboard editor', async () => {
  const fake = fakeDevice({ pages: [['a', 'b']] });
  let overlayOpen = true;
  const { focusedWindow, back } = fake.device;
  fake.device.focusedWindow = async () => (overlayOpen
    ? 'mCurrentFocus=Window{1 com.android.systemui/.clipboardoverlay.EditTextActivity}'
    : focusedWindow());
  fake.device.back = async () => {
    if (overlayOpen) overlayOpen = false;
    else await back();
  };
  const result = await finish(grabWith(fake));
  assert.equal(result.links.length, 2);
  assert.equal(result.error, null);
});

test('reports a tile that only gave a video already collected', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']] });
  const results = [{ id: '1', isVideo: true }, { id: '2', isVideo: true }, { id: '1', isVideo: true }];
  const result = await finish(grabWith(fake, { resolve: async () => results.shift() }));
  assert.equal(result.repeats, 1);
  assert.equal(fake.state.opens, 3); // an older repeat isn't worth opening again
});

test('adb is found in the Android SDK before falling back to PATH', () => {
  const exists = (candidate) => candidate.startsWith('/sdk/');
  assert.match(findAdb({ ANDROID_HOME: '/sdk' }, 'darwin', exists), /^\/sdk\/platform-tools\/adb$/);
  assert.equal(findAdb({}, 'linux', () => false), 'adb');
});

test('parses connected devices and screen size', () => {
  assert.deepEqual(parseDevices('List of devices attached\nemulator-5554\tdevice\nabc\toffline\n\n'), ['emulator-5554']);
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400\n'), { width: 1080, height: 2400 });
  assert.deepEqual(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1600\n'), { width: 720, height: 1600 });
  assert.equal(parseScreenSize('nope'), null);
});

test('collects every link across scrolling pages, opening overlapping tiles once', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f']] });
  const result = await finish(grabWith(fake));
  assert.match(result.outcome, /end of the list Douyin shows/);
  assert.equal(result.links.length, 6);
  assert.ok(result.links.every((link) => link.startsWith('https://v.douyin.com/')));
  assert.equal(result.expected, 6);
  assert.equal(fake.state.opens, 6);
});

test('waits at the login screen for the user and never taps it', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']], loginAfterOpens: 1, loginStaysFor: 60 });
  const grab = grabWith(fake);
  const originalBack = fake.device.back;
  let backsDuringLogin = 0;
  let tapsDuringLogin = 0;
  fake.device.back = async () => { if (fake.state.loginLeft > 0) backsDuringLogin += 1; return originalBack(); };
  const originalTap = fake.device.tap;
  fake.device.tap = async (x, y) => { if (fake.state.loginLeft > 0) tapsDuringLogin += 1; return originalTap(x, y); };

  while (!grab.snapshot().needsAttention) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.match(grab.snapshot().status, /log in/);

  const result = await finish(grab);
  assert.equal(backsDuringLogin, 0);
  assert.equal(tapsDuringLogin, 0);
  assert.equal(result.links.length, 3);
  assert.equal(result.needsAttention, false);
});

test('Stop at the login screen keeps the links already collected', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']], loginAfterOpens: 1, loginStaysFor: Infinity });
  const grab = grabWith(fake, { delays: { ...NO_DELAYS, login: 1 } });
  while (!grab.snapshot().needsAttention) await new Promise((resolve) => setTimeout(resolve, 1));
  grab.stop();
  const result = await finish(grab);
  assert.equal(result.outcome, 'Stopped.');
  assert.equal(result.links.length, 1);
});

test('a repeated video and a photo post add no links', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']] });
  const ids = { a: { id: '1', isVideo: true }, b: { id: '1', isVideo: true }, c: { id: '2', isVideo: false } };
  const result = await finish(grabWith(fake, { resolve: async (link) => ids[link.match(/com\/(.)x/)[1]] }));
  assert.equal(result.links.length, 1);
  assert.equal(result.photoPosts, 1);
});

test('opens a tile again when it first gives a video already collected', async () => {
  const fake = fakeDevice({ pages: [['a', 'b']] });
  const results = [{ id: '1', isVideo: true }, { id: '1', isVideo: true }, { id: '2', isVideo: true }];
  const result = await finish(grabWith(fake, { resolve: async () => results.shift() }));
  assert.equal(result.links.length, 2);
  assert.equal(result.missed, 0);
  assert.equal(fake.state.opens, 3);
});

test('counts videos that give no link and stops after several in a row', async () => {
  const some = fakeDevice({ pages: [['a', 'b', 'c']], noLinkFor: ['b'] });
  const partial = await finish(grabWith(some));
  assert.equal(partial.missed, 1);
  assert.equal(partial.links.length, 2);

  const labels = ['a', 'b', 'c', 'd', 'e', 'f'];
  const all = fakeDevice({ pages: [labels], noLinkFor: labels });
  const stuck = await finish(grabWith(all));
  assert.match(stuck.outcome, /several videos in a row/);
  assert.equal(stuck.missed, 5);
});

test('keeps scrolling at the bottom until Douyin loads more videos', async () => {
  const atBottom = ['a', 'b', 'c'];
  const fake = fakeDevice({ pages: [atBottom, atBottom, atBottom, ['a', 'b', 'c', 'd', 'e', 'f']] });
  const result = await finish(grabWith(fake));
  assert.equal(result.links.length, 6);
  assert.equal(fake.state.opens, 6);
  assert.match(result.outcome, /end of the list/);
});

test('stops only after several scrolls bring nothing new', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']] });
  let swipes = 0;
  const swipe = fake.device.swipe;
  fake.device.swipe = async (...args) => { swipes += 1; return swipe(...args); };
  const result = await finish(grabWith(fake));
  assert.equal(swipes, 5);
  assert.equal(result.links.length, 3);
});

test('starts from the top when the channel reopens partway down', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f']], startPage: 1 });
  const result = await finish(grabWith(fake));
  assert.equal(result.links.length, 6);
  assert.equal(fake.state.opens, 6);
});

test('opens the channel in a cleared task, so old channel pages cannot be read', async () => {
  const fake = fakeDevice({ pages: [['a']] });
  const commands = [];
  const shell = fake.device.shell;
  fake.device.shell = async (...args) => { commands.push(args); return shell(...args); };
  await finish(grabWith(fake));
  const open = commands.find((args) => args[0] === 'am');
  assert.deepEqual(open.slice(-6), ['-f', '0x10008000', '-p', 'com.ss.android.ugc.aweme', '-d', 'https://v.douyin.com/abc/']);
});

test('taps a tile again when the first tap did not open it', async () => {
  const fake = fakeDevice({ pages: [['a', 'b', 'c']], ignoreFirstTapOf: 'b' });
  const result = await finish(grabWith(fake));
  assert.equal(result.links.length, 3);
  assert.equal(result.missed, 0);
  assert.equal(fake.state.opens, 3);
});

test('explains a missing app, a missing emulator, and an unreadable channel page', async () => {
  const noApp = await finish(grabWith(fakeDevice({ pages: [['a']], installed: false })));
  assert.match(noApp.error, /not installed/);

  const noEmulator = await finish(grabWith(fakeDevice({ pages: [['a']] }), { connect: async () => { throw new Error('No Android emulator is running.'); } }));
  assert.match(noEmulator.error, /No Android emulator/);

  const noGrid = await finish(grabWith(fakeDevice({ pages: [[]] })));
  assert.match(noGrid.outcome, /could not find any videos/);
});
