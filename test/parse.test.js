import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieHeader, idFromFilename, parseChannelUrl, parseListResponse, PLATFORMS, sanitizeName, toDouyinVideo, toTikTokVideo, videoFilename } from '../src/parse.js';

test('parseListResponse accepts real pages and rejects refusals', () => {
  const { tiktok, douyin } = PLATFORMS;
  const page = '{"statusCode":0,"status_code":0,"hasMore":false,"itemList":[]}';
  assert.equal(parseListResponse(page, tiktok).hasMore, false);
  assert.equal(parseListResponse('{"status_code":0,"has_more":0}', douyin).has_more, 0);
  assert.equal(parseListResponse('', tiktok), null);
  assert.equal(parseListResponse('<html>blocked</html>', tiktok), null);
  assert.equal(parseListResponse('null', tiktok), null);
  assert.equal(parseListResponse('{"statusCode":10201,"hasMore":false}', tiktok), null);
  assert.equal(parseListResponse('{"status_code":8}', douyin), null);
  assert.equal(parseListResponse('{"statusCode":0}', tiktok), null);
});

test('parseChannelUrl normalizes a pasted channel link', () => {
  const channel = parseChannelUrl('look: https://www.douyin.com/user/MS4w_a-b?from_tab_name=main&showTab=post ');
  assert.equal(channel.platform.name, 'Douyin');
  assert.equal(channel.id, 'MS4w_a-b');
  assert.equal(channel.url, 'https://www.douyin.com/user/MS4w_a-b?showTab=post');
});

test('parseChannelUrl rejects other sites and pages', () => {
  assert.throws(() => parseChannelUrl('https://evil.example/user/abc'));
  assert.throws(() => parseChannelUrl('https://douyin.com.evil.example/user/abc'));
  assert.throws(() => parseChannelUrl('https://www.douyin.com/video/123'));
  assert.throws(() => parseChannelUrl('https://tiktok.com.evil.example/@abc'));
  assert.throws(() => parseChannelUrl('https://www.tiktok.com/@abc/video/123'));
  assert.throws(() => parseChannelUrl('not a url'));
});

test('toVideo picks the highest resolution, preferring h264 at equal height', () => {
  const video = toDouyinVideo({
    aweme_id: '123',
    desc: 'hello',
    create_time: 1700000000,
    author: { nickname: 'n', sec_uid: 's' },
    video: {
      download_addr: { url_list: ['https://cdn/watermarked'] },
      play_addr: { url_list: ['https://cdn/default'] },
      bit_rate: [
        { bit_rate: 500, is_h265: 0, play_addr: { height: 720, url_list: ['https://cdn/720'] } },
        { bit_rate: 900, is_h265: 1, play_addr: { height: 1080, url_list: ['https://cdn/1080h265'] } },
        { bit_rate: 800, is_h265: 0, play_addr: { height: 1080, url_list: ['https://cdn/1080h264'] } },
      ],
    },
  });
  assert.deepEqual(video.urls, ['https://cdn/1080h264', 'https://cdn/default']);
});

test('toVideo returns null for photo posts and posts without URLs', () => {
  assert.equal(toDouyinVideo({ aweme_id: '1', images: [{}], video: { play_addr: { url_list: ['https://x'] } } }), null);
  assert.equal(toDouyinVideo({ aweme_id: '1', video: {} }), null);
});

test('sanitizeName removes path characters and leading dots', () => {
  assert.equal(sanitizeName('../a/b:c\n  d'), 'a b c d');
  assert.equal([...sanitizeName('视'.repeat(100))].length, 60);
});

test('filenames round-trip the video id', () => {
  const name = videoFilename({ id: '7300000000000000000', title: 'a/b #tag', createTime: 1700000000 });
  assert.equal(name, '2023-11-14_7300000000000000000_a b #tag.mp4');
  assert.equal(idFromFilename(name), '7300000000000000000');
  assert.equal(idFromFilename(`${name}.part`), null);
  assert.equal(idFromFilename(videoFilename({ id: '7300000000000000000', title: '', createTime: 0 })), '7300000000000000000');
});

test('parseChannelUrl accepts a TikTok channel', () => {
  const channel = parseChannelUrl('https://www.tiktok.com/@CuteAnimal.Penguin?lang=en');
  assert.equal(channel.platform.name, 'TikTok');
  assert.equal(channel.id, 'cuteanimal.penguin');
  assert.equal(channel.url, 'https://www.tiktok.com/@CuteAnimal.Penguin');
});

test('toTikTokVideo never uses the watermarked downloadAddr', () => {
  const video = toTikTokVideo({
    id: '74',
    desc: 'penguin',
    createTime: '1700000000',
    author: { uniqueId: 'p' },
    video: {
      downloadAddr: 'https://cdn/watermarked',
      playAddr: 'https://cdn/play',
      bitrateInfo: [
        { Bitrate: 900, CodecType: 'h264', PlayAddr: { Height: 1280, UrlList: ['https://cdn/720'] } },
        { Bitrate: 800, CodecType: 'h265_hvc1', PlayAddr: { Height: 1920, UrlList: ['https://cdn/1080h265'] } },
        { Bitrate: 950, CodecType: 'h264', PlayAddr: { Height: 1920, UrlList: ['https://cdn/1080h264'] } },
      ],
    },
  });
  assert.deepEqual(video.urls, ['https://cdn/1080h264', 'https://cdn/play']);
  assert.equal(toTikTokVideo({ id: '1', video: { downloadAddr: 'https://cdn/watermarked' } }), null);
  assert.equal(toTikTokVideo({ id: '1', imagePost: {}, video: { playAddr: 'https://cdn/play' } }), null);
});

test('cookieHeader only sends cookies to hosts they are scoped to', () => {
  const cookies = [
    { name: 'shared', value: '1', domain: '.tiktok.com', secure: true },
    { name: 'site', value: '2', domain: 'www.tiktok.com', secure: true },
  ];
  assert.equal(cookieHeader('https://v16-webapp-prime.tiktok.com/v', cookies), 'shared=1');
  assert.equal(cookieHeader('https://www.tiktok.com/v', cookies), 'shared=1; site=2');
  assert.equal(cookieHeader('https://nottiktok.com/v', cookies), '');
  assert.equal(cookieHeader('http://cdn.tiktok.com/v', cookies), '');
});
