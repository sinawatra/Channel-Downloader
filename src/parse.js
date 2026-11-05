// Pure helpers for reading channel URLs and each platform's post data.

const hostMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

export function parseChannelUrl(input) {
  const match = String(input ?? '').match(/https?:\/\/[^\s"'<>]+/);
  if (!match) throw new Error('Paste a Douyin or TikTok channel URL.');
  const url = new URL(match[0]);

  const secUid = url.pathname.match(/^\/user\/([\w.-]+)\/?$/)?.[1];
  if (hostMatches(url.hostname, 'douyin.com') && secUid) {
    return { platform: PLATFORMS.douyin, id: secUid, url: `https://www.douyin.com/user/${secUid}?showTab=post` };
  }
  const handle = url.pathname.match(/^\/@([\w.-]+)\/?$/)?.[1];
  if (hostMatches(url.hostname, 'tiktok.com') && handle) {
    return { platform: PLATFORMS.tiktok, id: handle.toLowerCase(), url: `https://www.tiktok.com/@${handle}` };
  }
  throw new Error('Expected a channel URL like https://www.douyin.com/user/MS4w... or https://www.tiktok.com/@name');
}

const uniqueHttpUrls = (urls) => [...new Set(urls)].filter((u) => /^https?:\/\//.test(u));

// Returns null for posts without a video, such as photo carousels.
// Both platforms expose a watermarked download address (download_addr and
// downloadAddr). Those must never be used, even as a fallback.
export function toDouyinVideo(aweme) {
  const video = aweme?.video;
  if (!aweme?.aweme_id || !video || aweme.images?.length) return null;

  const renditions = (video.bit_rate ?? [])
    .filter((r) => r.play_addr?.url_list?.length)
    .sort((a, b) =>
      (b.play_addr.height ?? 0) - (a.play_addr.height ?? 0) ||
      (a.is_h265 ?? 0) - (b.is_h265 ?? 0) ||
      (b.bit_rate ?? 0) - (a.bit_rate ?? 0));

  const urls = uniqueHttpUrls([
    ...(renditions[0]?.play_addr.url_list ?? []),
    ...(video.play_addr?.url_list ?? []),
  ]);
  if (!urls.length) return null;

  return {
    id: String(aweme.aweme_id),
    title: aweme.desc ?? '',
    createTime: aweme.create_time ?? 0,
    author: aweme.author?.nickname || aweme.author?.sec_uid || '',
    urls,
  };
}

export function toTikTokVideo(item) {
  const video = item?.video;
  if (!item?.id || !video || item.imagePost) return null;

  const isH265 = (r) => (/h265|bytevc1/i.test(r.CodecType ?? '') ? 1 : 0);
  const renditions = (video.bitrateInfo ?? [])
    .filter((r) => r.PlayAddr?.UrlList?.length)
    .sort((a, b) =>
      (b.PlayAddr.Height ?? 0) - (a.PlayAddr.Height ?? 0) ||
      isH265(a) - isH265(b) ||
      (b.Bitrate ?? 0) - (a.Bitrate ?? 0));

  const urls = uniqueHttpUrls([
    ...(renditions[0]?.PlayAddr.UrlList ?? []),
    ...(video.playAddr ? [video.playAddr] : []),
  ]);
  if (!urls.length) return null;

  return {
    id: String(item.id),
    title: item.desc ?? '',
    createTime: Number(item.createTime) || 0,
    author: item.author?.uniqueId ?? '',
    urls,
  };
}

export const PLATFORMS = {
  douyin: {
    name: 'Douyin',
    origin: 'https://www.douyin.com',
    postsPath: '/aweme/v1/web/aweme/post/',
    listKey: 'aweme_list',
    hasMoreKey: 'has_more',
    requiresLogin: true,
    sendCookies: false,
    toVideo: toDouyinVideo,
    belongsTo: (aweme, id) => !aweme.author?.sec_uid || aweme.author.sec_uid === id,
    itemId: (aweme) => aweme.aweme_id,
  },
  tiktok: {
    name: 'TikTok',
    origin: 'https://www.tiktok.com',
    postsPath: '/api/post/item_list/',
    listKey: 'itemList',
    hasMoreKey: 'hasMore',
    requiresLogin: false,
    // The page's own video requests carry these cookies, so downloads do too.
    sendCookies: true,
    toVideo: toTikTokVideo,
    belongsTo: (item, id) => !item.author?.uniqueId || item.author.uniqueId.toLowerCase() === id,
    itemId: (item) => item.id,
  },
};

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

// Applies browser cookie scoping, so cookies only reach hosts they were set for.
export function cookieHeader(url, cookies) {
  const { hostname, protocol } = new URL(url);
  return cookies
    .filter((c) => (c.domain.startsWith('.') ? hostMatches(hostname, c.domain.slice(1)) : hostname === c.domain))
    .filter((c) => !c.secure || protocol === 'https:')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export function sanitizeName(name, maxLength = 60) {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return [...clean].slice(0, maxLength).join('').trim();
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
