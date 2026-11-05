import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));

// A packaged app can skip this and pass its own locations to createAppServer.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 4599,
    outputRoot: env.OUT_DIR || path.join(os.homedir(), 'Downloads', 'Channel Downloader'),
    profileDir: env.PROFILE_DIR || path.join(PROJECT_DIR, '.browser-profile'),
    browserChannel: env.BROWSER_CHANNEL || 'chrome',
  };
}
