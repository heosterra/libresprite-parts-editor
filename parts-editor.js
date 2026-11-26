///permission fs.read
///permission fs.write
// parts-editor.js — heosterra の部位のフォルダ（〇〇-parts）を、部位ごとのレイヤーに分けて
// LibreSprite で直し、部位ごとの PNG へ書き戻すスクリプト。
// https://github.com/heosterra/libresprite-parts-editor （MIT License）
//
// - LibreSprite の fs の口（2026-10 に master へ入った。1.3 には無い）があれば、読み込み・書き戻しを
//   LibreSprite の中だけで行う。
// - fs の口が無い版（1.3 など）では、読み込み・書き戻しは補助の CLI（cli/parts-ase.mjs）で行い、
//   この窓はガイドなどの表示の切り替えだけを受け持つ。
// - このファイルは Node からも require でき（module.exports）、試験はそれで中身の計算を確かめる。

var PartsCore = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 決め（README の「決めたこと」と揃える）
  // ---------------------------------------------------------------------------
  var LAYER = {
    hiddenSuffix: '.hidden', // 前の形（v0.1）の隠れた所のレイヤー: <部位>.hidden。読むときに部位のレイヤーへ寄せる
    guidePrefix: 'guide:', // ガイドのレイヤー: guide:<部位>
    map: 'map', // map.png のレイヤー
    jointPrefix: 'joint:', // 絵の上の関節（joints-drawn.json）のレイヤー: joint:<関節>
  };
  var DRAWN_FILE = 'joints-drawn.json'; // 絵の上の関節の位置（heosterra の animate が使う）
  var DRAWN_RING_ALPHA = 110; // 関節の点の上下左右の、見つけやすくするための薄い印の不透明度（書き戻しでは読まない）
  var GUIDE_ALPHA = 170; // ガイドの線の不透明度（下の絵が透けて見えるように）
  var JOINT_ALPHA = 255; // 関節の点の不透明度

  /** 部位の見分けの色（heosterra の model-parts.ts の PART_COLORS と同じ）。map.png から読めない部位に使う */
  var PART_COLORS = {
    torso: [255, 140, 180],
    head: [240, 200, 80],
    'upper-arm-l': [220, 60, 60],
    'forearm-l': [240, 130, 60],
    'hand-l': [250, 220, 40],
    'upper-arm-r': [60, 90, 220],
    'forearm-r': [60, 170, 230],
    'hand-r': [60, 220, 200],
    'thigh-l': [200, 80, 200],
    'shin-l': [160, 60, 160],
    'foot-l': [120, 40, 120],
    'thigh-r': [80, 200, 80],
    'shin-r': [40, 140, 40],
    'foot-r': [20, 90, 20],
  };

  // ---------------------------------------------------------------------------
  // CRC32 / Adler32
  // ---------------------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    var c = 0xffffffff;
    for (var i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function adler32(bytes) {
    var a = 1;
    var b = 0;
    for (var i = 0; i < bytes.length; ) {
      var n = Math.min(5552, bytes.length - i);
      for (var k = 0; k < n; k++, i++) {
        a += bytes[i];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  // ---------------------------------------------------------------------------
  // inflate（RFC 1951。PNG を読むのに使う）
  // ---------------------------------------------------------------------------
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  /** 符号の長さの並びから、読むための表（長さごとの数と、符号の順の記号）を作る */
  function buildHuffman(lengths) {
    var counts = new Uint16Array(16);
    for (var i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;
    var offs = new Uint16Array(16);
    for (var l = 1; l < 16; l++) offs[l] = offs[l - 1] + counts[l - 1];
    var symbols = new Uint16Array(lengths.length);
    for (var s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offs[lengths[s]]++] = s;
    return { counts: counts, symbols: symbols };
  }

  var FIXED_LIT = (function () {
    var l = new Uint8Array(288);
    for (var i = 0; i < 144; i++) l[i] = 8;
    for (i = 144; i < 256; i++) l[i] = 9;
    for (i = 256; i < 280; i++) l[i] = 7;
    for (i = 280; i < 288; i++) l[i] = 8;
    return buildHuffman(l);
  })();
  var FIXED_DIST = (function () {
    var l = new Uint8Array(30);
    for (var i = 0; i < 30; i++) l[i] = 5;
    return buildHuffman(l);
  })();

  function inflateRaw(src) {
    var pos = 0;
    var bitBuf = 0;
    var bitCnt = 0;
    var out = new Uint8Array(Math.max(1024, src.length * 4));
    var outLen = 0;

    function need(n) {
      if (outLen + n <= out.length) return;
      var size = out.length * 2;
      while (size < outLen + n) size *= 2;
      var next = new Uint8Array(size);
      next.set(out.subarray(0, outLen));
      out = next;
    }
    function bits(n) {
      while (bitCnt < n) {
        if (pos >= src.length) throw new Error('inflate: unexpected end of data');
        bitBuf |= src[pos++] << bitCnt;
        bitCnt += 8;
      }
      var v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return v;
    }
    function decode(h) {
      var code = 0;
      var first = 0;
      var index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1);
        var count = h.counts[len];
        if (code - count < first) return h.symbols[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
      }
      throw new Error('inflate: invalid code');
    }

    var last = 0;
    while (!last) {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0;
        bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('inflate: unexpected end of data');
        var len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        if (pos + len > src.length) throw new Error('inflate: unexpected end of data');
        need(len);
        out.set(src.subarray(pos, pos + len), outLen);
        outLen += len;
        pos += len;
        continue;
      }
      var lit;
      var dist;
      if (type === 1) {
        lit = FIXED_LIT;
        dist = FIXED_DIST;
      } else if (type === 2) {
        var hlit = bits(5) + 257;
        var hdist = bits(5) + 1;
        var hclen = bits(4) + 4;
        var cl = new Uint8Array(19);
        for (var i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
        var clh = buildHuffman(cl);
        var lens = new Uint8Array(hlit + hdist);
        for (i = 0; i < hlit + hdist; ) {
          var sym = decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            var rep = 0;
            var val = 0;
            if (sym === 16) {
              if (i === 0) throw new Error('inflate: invalid code lengths');
              val = lens[i - 1];
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep--) lens[i++] = val;
          }
        }
        lit = buildHuffman(lens.subarray(0, hlit));
        dist = buildHuffman(lens.subarray(hlit));
      } else throw new Error('inflate: invalid block type');

      for (;;) {
        var s = decode(lit);
        if (s < 256) {
          need(1);
          out[outLen++] = s;
        } else if (s === 256) break;
        else {
          s -= 257;
          if (s >= 29) throw new Error('inflate: invalid length code');
          var length = LEN_BASE[s] + bits(LEN_EXTRA[s]);
          var ds = decode(dist);
          if (ds >= 30) throw new Error('inflate: invalid distance code');
          var d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
          if (d > outLen) throw new Error('inflate: distance too far back');
          need(length);
          for (var k = 0; k < length; k++, outLen++) out[outLen] = out[outLen - d];
        }
      }
    }
    return out.subarray(0, outLen);
  }

  function zlibInflate(src) {
    if (src.length < 6 || (src[0] & 0x0f) !== 8 || ((src[0] << 8) | src[1]) % 31 !== 0)
      throw new Error('zlib: invalid header');
    if (src[1] & 0x20) throw new Error('zlib: preset dictionary is not supported');
    return inflateRaw(src.subarray(2));
  }

  // ---------------------------------------------------------------------------
  // deflate（固定ハフマン + LZ77。PNG を書くのに使う）
  // ---------------------------------------------------------------------------
  function BitWriter() {
    this.buf = new Uint8Array(1024);
    this.len = 0;
    this.acc = 0;
    this.cnt = 0;
  }
  BitWriter.prototype.byte = function (b) {
    if (this.len >= this.buf.length) {
      var next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  };
  /** 下位ビットから順に n ビット書く */
  BitWriter.prototype.bits = function (v, n) {
    this.acc |= v << this.cnt;
    this.cnt += n;
    while (this.cnt >= 8) {
      this.byte(this.acc & 0xff);
      this.acc >>>= 8;
      this.cnt -= 8;
    }
  };
  /** ハフマンの符号（上位ビットから）を n ビット書く */
  BitWriter.prototype.code = function (c, n) {
    var r = 0;
    for (var i = 0; i < n; i++) r |= ((c >>> i) & 1) << (n - 1 - i);
    this.bits(r, n);
  };
  BitWriter.prototype.finish = function () {
    if (this.cnt > 0) this.byte(this.acc & 0xff);
    this.acc = 0;
    this.cnt = 0;
    return this.buf.subarray(0, this.len);
  };

  function writeFixedLit(w, s) {
    if (s < 144) w.code(0x30 + s, 8);
    else if (s < 256) w.code(0x190 + (s - 144), 9);
    else if (s < 280) w.code(s - 256, 7);
    else w.code(0xc0 + (s - 280), 8);
  }

  function writeLength(w, len) {
    var i = 28;
    while (LEN_BASE[i] > len) i--;
    writeFixedLit(w, 257 + i);
    if (LEN_EXTRA[i]) w.bits(len - LEN_BASE[i], LEN_EXTRA[i]);
  }

  function writeDistance(w, d) {
    var i = 29;
    while (DIST_BASE[i] > d) i--;
    w.code(i, 5);
    if (DIST_EXTRA[i]) w.bits(d - DIST_BASE[i], DIST_EXTRA[i]);
  }

  function deflateRaw(data) {
    var w = new BitWriter();
    w.bits(1, 1); // 最後のブロック
    w.bits(1, 2); // 固定ハフマン
    var WINDOW = 32768;
    var HASH = 1 << 15;
    var head = new Int32Array(HASH).fill(-1);
    var prev = new Int32Array(data.length).fill(-1);
    var hash = function (i) {
      return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
    };
    var insert = function (i) {
      if (i + 2 >= data.length) return;
      var h = hash(i);
      prev[i] = head[h];
      head[h] = i;
    };
    var i = 0;
    while (i < data.length) {
      var bestLen = 0;
      var bestDist = 0;
      if (i + 2 < data.length) {
        var cand = head[hash(i)];
        var chain = 128;
        var max = Math.min(258, data.length - i);
        while (cand >= 0 && i - cand <= WINDOW && chain-- > 0) {
          var l = 0;
          while (l < max && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === max) break;
          }
          cand = prev[cand];
        }
      }
      if (bestLen >= 3) {
        writeLength(w, bestLen);
        writeDistance(w, bestDist);
        for (var k = 0; k < bestLen; k++) insert(i + k);
        i += bestLen;
      } else {
        writeFixedLit(w, data[i]);
        insert(i);
        i++;
      }
    }
    writeFixedLit(w, 256);
    return w.finish();
  }

  function zlibDeflate(data) {
    var body = deflateRaw(data);
    var out = new Uint8Array(body.length + 6);
    out[0] = 0x78;
    out[1] = 0x01; // (0x78 << 8 | 0x01) % 31 === 0
    out.set(body, 2);
    var a = adler32(data);
    out[out.length - 4] = (a >>> 24) & 0xff;
    out[out.length - 3] = (a >>> 16) & 0xff;
    out[out.length - 2] = (a >>> 8) & 0xff;
    out[out.length - 1] = a & 0xff;
    return out;
  }

  // ---------------------------------------------------------------------------
  // PNG
  // ---------------------------------------------------------------------------
  var PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function u32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function chunkType(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }
  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a);
    var pb = Math.abs(p - b);
    var pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  /** PNG（8bit の RGBA/RGB/グレー/グレー+α/パレット）を読み、{width, height, data: RGBA} を返す */
  function decodePng(bytes) {
    for (var s = 0; s < 8; s++) if (bytes[s] !== PNG_SIG[s]) throw new Error('not a PNG file');
    var pos = 8;
    var width = 0;
    var height = 0;
    var depth = 0;
    var colorType = 0;
    var interlace = 0;
    var palette = null;
    var trns = null;
    var parts = [];
    var total = 0;
    while (pos + 8 <= bytes.length) {
      var len = u32(bytes, pos);
      var type = chunkType(bytes, pos + 4);
      var body = bytes.subarray(pos + 8, pos + 8 + len);
      pos += 12 + len;
      if (type === 'IHDR') {
        width = u32(body, 0);
        height = u32(body, 4);
        depth = body[8];
        colorType = body[9];
        interlace = body[12];
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') {
        parts.push(body);
        total += body.length;
      } else if (type === 'IEND') break;
    }
    if (depth !== 8) throw new Error('only 8-bit PNG is supported (got ' + depth + '-bit)');
    if (interlace) throw new Error('interlaced PNG is not supported');
    var channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error('unknown PNG color type ' + colorType);
    var z = new Uint8Array(total);
    for (var p = 0, off = 0; p < parts.length; p++) {
      z.set(parts[p], off);
      off += parts[p].length;
    }
    var raw = zlibInflate(z);
    var stride = width * channels;
    if (raw.length < (stride + 1) * height) throw new Error('PNG: not enough pixel data');
    var px = new Uint8Array(stride * height);
    for (var y = 0; y < height; y++) {
      var f = raw[y * (stride + 1)];
      var lo = y * (stride + 1) + 1;
      var row = y * stride;
      for (var i = 0; i < stride; i++) {
        var a = i >= channels ? px[row + i - channels] : 0;
        var b = y > 0 ? px[row - stride + i] : 0;
        var c = i >= channels && y > 0 ? px[row - stride + i - channels] : 0;
        var v = raw[lo + i];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) v += paeth(a, b, c);
        else if (f !== 0) throw new Error('PNG: invalid filter');
        px[row + i] = v & 0xff;
      }
    }
    var data = new Uint8Array(width * height * 4);
    for (var k = 0; k < width * height; k++) {
      var o = k * 4;
      if (colorType === 6) {
        data[o] = px[o];
        data[o + 1] = px[o + 1];
        data[o + 2] = px[o + 2];
        data[o + 3] = px[o + 3];
      } else if (colorType === 2) {
        data[o] = px[k * 3];
        data[o + 1] = px[k * 3 + 1];
        data[o + 2] = px[k * 3 + 2];
        var key =
          trns &&
          trns.length >= 6 &&
          ((trns[0] << 8) | trns[1]) === data[o] &&
          ((trns[2] << 8) | trns[3]) === data[o + 1] &&
          ((trns[4] << 8) | trns[5]) === data[o + 2];
        data[o + 3] = key ? 0 : 255;
      } else if (colorType === 0) {
        data[o] = data[o + 1] = data[o + 2] = px[k];
        data[o + 3] = trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === px[k] ? 0 : 255;
      } else if (colorType === 4) {
        data[o] = data[o + 1] = data[o + 2] = px[k * 2];
        data[o + 3] = px[k * 2 + 1];
      } else {
        var idx = px[k];
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error('PNG: palette too short');
        data[o] = palette[idx * 3];
        data[o + 1] = palette[idx * 3 + 1];
        data[o + 2] = palette[idx * 3 + 2];
        data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    return { width: width, height: height, data: data };
  }

  function pushChunk(list, type, body) {
    var c = new Uint8Array(12 + body.length);
    var n = body.length;
    c[0] = (n >>> 24) & 0xff;
    c[1] = (n >>> 16) & 0xff;
    c[2] = (n >>> 8) & 0xff;
    c[3] = n & 0xff;
    for (var i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(body, 8);
    var crc = crc32(c, 4, 8 + n);
    c[8 + n] = (crc >>> 24) & 0xff;
    c[9 + n] = (crc >>> 16) & 0xff;
    c[10 + n] = (crc >>> 8) & 0xff;
    c[11 + n] = crc & 0xff;
    list.push(c);
  }

  /** RGBA の画素を PNG（RGBA 8bit・フィルタなし）にする */
  function encodePng(img) {
    var w = img.width;
    var h = img.height;
    var ihdr = new Uint8Array(13);
    ihdr[0] = (w >>> 24) & 0xff;
    ihdr[1] = (w >>> 16) & 0xff;
    ihdr[2] = (w >>> 8) & 0xff;
    ihdr[3] = w & 0xff;
    ihdr[4] = (h >>> 24) & 0xff;
    ihdr[5] = (h >>> 16) & 0xff;
    ihdr[6] = (h >>> 8) & 0xff;
    ihdr[7] = h & 0xff;
    ihdr[8] = 8;
    ihdr[9] = 6;
    var stride = w * 4;
    var raw = new Uint8Array((stride + 1) * h);
    for (var y = 0; y < h; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    var list = [new Uint8Array(PNG_SIG)];
    pushChunk(list, 'IHDR', ihdr);
    pushChunk(list, 'IDAT', zlibDeflate(raw));
    pushChunk(list, 'IEND', new Uint8Array(0));
    var size = 0;
    for (var i = 0; i < list.length; i++) size += list[i].length;
    var out = new Uint8Array(size);
    for (i = 0, size = 0; i < list.length; i++) {
      out.set(list[i], size);
      size += list[i].length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // 部位のフォルダ
  // ---------------------------------------------------------------------------

  /** 透明な画素は色を問わず同じとみなして、2 枚の RGBA が同じか */
  function samePixels(a, b) {
    if (a.width !== b.width || a.height !== b.height) return false;
    var n = a.width * a.height;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      var aa = a.data[o + 3];
      if (aa !== b.data[o + 3]) return false;
      if (aa === 0) continue;
      if (a.data[o] !== b.data[o] || a.data[o + 1] !== b.data[o + 1] || a.data[o + 2] !== b.data[o + 2]) return false;
    }
    return true;
  }

  /** 違う画素の数（透明は色を問わない） */
  function countDiff(a, b) {
    var n = a.width * a.height;
    var diff = 0;
    for (var i = 0; i < n; i++) {
      var o = i * 4;
      if (a.data[o + 3] !== b.data[o + 3]) diff++;
      else if (a.data[o + 3] && (a.data[o] !== b.data[o] || a.data[o + 1] !== b.data[o + 1] || a.data[o + 2] !== b.data[o + 2])) diff++;
    }
    return diff;
  }

  /** 透明な画素の色を 0 に揃える（書き出す前に） */
  function normalize(img) {
    var d = img.data;
    for (var i = 0; i < d.length; i += 4)
      if (d[i + 3] === 0) {
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
      }
    return img;
  }

  function blank(w, h) {
    return { width: w, height: h, data: new Uint8Array(w * h * 4) };
  }

  /** parts.json の中身を確かめ、部位の並び（奥 → 手前）などを返す */
  function readPartsJson(text) {
    var json = JSON.parse(text);
    if (!json || !Array.isArray(json.parts)) throw new Error('json has no "parts" array');
    var names = json.parts.map(function (p) {
      if (!p || typeof p.name !== 'string' || !p.name) throw new Error('json "parts" has an entry without a name');
      return p.name;
    });
    var order = Array.isArray(json.order) ? json.order.slice() : names.slice();
    // order に無い部位は、parts の順で最後（手前）に足す。order にだけある名前は使わない
    order = order.filter(function (n) {
      return names.indexOf(n) >= 0;
    });
    names.forEach(function (n) {
      if (order.indexOf(n) < 0) order.push(n);
    });
    var seen = {};
    order.forEach(function (n) {
      if (seen[n]) throw new Error('json "order" lists a part twice: ' + n);
      seen[n] = true;
    });
    return { json: json, order: order, grid: json.grid || 0 };
  }

  /** map.png から部位の色を読む（その部位の見えている所でいちばん多い色）。読めなければ PART_COLORS、それも無ければ決まった色 */
  function partColors(order, own, map, preferKnown) {
    var colors = {};
    order.forEach(function (name, k) {
      var img = own[name];
      // 1 枚の形では部位の絵が隠れた所も含むので、map の色の多数決は他の部位の色になりうる
      // （見えている所の無い部位は、多数決だと手前の部位の色を取ってしまう）。名前の分かる部位は PART_COLORS を使う
      // （heosterra の labelsFromMap と同じ: map の色をいちばん近い PART_COLORS の部位にする）
      if (preferKnown && PART_COLORS[name]) {
        colors[name] = PART_COLORS[name].slice();
        return;
      }
      var count = {};
      var best = null;
      var bestN = 0;
      if (img && map && map.width === img.width && map.height === img.height) {
        for (var i = 0; i < img.width * img.height; i++) {
          if (!img.data[i * 4 + 3] || !map.data[i * 4 + 3]) continue;
          var key = map.data[i * 4] + ',' + map.data[i * 4 + 1] + ',' + map.data[i * 4 + 2];
          count[key] = (count[key] || 0) + 1;
          if (count[key] > bestN) {
            bestN = count[key];
            best = key;
          }
        }
      }
      if (best) colors[name] = best.split(',').map(Number);
      else if (PART_COLORS[name]) colors[name] = PART_COLORS[name].slice();
      else {
        // 色相を部位ごとにずらした色
        var hue = (k * 137.5) % 360;
        colors[name] = hsvToRgb(hue, 0.7, 0.9);
      }
    });
    return colors;
  }

  function hsvToRgb(h, s, v) {
    var c = v * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = v - c;
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 60) (r = c), (g = x);
    else if (h < 120) (r = x), (g = c);
    else if (h < 180) (g = c), (b = x);
    else if (h < 240) (g = x), (b = c);
    else if (h < 300) (r = x), (b = c);
    else (r = c), (b = x);
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  /**
   * 部位のガイド: 見えている所と隠れた所を合わせた形の、1 画素外側の輪を、部位の色で引く。
   * ガイドは部位のレイヤーの下に置くので、形の内側の縁に引くと部位の画素に全部隠れてしまう。
   * 外側の輪なら、部位の外（何も描いていない所）や、直して部位の画素を消した所で見える。
   * 輪の画素が見えている所に接していれば線、隠れた所（他の部位の下）にだけ接していれば 1 つおきの点。
   * 関節（json の root・tip）は不透明な 1 画素の点（部位の内側なので、部位のレイヤーを隠すと見える）。
   */
  function guideImage(own, hidden, color, joints, part) {
    var w = own.width;
    var h = own.height;
    var out = blank(w, h);
    var inShape = function (x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      var i = (y * w + x) * 4 + 3;
      return own.data[i] > 0 || (hidden && hidden.data[i] > 0);
    };
    var isOwn = function (x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return own.data[(y * w + x) * 4 + 3] > 0;
    };
    for (var y = 0; y < h; y++)
      for (var x = 0; x < w; x++) {
        if (inShape(x, y)) continue;
        if (!inShape(x - 1, y) && !inShape(x + 1, y) && !inShape(x, y - 1) && !inShape(x, y + 1)) continue;
        var i = (y * w + x) * 4;
        var visible = isOwn(x - 1, y) || isOwn(x + 1, y) || isOwn(x, y - 1) || isOwn(x, y + 1);
        if (!visible && (x + y) % 2) continue;
        out.data[i] = color[0];
        out.data[i + 1] = color[1];
        out.data[i + 2] = color[2];
        out.data[i + 3] = GUIDE_ALPHA;
      }
    if (joints && part) {
      [part.root, part.tip].forEach(function (jn) {
        var j = jn && joints[jn];
        if (!j || typeof j.x !== 'number' || typeof j.y !== 'number') return;
        var jx = Math.floor(j.x);
        var jy = Math.floor(j.y);
        if (jx < 0 || jy < 0 || jx >= w || jy >= h) return;
        var o = (jy * w + jx) * 4;
        out.data[o] = color[0];
        out.data[o + 1] = color[1];
        out.data[o + 2] = color[2];
        out.data[o + 3] = JOINT_ALPHA;
      });
    }
    return out;
  }

  /**
   * 関節の点の位置（joints-drawn.json の値を画素へ）。heosterra の座標は画素 i が i〜i+1 の範囲（真ん中が i + 0.5。
   * transformPart が x + 0.5 で引く）なので、関節の入っている画素は切り捨てで決まる。
   * 四捨五入にすると、左右対称の関節（例: 73.36 と 54.64）が片側だけ 1 画素ずれて見える
   */
  function drawnPixel(j) {
    return [Math.floor(j.x), Math.floor(j.y)];
  }

  /**
   * 絵の上の関節 1 つのレイヤーの絵: 関節の入っている画素に不透明な 1 画素、その上下左右に薄い印（DRAWN_RING_ALPHA）。
   * 書き戻しは不透明な画素だけを関節として読む
   */
  function jointImage(w, h, j, color) {
    var out = blank(w, h);
    var p = drawnPixel(j);
    var put = function (x, y, a) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      var o = (y * w + x) * 4;
      out.data[o] = color[0];
      out.data[o + 1] = color[1];
      out.data[o + 2] = color[2];
      out.data[o + 3] = a;
    };
    put(p[0] - 1, p[1], DRAWN_RING_ALPHA);
    put(p[0] + 1, p[1], DRAWN_RING_ALPHA);
    put(p[0], p[1] - 1, DRAWN_RING_ALPHA);
    put(p[0], p[1] + 1, DRAWN_RING_ALPHA);
    put(p[0], p[1], JOINT_ALPHA);
    return out;
  }

  /** joints-drawn.json の中身を確かめる（{ <関節>: { x, y } }） */
  function readDrawnJson(text) {
    var json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(DRAWN_FILE + ' is not an object');
    Object.keys(json).forEach(function (k) {
      var j = json[k];
      if (!j || typeof j.x !== 'number' || typeof j.y !== 'number') throw new Error(DRAWN_FILE + ' has a joint without x/y: ' + k);
    });
    return json;
  }

  /**
   * 読み込んだ部位から、レイヤーの並び（下 = 奥から上 = 手前）を作る。
   * 並び: map → guide:<部位>（order の順）→ <部位>（order の順、奥 → 手前）→ joint:<関節>（joints-drawn.json があるとき。その並びの順）。
   * ガイドと map は部位の画素の下に置き、部位の絵に被らないようにする。関節は動かすので、部位の絵の上に置く。
   * 返す各要素: { name, image, visible, editable, kind: 'part'|'map'|'guide'|'joint', part }
   */
  function buildLayers(info, files) {
    var order = info.order;
    var w = info.width;
    var h = info.height;
    var one = info.format === 'one';
    var own = files.own;
    var hidden = files.hidden;
    var colors = partColors(order, own, files.map, one);
    if (one) {
      // 1 枚の形: <部位>.png を、map.png で見えている所と、それ以外（隠れた所の描き足し）に分けてガイドに使う
      var vis = splitByMap(order, own, files.map, colors, w, h);
      own = vis.visible;
      hidden = vis.rest;
    }
    var partByName = {};
    (info.json.parts || []).forEach(function (p) {
      partByName[p.name] = p;
    });
    var layers = [];
    layers.push({ name: LAYER.map, kind: 'map', part: null, image: files.map ? copyImage(files.map) : blank(w, h), visible: false, editable: false });
    order.forEach(function (name) {
      layers.push({
        name: LAYER.guidePrefix + name,
        kind: 'guide',
        part: name,
        image: guideImage(own[name] || blank(w, h), hidden[name], colors[name], info.json.joints, partByName[name]),
        visible: true,
        editable: false,
      });
    });
    order.forEach(function (name) {
      // 部位ごとに 1 枚: 隠れた所の上に見えている所を重ねる（見えている所が優先）。1 枚の形では <部位>.png をそのまま。
      // 画素は新しく作る（直したときに、読み込んだ元の画素が変わらないように）
      var image = one ? (files.own[name] ? copyImage(files.own[name]) : blank(w, h)) : composePart(own[name], hidden[name], w, h);
      layers.push({ name: name, kind: 'part', part: name, image: image, visible: true, editable: true });
    });
    if (info.drawn) {
      // 関節の色は、その関節を root に持つ部位の色（無ければ白）
      var rootColor = {};
      (info.json.parts || []).forEach(function (p) {
        if (p.root && colors[p.name] && !rootColor[p.root]) rootColor[p.root] = colors[p.name];
      });
      Object.keys(info.drawn).forEach(function (jn) {
        layers.push({
          name: LAYER.jointPrefix + jn,
          kind: 'joint',
          part: null,
          image: jointImage(w, h, info.drawn[jn], rootColor[jn] || [255, 255, 255]),
          visible: true,
          editable: true,
        });
      });
    }
    return { layers: layers, colors: colors };
  }

  /**
   * map.png から、画素ごとの部位（見えている所の印）を読む。色はいちばん近い部位の色（heosterra の labelsFromMap と同じ考え方）。
   * 返す: 画素ごとの部位の名前の配列（map の透明な画素は null）
   */
  function mapLabels(order, colors, map, w, h) {
    var out = new Array(w * h);
    for (var i = 0; i < w * h; i++) {
      out[i] = null;
      if (!map || !map.data[i * 4 + 3]) continue;
      var best = null;
      var bestD = Infinity;
      for (var k = 0; k < order.length; k++) {
        var c = colors[order[k]];
        var d = 0;
        for (var ch = 0; ch < 3; ch++) d += (c[ch] - map.data[i * 4 + ch]) * (c[ch] - map.data[i * 4 + ch]);
        if (d < bestD) {
          bestD = d;
          best = order[k];
        }
      }
      out[i] = best;
    }
    return out;
  }

  /** 1 枚の形の部位の絵を、見えている所（map でその部位のマス）とそれ以外に分ける。ファイルは分けない（ガイドと数えに使う） */
  function splitByMap(order, parts, map, colors, w, h) {
    var labels = mapLabels(order, colors, map, w, h);
    var visible = {};
    var rest = {};
    order.forEach(function (name) {
      var img = parts[name];
      visible[name] = blank(w, h);
      rest[name] = blank(w, h);
      if (!img) return;
      for (var i = 0; i < w * h; i++) {
        var o = i * 4;
        if (!img.data[o + 3]) continue;
        var dst = labels[i] === name ? visible[name] : rest[name];
        dst.data[o] = img.data[o];
        dst.data[o + 1] = img.data[o + 1];
        dst.data[o + 2] = img.data[o + 2];
        dst.data[o + 3] = img.data[o + 3];
      }
    });
    return { visible: visible, rest: rest, labels: labels };
  }

  /** 部位の 1 枚の絵: hidden の上に own を重ねる（own の不透明でない画素が優先）。どちらも無ければ透明 */
  function composePart(own, hidden, w, h) {
    var out = hidden ? copyImage(hidden) : blank(w, h);
    if (own) {
      for (var i = 0; i < w * h; i++) {
        var o = i * 4;
        if (!own.data[o + 3]) continue;
        out.data[o] = own.data[o];
        out.data[o + 1] = own.data[o + 1];
        out.data[o + 2] = own.data[o + 2];
        out.data[o + 3] = own.data[o + 3];
      }
    }
    return out;
  }

  /**
   * 重ねた見た目から、部位ごとの見えている所と隠れた所に分け直す。
   * 画素ごとに、その画素を持つ（alpha > 0）部位のうち一番手前（order の後ろ）がその部位の見えている所、
   * それより奥の部位の同じ画素はその部位の隠れた所。
   */
  function splitParts(order, parts, w, h) {
    var own = {};
    var hidden = {};
    order.forEach(function (name) {
      own[name] = blank(w, h);
      hidden[name] = blank(w, h);
    });
    for (var i = 0; i < w * h; i++) {
      var o = i * 4;
      var front = true;
      for (var k = order.length - 1; k >= 0; k--) {
        var name = order[k];
        var img = parts[name];
        if (!img || !img.data[o + 3]) continue;
        var dst = front ? own[name] : hidden[name];
        dst.data[o] = img.data[o];
        dst.data[o + 1] = img.data[o + 1];
        dst.data[o + 2] = img.data[o + 2];
        dst.data[o + 3] = img.data[o + 3];
        front = false;
      }
    }
    return { own: own, hidden: hidden };
  }

  /** 見えている所の部位から map.png を作り直す（重なった画素は手前の部位） */
  function rebuildMap(order, own, colors, w, h) {
    var map = blank(w, h);
    order.forEach(function (name) {
      var img = own[name];
      if (!img) return;
      var c = colors[name];
      for (var i = 0; i < w * h; i++) {
        if (!img.data[i * 4 + 3]) continue;
        map.data[i * 4] = c[0];
        map.data[i * 4 + 1] = c[1];
        map.data[i * 4 + 2] = c[2];
        map.data[i * 4 + 3] = 255;
      }
    });
    return map;
  }

  /** a と b の両方で alpha > 0 の画素の数（own ↔ hidden の移りの数え） */
  function countBoth(a, b) {
    if (!a || !b) return 0;
    var n = 0;
    for (var i = 3; i < a.data.length; i += 4) if (a.data[i] && b.data[i]) n++;
    return n;
  }

  /**
   * 書き戻すファイルを決める。
   * current: 今のファイルの画素 { own, hidden, map }（無いファイルは undefined）
   * edited:  部位のレイヤーの画素 { parts: { <部位>: image } }（レイヤーが見つからない部位は undefined）
   *          parts の画素は「見えている所と隠れた所を重ねた 1 枚」。ここで分け直す（splitParts）。
   * 返す: { writes: [{ file, kind, part, bytes, diff, toHidden, toOwn }], notes: [...] }
   *   diff: そのファイルで変わる画素の数。toHidden: 見えている所 → 隠れた所へ移った画素（own のファイル）、
   *   toOwn: 隠れた所 → 見えている所へ移った画素（hidden のファイル）。
   * 画素の変わらないファイルは書かない（PNG の作り直しで中身の同じファイルのバイト列を変えないため）。
   */
  function planSave(info, current, edited, options) {
    var plan = planSaveParts(info, current, edited, options);
    var j = planJoints(info, edited.joints);
    if (j.write) plan.writes.push(j.write);
    plan.notes = plan.notes.concat(j.notes);
    return plan;
  }

  /**
   * 関節の書き戻し: joint:<関節> のレイヤーの不透明な画素を、その関節の位置として読む。
   * - 不透明な画素が、読み込んだときの位置（四捨五入した画素）だけ → 動いていない。値はそのまま（小数も残す）
   * - それ以外の不透明な画素がちょうど 1 つ → そこへ動いた（元の位置の画素は消し忘れてもよい）。値は画素の真ん中（i + 0.5）
   * - それ以外が 2 つ以上・不透明な画素が 1 つも無い・レイヤーが無い → 書かずに知らせる
   * jointLayers: { <関節>: image|null }。動いた関節があるときだけ joints-drawn.json を書く（キーの並びは元のまま）
   * 返す: { write: { file, kind: 'joints', text, diff, joints: [{ name, from, to }] } | null, notes }
   */
  function planJoints(info, jointLayers) {
    var notes = [];
    if (!info.drawn || !jointLayers) return { write: null, notes: notes };
    var w = info.width;
    var h = info.height;
    var out = {};
    var moved = [];
    Object.keys(info.drawn).forEach(function (jn) {
      var j = info.drawn[jn];
      out[jn] = j;
      var img = jointLayers[jn];
      if (!img) {
        notes.push('joint layer not found, left as is: ' + jn);
        return;
      }
      var at = drawnPixel(j);
      var others = [];
      var atOriginal = false;
      for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
          if (img.data[(y * w + x) * 4 + 3] !== 255) continue;
          if (x === at[0] && y === at[1]) atOriginal = true;
          else others.push([x, y]);
        }
      if (others.length === 1) {
        var to = { x: others[0][0] + 0.5, y: others[0][1] + 0.5 };
        var next = {};
        Object.keys(j).forEach(function (k) {
          next[k] = j[k];
        });
        next.x = to.x;
        next.y = to.y;
        out[jn] = next;
        moved.push({ name: jn, from: { x: j.x, y: j.y }, to: to });
      } else if (others.length > 1) notes.push('joint ' + jn + ' has ' + (others.length + (atOriginal ? 1 : 0)) + ' opaque px, left as is (keep one)');
      else if (!atOriginal) notes.push('joint ' + jn + ' has no opaque px, left as is');
    });
    if (!moved.length) return { write: null, notes: notes };
    return {
      write: { file: DRAWN_FILE, kind: 'joints', text: JSON.stringify(out, null, 2) + '\n', diff: moved.length, joints: moved },
      notes: notes,
    };
  }

  function planSaveParts(info, current, edited, options) {
    options = options || {};
    if (info.format === 'one') return planSaveOne(info, current, edited);
    var order = info.order;
    var w = info.width;
    var h = info.height;
    var writes = [];
    var notes = (edited.notes || []).slice();
    var parts = {};
    var missing = {};
    order.forEach(function (name) {
      var img = edited.parts && edited.parts[name];
      if (!img) {
        // レイヤーが無い部位は、今のファイルの重ねた絵を代わりに使い（分け直しの奥・手前のため）、そのファイルは書かない
        missing[name] = true;
        notes.push('layer not found, files left as is: ' + name + '.png, ' + name + '.hidden.png');
        parts[name] = composePart(current.own[name], current.hidden[name], w, h);
        return;
      }
      if (img.width !== w || img.height !== h) throw new Error('layer size differs: ' + name);
      parts[name] = img;
    });
    var split = splitParts(order, parts, w, h);
    var ownAfter = {};
    order.forEach(function (name) {
      ownAfter[name] = missing[name] ? current.own[name] : split.own[name];
      if (missing[name]) return;
      [
        ['own', name + '.png', current.own[name], split.own[name]],
        ['hidden', name + '.hidden.png', current.hidden[name], split.hidden[name]],
      ].forEach(function (t) {
        var before = t[2];
        var after = t[3];
        // 元のファイルが無く、分け直しても空なら作らない
        if (!before && countDiff(blank(w, h), after) === 0) return;
        if (before && samePixels(before, after)) return;
        var item = { file: t[1], kind: t[0], part: name, bytes: encodePng(normalize(copyImage(after))), diff: before ? countDiff(before, after) : countDiff(blank(w, h), after) };
        // 移りの数: own のファイルなら「前は own、いまは hidden」、hidden のファイルなら「前は hidden、いまは own」
        if (t[0] === 'own') item.toHidden = countBoth(before, split.hidden[name]);
        else item.toOwn = countBoth(before, split.own[name]);
        writes.push(item);
      });
    });
    if (options.updateMap !== false && current.map) {
      var colors = partColors(order, current.own, current.map);
      var map = rebuildMap(order, ownAfter, colors, w, h);
      if (!samePixels(current.map, map)) writes.push({ file: 'map.png', kind: 'map', bytes: encodePng(map), diff: countDiff(current.map, map) });
    }
    // json（軸・親・重なる順・画素の数）は読むだけで書き換えない。
    // 画素の数（pixels・hidden）は heosterra の split の時点の数で、隠れた所の描き足し（fill）のあとは
    // もともと PNG と揃っていないため、ここで数え直すと直していないのに json が変わってしまう。
    return { writes: writes, notes: notes };
  }

  function copyImage(img) {
    return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
  }

  /**
   * 1 枚の形（info.format === 'one'）の書き戻し: 部位のレイヤーを、分け直さずにそのまま <部位>.png に書く。
   * .hidden.png は作らない。map.png は書き換えない。画素の変わったファイルだけ書く。
   * 見えている所（map.png でその部位のマス）の画素を変えたときは数えて知らせる（heosterra では、見えている所を集めた絵が
   * 元の 1 枚 <向き>.png と全画素一致することを試験で縛っているため。見えている所を直すなら元の 1 枚を直して split をやり直す）
   * 返す writes の各要素: { file, kind: 'part', part, bytes, diff, visibleDiff }
   */
  function planSaveOne(info, current, edited) {
    var order = info.order;
    var w = info.width;
    var h = info.height;
    var writes = [];
    var notes = (edited.notes || []).slice();
    var colors = partColors(order, current.own, current.map, true);
    var labels = current.map ? mapLabels(order, colors, current.map, w, h) : null;
    var visibleTotal = 0;
    order.forEach(function (name) {
      var img = edited.parts && edited.parts[name];
      if (!img) {
        notes.push('layer not found, file left as is: ' + name + '.png');
        return;
      }
      if (img.width !== w || img.height !== h) throw new Error('layer size differs: ' + name);
      var before = current.own[name];
      if (before && samePixels(before, img)) return;
      if (!before && countDiff(blank(w, h), img) === 0) return;
      var base = before || blank(w, h);
      var visibleDiff = 0;
      if (labels)
        for (var i = 0; i < w * h; i++) if (labels[i] === name && !samePixel(base, img, i)) visibleDiff++;
      visibleTotal += visibleDiff;
      writes.push({ file: name + '.png', kind: 'part', part: name, bytes: encodePng(normalize(copyImage(img))), diff: countDiff(base, img), visibleDiff: visibleDiff });
    });
    if (visibleTotal)
      notes.push(
        visibleTotal +
          ' px changed in visible cells (map.png). map.png is not rewritten, and the visible cells no longer match the original sprite'
      );
    return { writes: writes, notes: notes };
  }

  /** 1 画素を比べる（samePixels と同じ決まり: 透明どうしは色を見ない） */
  function samePixel(a, b, i) {
    var o = i * 4;
    var aa = a.data[o + 3];
    var ba = b.data[o + 3];
    if (!aa && !ba) return true;
    return aa === ba && a.data[o] === b.data[o] && a.data[o + 1] === b.data[o + 1] && a.data[o + 2] === b.data[o + 2];
  }

  /** 書くファイル 1 件の説明（例: "torso.png (12 px, 3 px moved to hidden)"） */
  function describeWrite(w) {
    if (w.kind === 'joints')
      return (
        w.file +
        ' (' +
        w.joints
          .map(function (m) {
            return m.name + ' ' + m.from.x + ',' + m.from.y + ' -> ' + m.to.x + ',' + m.to.y;
          })
          .join('; ') +
        ')'
      );
    var s = w.file + ' (' + w.diff + ' px';
    if (w.visibleDiff) s += ', ' + w.visibleDiff + ' px in visible cells';
    if (w.toHidden) s += ', ' + w.toHidden + ' px moved to hidden';
    if (w.toOwn) s += ', ' + w.toOwn + ' px moved to visible';
    return s + ')';
  }

  /**
   * レイヤーから、planSave に渡す部位の画素を集める。
   * pick(layerName) は、その名前のレイヤーの画素（絵の大きさ）か、無ければ null/undefined を返す。
   * 前の形（v0.1: <部位> と <部位>.hidden の 2 枚）の絵なら、<部位> を <部位>.hidden の上に重ねて 1 枚に寄せる。
   * 返す: { parts: { <部位>: image }, found: 見つかった部位の数, legacy: 寄せた部位の名前の配列, notes }
   */
  function collectParts(order, w, h, pick) {
    var parts = {};
    var legacy = [];
    var found = 0;
    order.forEach(function (name) {
      var img = pick(name);
      var hid = pick(name + LAYER.hiddenSuffix);
      if (!img && !hid) return;
      found++;
      if (hid) {
        legacy.push(name);
        parts[name] = composePart(img || null, hid, w, h);
      } else parts[name] = img;
    });
    var notes = [];
    if (legacy.length)
      notes.push('old layout: merged ' + legacy.length + ' "<part>.hidden" layers into their part layers (reopen the folder to get the new layout)');
    return { parts: parts, found: found, legacy: legacy, notes: notes };
  }

  /** 関節のレイヤーを集める（pick は collectParts と同じ）。joints-drawn.json の無いフォルダでは null */
  function collectJoints(info, pick) {
    if (!info.drawn) return null;
    var out = {};
    Object.keys(info.drawn).forEach(function (jn) {
      out[jn] = pick(LAYER.jointPrefix + jn) || null;
    });
    return out;
  }

  /** フォルダのファイルの一覧から json の名前を決める（parts.json があればそれ、無ければ .json が 1 つだけのとき） */
  function pickJson(names) {
    if (names.indexOf('parts.json') >= 0) return 'parts.json';
    var js = names.filter(function (n) {
      return /\.json$/i.test(n);
    });
    if (js.length === 1) return js[0];
    if (!js.length) throw new Error('no .json in the folder');
    throw new Error('several .json in the folder and no parts.json: ' + js.join(', '));
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    var sep = dir.indexOf('\\') >= 0 && dir.indexOf('/') < 0 ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  /**
   * 部位のフォルダの形。
   * - 'one'（heosterra の 2026-11-25 から）: 部位ごとに <部位>.png が 1 枚（見えている所＋隠れた所の描き足し）。
   *   どこが見えている所かは map.png（部位の色のマス）で決まる。.hidden.png は無い
   * - 'split'（前の形）: <部位>.png（見えている所）と <部位>.hidden.png（隠れた所）の 2 枚
   * .hidden.png が 1 つでもあれば 'split'、1 つも無ければ 'one'
   */
  function folderFormat(names) {
    return names.some(function (n) {
      return /\.hidden\.png$/i.test(n);
    })
      ? 'split'
      : 'one';
  }

  /**
   * フォルダを読む（io は { list(dir) → 名前の並び, read(path) → Uint8Array, readText(path) → 文字列 } の Promise を返す口）。
   * 返す: { info, current, files }
   */
  function loadFolder(io, dir) {
    var info;
    var current = { own: {}, hidden: {}, map: undefined, jsonText: undefined };
    return io
      .list(dir)
      .then(function (names) {
        var jsonFile = pickJson(names);
        return io.readText(joinPath(dir, jsonFile)).then(function (text) {
          info = readPartsJson(text);
          info.jsonFile = jsonFile;
          info.dir = dir;
          info.format = folderFormat(names);
          current.jsonText = text;
          var jobs = [];
          var readPng = function (file, set) {
            if (names.indexOf(file) < 0) return;
            jobs.push(
              io.read(joinPath(dir, file)).then(function (bytes) {
                set(decodePng(bytes));
              })
            );
          };
          info.order.forEach(function (name) {
            readPng(name + '.png', function (img) {
              current.own[name] = img;
            });
            readPng(name + '.hidden.png', function (img) {
              current.hidden[name] = img;
            });
          });
          readPng('map.png', function (img) {
            current.map = img;
          });
          if (names.indexOf(DRAWN_FILE) >= 0)
            jobs.push(
              io.readText(joinPath(dir, DRAWN_FILE)).then(function (text) {
                info.drawn = readDrawnJson(text);
              })
            );
          return Promise.all(jobs);
        });
      })
      .then(function () {
        var size = null;
        var check = function (img, file) {
          if (!img) return;
          if (!size) size = [img.width, img.height];
          else if (img.width !== size[0] || img.height !== size[1])
            throw new Error('PNG sizes differ: ' + file + ' is ' + img.width + 'x' + img.height + ' (others ' + size[0] + 'x' + size[1] + ')');
        };
        info.order.forEach(function (name) {
          check(current.own[name], name + '.png');
          check(current.hidden[name], name + '.hidden.png');
        });
        check(current.map, 'map.png');
        if (!size) {
          if (!info.grid) throw new Error('no part PNG in the folder');
          size = [info.grid, info.grid];
        }
        if (info.grid && (size[0] !== info.grid || size[1] !== info.grid))
          throw new Error('PNG size ' + size[0] + 'x' + size[1] + ' differs from json grid ' + info.grid);
        info.width = size[0];
        info.height = size[1];
        var missing = info.order.filter(function (n) {
          return !current.own[n];
        });
        info.missing = missing;
        return { info: info, current: current };
      });
  }

  /** 書き戻す（planSave の結果を io.write(path, bytes|text) で書く） */
  function writePlan(io, dir, plan) {
    return plan.writes.reduce(function (p, wr) {
      return p.then(function () {
        return io.write(joinPath(dir, wr.file), wr.bytes || wr.text);
      });
    }, Promise.resolve());
  }

  return {
    LAYER: LAYER,
    DRAWN_FILE: DRAWN_FILE,
    DRAWN_RING_ALPHA: DRAWN_RING_ALPHA,
    PART_COLORS: PART_COLORS,
    GUIDE_ALPHA: GUIDE_ALPHA,
    crc32: crc32,
    adler32: adler32,
    inflateRaw: inflateRaw,
    zlibInflate: zlibInflate,
    deflateRaw: deflateRaw,
    zlibDeflate: zlibDeflate,
    decodePng: decodePng,
    encodePng: encodePng,
    samePixels: samePixels,
    countDiff: countDiff,
    blank: blank,
    readPartsJson: readPartsJson,
    partColors: partColors,
    guideImage: guideImage,
    buildLayers: buildLayers,
    composePart: composePart,
    splitParts: splitParts,
    splitByMap: splitByMap,
    mapLabels: mapLabels,
    folderFormat: folderFormat,
    collectParts: collectParts,
    collectJoints: collectJoints,
    jointImage: jointImage,
    planJoints: planJoints,
    describeWrite: describeWrite,
    rebuildMap: rebuildMap,
    planSave: planSave,
    pickJson: pickJson,
    joinPath: joinPath,
    loadFolder: loadFolder,
    writePlan: writePlan,
  };
})();

// =============================================================================
// LibreSprite の中の動き
// =============================================================================
var PartsApp = (function (core) {
  'use strict';

  var STORAGE_DIR = 'partsDir';

  function hasFs() {
    return typeof fs === 'object' && fs && typeof fs.readFile === 'function' && typeof fs.writeFile === 'function';
  }

  /** LibreSprite の fs の口を、core の io の形にする */
  function fsIo() {
    return {
      list: function (dir) {
        return fs.listDir(dir).then(function (entries) {
          return entries
            .filter(function (e) {
              return e.isFile;
            })
            .map(function (e) {
              return e.name;
            });
        });
      },
      read: function (path) {
        return fs.readFile(path, { encoding: 'binary' });
      },
      readText: function (path) {
        return fs.readFile(path);
      },
      write: function (path, data) {
        return fs.writeFile(path, data);
      },
    };
  }

  /** 開いている絵のレイヤーを名前で引く */
  function layersByName(spr) {
    var map = {};
    var n = spr.layerCount;
    for (var i = 0; i < n; i++) {
      var l = spr.layer(i);
      if (l && map[l.name] === undefined) map[l.name] = l;
    }
    return map;
  }

  /** レイヤーの画素を、絵の大きさの RGBA にして返す（cel が詰められて位置がずれていても戻す） */
  function layerPixels(layer, w, h) {
    var out = core.blank(w, h);
    var cel = layer.cel(0);
    if (!cel) return out;
    var img = cel.image;
    if (!img) return out;
    var cw = img.width;
    var ch = img.height;
    var stride = img.stride;
    if (stride !== cw * 4) throw new Error('not an RGB image (layer ' + layer.name + ')');
    var d = img.getImageData();
    var cx = cel.x;
    var cy = cel.y;
    for (var y = 0; y < ch; y++) {
      var sy = cy + y;
      if (sy < 0 || sy >= h) continue;
      for (var x = 0; x < cw; x++) {
        var sx = cx + x;
        if (sx < 0 || sx >= w) continue;
        var s = y * stride + x * 4;
        var o = (sy * w + sx) * 4;
        out.data[o] = d[s];
        out.data[o + 1] = d[s + 1];
        out.data[o + 2] = d[s + 2];
        out.data[o + 3] = d[s + 3];
      }
    }
    return out;
  }

  /** 新しい絵を作り、レイヤーを並べる（下から順） */
  function createSprite(info, layers) {
    var ok = command.NewFile({ width: info.width, height: info.height, 'color-mode': 'rgb', background: 'transparent' });
    if (!ok) throw new Error('could not create a new sprite');
    var spr = app.activeSprite;
    layers.forEach(function (l, i) {
      var layer;
      if (i === 0) {
        layer = spr.layer(0);
        layer.name = l.name;
      } else {
        if (!command.NewLayer({ name: l.name, top: 'true' })) throw new Error('could not add layer: ' + l.name);
        layer = spr.layer(spr.layerCount - 1);
        if (layer.name !== l.name) layer.name = l.name;
      }
      var cel = layer.cel(0) || layer.createCel(0);
      var img = cel.image;
      if (img.width !== info.width || img.height !== info.height || cel.x !== 0 || cel.y !== 0)
        throw new Error('cel size differs from the sprite: ' + l.name);
      cel.image.putImageData(l.image.data);
    });
    // 表示と編集の可否は、画素を入れ終えてから決める
    layers.forEach(function (l, i) {
      var layer = spr.layer(i);
      layer.isVisible = l.visible;
      layer.isEditable = l.editable;
    });
    redraw();
    return spr;
  }

  /** 読み込む（fs の口が要る） */
  function load(dir, report) {
    var io = fsIo();
    return core.loadFolder(io, dir).then(function (r) {
      var built = core.buildLayers(r.info, { own: r.current.own, hidden: r.current.hidden, map: r.current.map });
      createSprite(r.info, built.layers);
      var msg = 'Loaded ' + r.info.order.length + ' parts (back to front: ' + r.info.order.join(' > ') + ')';
      if (r.info.missing.length) msg += '. Parts without PNG (empty layers): ' + r.info.missing.join(', ');
      report(msg);
      return r;
    });
  }

  /** 開いている絵のレイヤーから、部位の画素を集める */
  function collectEdited(spr, info) {
    if (spr.width !== info.width || spr.height !== info.height)
      throw new Error('the sprite is ' + spr.width + 'x' + spr.height + ' but the parts are ' + info.width + 'x' + info.height);
    if (spr.colorMode !== 0) throw new Error('the sprite is not RGB (set Sprite > Color Mode to RGB)');
    var byName = layersByName(spr);
    var c = core.collectParts(info.order, info.width, info.height, function (name) {
      var l = byName[name];
      return l ? layerPixels(l, info.width, info.height) : null;
    });
    if (!c.found) throw new Error('the sprite has no layer named after a part');
    var joints = core.collectJoints(info, function (name) {
      var l = byName[name];
      return l ? layerPixels(l, info.width, info.height) : null;
    });
    return { parts: c.parts, joints: joints, notes: c.notes };
  }

  /** 書き戻す（fs の口が要る） */
  function save(dir, report, options) {
    var io = fsIo();
    var spr = app.activeSprite;
    if (!spr) return Promise.reject(new Error('no sprite is open'));
    return core.loadFolder(io, dir).then(function (r) {
      var edited = collectEdited(spr, r.info);
      var plan = core.planSave(r.info, r.current, edited, options);
      return core.writePlan(io, dir, plan).then(function () {
        var lines = plan.writes.map(function (w) {
          return core.describeWrite(w);
        });
        report(
          (plan.writes.length ? 'Saved: ' + lines.join(', ') : 'No part changed (nothing written)') +
            (plan.notes.length ? '. ' + plan.notes.join('. ') : '')
        );
        return plan;
      });
    });
  }

  /** 種類ごとにレイヤーの表示を切り替える（kind: 'guide' | 'map' | 'joint'） */
  function toggle(kind) {
    var spr = app.activeSprite;
    if (!spr) return null;
    var n = spr.layerCount;
    var targets = [];
    for (var i = 0; i < n; i++) {
      var l = spr.layer(i);
      var name = l.name;
      if (kind === 'guide' && name.indexOf(core.LAYER.guidePrefix) === 0) targets.push(l);
      else if (kind === 'map' && name === core.LAYER.map) targets.push(l);
      else if (kind === 'joint' && name.indexOf(core.LAYER.jointPrefix) === 0) targets.push(l);
    }
    if (!targets.length) return null;
    var show = !targets.some(function (l) {
      return l.isVisible;
    });
    targets.forEach(function (l) {
      l.isVisible = show;
    });
    redraw();
    return show;
  }

  /** 画面を描き直す。窓のあるとき（画面のあるとき）だけ: 1.3 の headless では app.redraw が落ちる */
  function redraw() {
    if (dialog && typeof app.redraw === 'function') app.redraw();
  }

  // ---------------------------------------------------------------------------
  // 窓
  // ---------------------------------------------------------------------------
  var dialog = null;
  var busy = false;

  function status(text) {
    console.log('parts-editor: ' + text);
    if (dialog) {
      var w = dialog.get('status');
      if (w) w.text = text;
    }
  }

  function folderValue() {
    var w = dialog && dialog.get('dir');
    var v = w ? String(w.value || '').trim() : '';
    // 前後の引用符（パスを貼り付けたとき）を外す
    v = v.replace(/^["']|["']$/g, '');
    return v;
  }

  function run(label, fn) {
    if (busy) {
      status('Busy, wait for the current task to finish');
      return;
    }
    busy = true;
    status(label + '…');
    var finish = function () {
      busy = false;
    };
    var task = function () {
      return Promise.resolve()
        .then(fn)
        .then(finish, function (e) {
          finish();
          status('Failed: ' + (e && e.message ? e.message : e));
        });
    };
    if (typeof app.critical === 'function') app.critical(task);
    else task();
  }

  function openDialog() {
    // 1.3 の createDialog は id を取らない（渡しても使われない）。headless では null が返る
    dialog = app.createDialog('parts_editor');
    if (!dialog) return false;
    dialog.title = 'Parts Editor (heosterra)';
    if (hasFs()) {
      dialog.addLabel('Parts folder (xx-parts):', 'dir_label');
      dialog.addBreak();
      dialog.addEntry('', 'dir');
      dialog.addBreak();
      dialog.addButton('Load', 'load');
      dialog.addButton('Save to parts', 'save');
      dialog.addBreak();
    } else {
      dialog.addLabel('This LibreSprite has no fs API.', 'nofs1');
      dialog.addBreak();
      dialog.addLabel('Load/save with cli/parts-ase.mjs (see README).', 'nofs2');
      dialog.addBreak();
    }
    dialog.addButton('Guides', 'guide');
    dialog.addButton('Map', 'map');
    dialog.addButton('Joints', 'joint');
    dialog.addBreak();
    dialog.addLabel('', 'status');
    if (hasFs()) {
      var saved = typeof storage === 'object' && storage.get ? storage.get(STORAGE_DIR) : null;
      if (saved) dialog.get('dir').value = String(saved);
    }
    return true;
  }

  function remember(dir) {
    if (typeof storage === 'object' && storage.set) {
      storage.set(dir, STORAGE_DIR);
      if (storage.save) storage.save(STORAGE_DIR);
    }
  }

  function onEvent(e) {
    if (!dialog) return;
    if (e === 'load_click') {
      var dir = folderValue();
      if (!dir) return status('Enter the parts folder path');
      remember(dir);
      run('Loading', function () {
        return load(dir, status);
      });
    } else if (e === 'save_click') {
      var d = folderValue();
      if (!d) return status('Enter the parts folder path');
      remember(d);
      run('Saving', function () {
        return save(d, status);
      });
    } else if (e === 'guide_click' || e === 'map_click' || e === 'joint_click') {
      var kind = e.replace(/_click$/, '');
      var shown = toggle(kind);
      var label = { guide: 'Guide', map: 'Map', joint: 'Joint' }[kind];
      status(shown === null ? 'No ' + label.toLowerCase() + ' layers in the active sprite' : label + ' layers ' + (shown ? 'shown' : 'hidden'));
    } else if (/_close$/.test(e)) {
      // 窓の閉じるボタン（新しい版は parts_editor_close。1.3 は窓に id が無い）
      dialog.close();
      dialog = null;
    }
  }

  return {
    hasFs: hasFs,
    load: load,
    save: save,
    toggle: toggle,
    collectEdited: collectEdited,
    layerPixels: layerPixels,
    openDialog: openDialog,
    onEvent: onEvent,
  };
})(PartsCore);

if (typeof module === 'object' && module && module.exports) {
  module.exports = { core: PartsCore, app: PartsApp };
} else if (typeof app === 'object' && app && app.isHeadless !== true) {
  // 1.3 には app.isHeadless が無い。headless（-b）では createDialog が null を返し、窓は開かない
  PartsApp.openDialog();
}

function onEvent(e) {
  PartsApp.onEvent(e);
}
