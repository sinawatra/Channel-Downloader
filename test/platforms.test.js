import assert from 'node:assert/strict';
import { test } from 'node:test';
import { douyin } from '../src/platforms/douyin.js';
import { parseChannelUrl, parseListResponse } from '../src/platforms/index.js';
import { tiktok } from '../src/platforms/tiktok.js';

test('parseChannelUrl normalizes a pasted Douyin link', () => {
  const channel = parseChannelUrl('look: https://www.douyin.com/user/MS4w_a-b?from_tab_name=main&showTab=post ');
  assert.equal(channel.platform.name, 'Douyin');
  assert.equal(channel.id, 'MS4w_a-b');
  assert.equal(channel.url, 'https://www.douyin.com/user/MS4w_a-b?showTab=post');
});

test('parseChannelUrl accepts a TikTok channel', () => {
  const channel = parseChannelUrl('https://www.tiktok.com/@CuteAnimal.Penguin?lang=en');
  assert.equal(channel.platform.name, 'TikTok');
  assert.equal(channel.id, 'cuteanimal.penguin');
  assert.equal(channel.url, 'https://www.tiktok.com/@CuteAnimal.Penguin');
});

test('parseChannelUrl rejects other sites and pages', () => {
  assert.throws(() => parseChannelUrl('https://evil.example/user/abc'));
  assert.throws(() => parseChannelUrl('https://douyin.com.evil.example/user/abc'));
  assert.throws(() => parseChannelUrl('https://www.douyin.com/video/123'));
  assert.throws(() => parseChannelUrl('https://tiktok.com.evil.example/@abc'));
  assert.throws(() => parseChannelUrl('https://www.tiktok.com/@abc/video/123'));
  assert.throws(() => parseChannelUrl('not a url'));
});

test('parseListResponse accepts real pages and rejects refusals', () => {
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

test('Douyin picks the highest resolution, preferring h264 at equal height', () => {
  const post = douyin.classify({
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
  assert.equal(post.kind, 'video');
  assert.deepEqual(post.video.urls, ['https://cdn/1080h264', 'https://cdn/default']);
  assert.equal(post.video.channelKey, 's');
});

test('Douyin rejects watermarked playwm links even in the play address', () => {
  const clean = douyin.classify({
    aweme_id: '1',
    video: { play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?id=1', 'https://cdn/clean'] } },
  });
  assert.deepEqual(clean.video.urls, ['https://cdn/clean']);

  const onlyWatermarked = douyin.classify({
    aweme_id: '2',
    desc: 't',
    video: { play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?id=2'] } },
  });
  assert.equal(onlyWatermarked.kind, 'unplayable');
  assert.equal(onlyWatermarked.id, '2');
});

test('Douyin separates photo posts from unplayable videos', () => {
  assert.equal(douyin.classify({ aweme_id: '1', images: [{}], video: {} }).kind, 'photo');
  assert.equal(douyin.classify({ aweme_id: '1', video: {} }).kind, 'unplayable');
  assert.equal(douyin.classify({ aweme_id: '1' }).kind, 'unplayable');
});

test('TikTok never uses the watermarked downloadAddr', () => {
  const post = tiktok.classify({
    id: '74',
    desc: 'penguin',
    createTime: '1700000000',
    author: { uniqueId: 'p', secUid: 'stable' },
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
  assert.deepEqual(post.video.urls, ['https://cdn/1080h264', 'https://cdn/play']);
  assert.equal(post.video.channelKey, 'stable');
  assert.equal(post.video.author, 'p');
});

test('TikTok separates photo posts from unplayable videos', () => {
  assert.equal(tiktok.classify({ id: '1', imagePost: {}, video: { playAddr: 'https://cdn/play' } }).kind, 'photo');
  assert.equal(tiktok.classify({ id: '1', video: { downloadAddr: 'https://cdn/watermarked' } }).kind, 'unplayable');
});
