import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cookieHeader } from '../src/downloader.js';
import { idFromFilename, sanitizeName, videoFilename } from '../src/files.js';
import { openFolder } from '../src/host.js';

test('sanitizeName removes path characters and leading dots', () => {
  assert.equal(sanitizeName('../a/b:c\n  d'), 'a b c d');
});

test('sanitizeName is safe as a Windows name', () => {
  assert.equal(sanitizeName('name. . '), 'name');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('com1.txt'), '_com1.txt');
  assert.equal(sanitizeName('console'), 'console');
});

test('long titles stay within the filename byte limit', () => {
  for (const character of ['😀', '视', 'a']) {
    const name = videoFilename({ id: '7300000000000000000', title: character.repeat(300), createTime: 1700000000 });
    assert.ok(Buffer.byteLength(`${name}.part`) <= 255, `${character}: ${Buffer.byteLength(name)} bytes`);
    assert.equal(idFromFilename(name), '7300000000000000000');
  }
});

test('truncation never splits an emoji', () => {
  assert.equal(sanitizeName('😀😀😀', 5), '😀');
});

test('filenames round-trip the video id', () => {
  const name = videoFilename({ id: '7300000000000000000', title: 'a/b #tag', createTime: 1700000000 });
  assert.equal(name, '2023-11-14_7300000000000000000_a b #tag.mp4');
  assert.equal(idFromFilename(name), '7300000000000000000');
  assert.equal(idFromFilename(`${name}.part`), null);
  assert.equal(idFromFilename('.channel.json'), null);
  assert.equal(idFromFilename(videoFilename({ id: '7300000000000000000', title: '', createTime: 0 })), '7300000000000000000');
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

test('openFolder reports failure instead of hiding it', async () => {
  await assert.rejects(openFolder('/definitely/not/a/real/folder', 'darwin'), /Could not open the folder/);
});
