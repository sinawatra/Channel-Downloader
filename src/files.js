// File and folder naming. Pure, and safe on both macOS and Windows.

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// Limited in bytes because filesystems cap names at 255 bytes, and one emoji is 4.
export function sanitizeName(name, maxBytes = 150) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+/, '')
    .trimEnd();

  let result = '';
  let bytes = 0;
  for (const character of clean) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    result += character;
  }
  result = result.replace(/[. ]+$/, '');
  return WINDOWS_RESERVED.test(result) ? `_${result}` : result;
}

export function videoFilename(video) {
  const date = video.createTime
    ? new Date(video.createTime * 1000).toISOString().slice(0, 10)
    : 'unknown-date';
  const title = sanitizeName(video.title);
  return `${date}_${video.id}${title ? `_${title}` : ''}.mp4`;
}

export function idFromFilename(filename) {
  return filename.match(/^[\w-]+?_(\d{6,})(?:_.*)?\.mp4$/)?.[1] ?? null;
}
