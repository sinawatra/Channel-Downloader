import { douyin } from './douyin.js';
import { tiktok } from './tiktok.js';

// To support a new site, add its file and list it here.
const PLATFORMS = [tiktok, douyin];

export function parseChannelUrl(input) {
  const match = String(input ?? '').match(/https?:\/\/[^\s"'<>]+/);
  if (!match) throw new Error('Paste a Douyin or TikTok channel URL.');
  const url = new URL(match[0]);
  for (const platform of PLATFORMS) {
    const channel = platform.matchUrl(url);
    if (channel) return { platform, ...channel };
  }
  throw new Error('Expected a channel URL like https://www.douyin.com/user/MS4w... or https://www.tiktok.com/@name');
}

// Returns null unless this is a real page of posts. Refusals come back as an
// empty 200 or as JSON with an error status, and neither means the list ended.
export function parseListResponse(text, platform) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const status = body?.status_code ?? body?.statusCode ?? 0;
  return status === 0 && body && platform.hasMoreKey in body ? body : null;
}
