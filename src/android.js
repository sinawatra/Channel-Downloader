import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Android Studio installs adb here unless the user chose another location.
export function findAdb(env = process.env, platform = process.platform, exists = existsSync) {
  const executable = platform === 'win32' ? 'adb.exe' : 'adb';
  const sdks = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    platform === 'darwin' && path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    platform === 'win32' && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk'),
    platform === 'linux' && path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const sdk of sdks) {
    const candidate = path.join(sdk, 'platform-tools', executable);
    if (exists(candidate)) return candidate;
  }
  return executable;
}

export function parseDevices(output) {
  return output.split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => serial);
}

export function parseScreenSize(output) {
  const sizes = [...output.matchAll(/(\d+)x(\d+)/g)];
  const last = sizes.at(-1); // "Override size" comes after "Physical size".
  return last ? { width: Number(last[1]), height: Number(last[2]) } : null;
}

function run(adb, args) {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function connectDevice({ adb = findAdb(), exec = run } = {}) {
  let devices;
  try {
    devices = parseDevices(await exec(adb, ['devices']));
  } catch {
    throw new Error('Could not run adb. Install Android Studio, or set ANDROID_HOME to your Android SDK folder.');
  }
  // Blind taps and back presses must never reach someone's real phone.
  const serial = devices.find((device) => device.startsWith('emulator-'));
  if (!serial) throw new Error('No Android emulator is running. Start one, then try again. Real phones are not used.');

  const shell = (...args) => exec(adb, ['-s', serial, 'shell', ...args]);
  const screen = parseScreenSize(await shell('wm', 'size')) ?? { width: 1080, height: 2400 };

  return {
    screen,
    shell,
    tap: (x, y) => shell('input', 'tap', String(Math.round(x)), String(Math.round(y))),
    swipe: (x, fromY, toY, ms) => shell('input', 'swipe', String(Math.round(x)), String(Math.round(fromY)), String(Math.round(x)), String(Math.round(toY)), String(ms)),
    back: () => shell('input', 'keyevent', '4'),
    async focusedWindow() {
      return (await shell('dumpsys', 'window')).match(/mCurrentFocus=.*/)?.[0] ?? '';
    },
    // Much faster than reading the screen, and a share sheet adds a window.
    async windowCount() {
      return (await shell('dumpsys', 'window', 'windows')).match(/Window #\d+/g)?.length ?? 0;
    },
    // Fails while a video is playing, because the screen never goes idle.
    async readScreen() {
      await shell('uiautomator', 'dump', '/sdcard/channel-downloader-ui.xml');
      const xml = await exec(adb, ['-s', serial, 'exec-out', 'cat', '/sdcard/channel-downloader-ui.xml']);
      await shell('rm', '-f', '/sdcard/channel-downloader-ui.xml');
      return xml;
    },
  };
}
