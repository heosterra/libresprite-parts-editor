// PNG と deflate/inflate（parts-editor.js の中の、依存なしの実装）を、Node の zlib と比べて確かめる
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { deflateRawSync, deflateSync, inflateSync } from 'node:zlib';

import { decodePng as refDecode, encodePng as refEncode } from '../lib/png.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function samples() {
  const r = rng(7);
  const list = [new Uint8Array(0), new Uint8Array([0]), new Uint8Array(70000).fill(0)];
  // 乱数（圧縮の効かないもの）・繰り返しの多いもの・ドット絵らしいもの
  const noise = new Uint8Array(20000);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(r() * 256);
  list.push(noise);
  const rep = new Uint8Array(50000);
  for (let i = 0; i < rep.length; i++) rep[i] = 'abcabcabdabc'.charCodeAt(i % 12);
  list.push(rep);
  const pix = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < pix.length; i += 4) if (r() < 0.2) pix.set([200, 100, 50, 255], i);
  list.push(pix);
  return list;
}

test('inflate: zlib の deflate（無圧縮・固定・動的ハフマン）を読める', () => {
  for (const data of samples())
    for (const level of [0, 1, 6, 9]) {
      assert.deepEqual(Buffer.from(core.inflateRaw(deflateRawSync(data, { level }))), Buffer.from(data));
      assert.deepEqual(Buffer.from(core.zlibInflate(deflateSync(data, { level }))), Buffer.from(data));
    }
});

test('deflate: 書いたものを zlib が読める（adler32 も合う）', () => {
  for (const data of samples()) assert.deepEqual(Buffer.from(inflateSync(core.zlibDeflate(data))), Buffer.from(data));
});

test('PNG: 書いた PNG を zlib の読み手で読むと同じ画素', () => {
  const r = rng(3);
  for (const [w, h] of [
    [1, 1],
    [32, 32],
    [128, 128],
    [7, 13],
  ]) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
    const img = { width: w, height: h, data };
    const back = refDecode(Buffer.from(core.encodePng(img)));
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(data));
  }
});

test('PNG: zlib で書いた PNG（フィルタ 0）を読める', () => {
  const r = rng(11);
  const data = new Uint8Array(40 * 30 * 4);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  const img = core.decodePng(new Uint8Array(refEncode({ width: 40, height: 30, data })));
  assert.deepEqual(Buffer.from(img.data), Buffer.from(data));
});

test('PNG: フィルタ 1〜4・RGB・グレー・パレットの PNG を読める', () => {
  // 手で組んだ PNG（フィルタの種類を行ごとに変える）
  const w = 5;
  const h = 5;
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(core.crc32(Buffer.concat([head.subarray(4), body]), 0, 4 + body.length), 0);
    return Buffer.concat([head, body, crc]);
  };
  const build = (colorType, channels, rows, extra = []) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    // フィルタをかける（行 y にはフィルタ y % 5）
    const stride = w * channels;
    const raw = [];
    for (let y = 0; y < h; y++) {
      const f = y % 5;
      raw.push(f);
      for (let i = 0; i < stride; i++) {
        const x = rows[y][i];
        const a = i >= channels ? rows[y][i - channels] : 0;
        const b = y > 0 ? rows[y - 1][i] : 0;
        const c = i >= channels && y > 0 ? rows[y - 1][i - channels] : 0;
        let p = 0;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) {
          const q = a + b - c;
          const pa = Math.abs(q - a);
          const pb = Math.abs(q - b);
          const pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        raw.push((x - p) & 0xff);
      }
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...extra.map(([t, b]) => chunk(t, b)),
      chunk('IDAT', deflateSync(Buffer.from(raw))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  const r = rng(5);
  const rowsOf = (channels) => Array.from({ length: h }, () => Array.from({ length: w * channels }, () => Math.floor(r() * 256)));

  const rgba = rowsOf(4);
  const a = core.decodePng(build(6, 4, rgba));
  assert.deepEqual([...a.data], rgba.flat());

  const rgb = rowsOf(3);
  const b = core.decodePng(build(2, 3, rgb));
  for (let i = 0; i < w * h; i++) assert.deepEqual([...b.data.subarray(i * 4, i * 4 + 4)], [...rgb.flat().slice(i * 3, i * 3 + 3), 255]);

  const gray = rowsOf(1);
  const c = core.decodePng(build(0, 1, gray));
  for (let i = 0; i < w * h; i++) assert.deepEqual([...c.data.subarray(i * 4, i * 4 + 4)], [gray.flat()[i], gray.flat()[i], gray.flat()[i], 255]);

  const idx = Array.from({ length: h }, () => Array.from({ length: w }, () => Math.floor(r() * 3)));
  const plte = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const trns = Buffer.from([0, 128]);
  const d = core.decodePng(build(3, 1, idx, [['PLTE', plte], ['tRNS', trns]]));
  for (let i = 0; i < w * h; i++) {
    const k = idx.flat()[i];
    assert.deepEqual([...d.data.subarray(i * 4, i * 4 + 4)], [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], k < 2 ? trns[k] : 255]);
  }
});
