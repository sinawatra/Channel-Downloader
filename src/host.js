import { execFile } from 'node:child_process';

const OPENERS = { darwin: 'open', win32: 'explorer' };
const CLIPBOARD_READERS = {
  darwin: ['pbpaste', []],
  win32: ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']],
  linux: ['xclip', ['-selection', 'clipboard', '-o']],
};

// Android emulators share their clipboard with the computer.
export function readClipboard(platform = process.platform) {
  const [command, args] = CLIPBOARD_READERS[platform] ?? CLIPBOARD_READERS.linux;
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error(`Could not read the clipboard: ${error.message}`));
      else resolve(stdout);
    });
  });
}

export function openFolder(directory, platform = process.platform) {
  return new Promise((resolve, reject) => {
    execFile(OPENERS[platform] ?? 'xdg-open', [directory], (error) => {
      // Explorer exits with 1 even when it opens the folder.
      if (error && platform !== 'win32') reject(new Error(`Could not open the folder: ${error.message}`));
      else resolve();
    });
  });
}
