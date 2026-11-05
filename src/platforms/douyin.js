import { hostMatches, uniqueHttpUrls } from './shared.js';

const WATERMARKED_URL = /\/playwm\//;

export const douyin = {
  name: 'Douyin',
  origin: 'https://www.douyin.com',
  postsPath: '/aweme/v1/web/aweme/post/',
  listKey: 'aweme_list',
  hasMoreKey: 'has_more',
  requiresLogin: true,
  sendCookies: false,

  matchUrl(url) {
    const secUid = url.pathname.match(/^\/user\/([\w.-]+)\/?$/)?.[1];
    if (!hostMatches(url.hostname, 'douyin.com') || !secUid) return null;
    return { id: secUid, url: `https://www.douyin.com/user/${secUid}?showTab=post` };
  },

  itemId: (aweme) => aweme.aweme_id,
  belongsTo: (aweme, id) => !aweme.author?.sec_uid || aweme.author.sec_uid === id,

  // download_addr carries the watermark, so it is never used, even as a fallback.
  classify(aweme) {
    if (aweme.images?.length) return { kind: 'photo' };

    const owner = {
      channelKey: aweme.author?.sec_uid ?? '',
      author: aweme.author?.nickname || aweme.author?.sec_uid || '',
    };
    const id = String(aweme.aweme_id);
    const title = aweme.desc ?? '';

    const renditions = (aweme.video?.bit_rate ?? [])
      .filter((r) => r.play_addr?.url_list?.length)
      .sort((a, b) =>
        (b.play_addr.height ?? 0) - (a.play_addr.height ?? 0) ||
        (a.is_h265 ?? 0) - (b.is_h265 ?? 0) ||
        (b.bit_rate ?? 0) - (a.bit_rate ?? 0));

    const urls = uniqueHttpUrls([
      ...(renditions[0]?.play_addr.url_list ?? []),
      ...(aweme.video?.play_addr?.url_list ?? []),
    ]).filter((u) => !WATERMARKED_URL.test(u));
    if (!urls.length) return { kind: 'unplayable', id, title, ...owner };

    return {
      kind: 'video',
      video: { id, title, createTime: aweme.create_time ?? 0, urls, ...owner },
    };
  },
};
