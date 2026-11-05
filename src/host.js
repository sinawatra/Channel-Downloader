import { execFile } from 'node:child_process';

const OPENERS = { darwin: 'open', win32: 'explorer' };

export function openFolder(directory, platform = process.platform) {
  return new Promise((resolve, reject) => {
    execFile(OPENERS[platform] ?? 'xdg-open', [directory], (error) => {
      // Explorer exits with 1 even when it opens the folder.
      if (error && platform !== 'win32') reject(new Error(`Could not open the folder: ${error.message}`));
      else resolve();
    });
  });
}
