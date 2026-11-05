import { hostMatches, uniqueHttpUrls } from './shared.js';

const isH265 = (rendition) => (/h265|bytevc1/i.test(rendition.CodecType ?? '') ? 1 : 0);

export const tiktok = {
  name: 'TikTok',
  origin: 'https://www.tiktok.com',
  postsPath: '/api/post/item_list/',
  listKey: 'itemList',
  hasMoreKey: 'hasMore',
  requiresLogin: false,
  // The page's own video requests carry these cookies, so downloads do too.
  sendCookies: true,

  matchUrl(url) {
    const handle = url.pathname.match(/^\/@([\w.-]+)\/?$/)?.[1];
    if (!hostMatches(url.hostname, 'tiktok.com') || !handle) return null;
    return { id: handle.toLowerCase(), url: `https://www.tiktok.com/@${handle}` };
  },

  itemId: (item) => item.id,
  belongsTo: (item, id) => !item.author?.uniqueId || item.author.uniqueId.toLowerCase() === id,

  // downloadAddr carries the watermark, so it is never used, even as a fallback.
  classify(item) {
    if (item.imagePost) return { kind: 'photo' };

    const owner = {
      // secUid survives a handle change, so the channel keeps its folder.
      channelKey: item.author?.secUid || item.author?.uniqueId || '',
      author: item.author?.uniqueId ?? '',
    };
    const id = String(item.id);
    const title = item.desc ?? '';

    const renditions = (item.video?.bitrateInfo ?? [])
      .filter((r) => r.PlayAddr?.UrlList?.length)
      .sort((a, b) =>
        (b.PlayAddr.Height ?? 0) - (a.PlayAddr.Height ?? 0) ||
        isH265(a) - isH265(b) ||
        (b.Bitrate ?? 0) - (a.Bitrate ?? 0));

    const urls = uniqueHttpUrls([
      ...(renditions[0]?.PlayAddr.UrlList ?? []),
      ...(item.video?.playAddr ? [item.video.playAddr] : []),
    ]);
    if (!urls.length) return { kind: 'unplayable', id, title, ...owner };

    return {
      kind: 'video',
      video: { id, title, createTime: Number(item.createTime) || 0, urls, ...owner },
    };
  },
};
