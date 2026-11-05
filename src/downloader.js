import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { videoFilename } from './files.js';
import { hostMatches } from './platforms/shared.js';

const ATTEMPTS = 3;

// Applies browser cookie scoping, so cookies only reach hosts they were set for.
export function cookieHeader(url, cookies) {
  const { hostname, protocol } = new URL(url);
  return cookies
    .filter((c) => (c.domain.startsWith('.') ? hostMatches(hostname, c.domain.slice(1)) : hostname === c.domain))
    .filter((c) => !c.secure || protocol === 'https:')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function fetchToFile(url, target, { signal, platform, userAgent, cookies, onProgress }) {
  const cookie = platform.sendCookies ? cookieHeader(url, cookies()) : '';
  const response = await fetch(url, {
    signal,
    headers: {
      Referer: `${platform.origin}/`,
      ...(userAgent && { 'User-Agent': userAgent }),
      ...(cookie && { Cookie: cookie }),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((response.headers.get('content-type') ?? '').startsWith('text/')) {
    throw new Error('Received a web page instead of a video');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      onProgress(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(target), { signal });

  if (!received || (total && received !== total)) {
    throw new Error(`Incomplete download (${received} of ${total} bytes)`);
  }
}

export async function downloadVideo(video, directory, options) {
  const finalPath = path.join(directory, videoFilename(video));
  const partPath = `${finalPath}.part`;
  let lastError;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    for (const url of video.urls) {
      options.signal.throwIfAborted();
      try {
        await fetchToFile(url, partPath, options);
        await rename(partPath, finalPath);
        return finalPath;
      } catch (error) {
        lastError = error;
        await rm(partPath, { force: true });
        options.signal.throwIfAborted();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw lastError;
}
