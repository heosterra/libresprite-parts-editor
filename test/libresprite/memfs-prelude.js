// 記憶の中の fs（LibreSprite の fs の口と同じ形: readFile / writeFile / listDir が Promise を返す）。
// ファイルの中身（{ パス: base64 }）は run.mjs が下の呼び出しの引数に入れる。
var __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __unb64(s) {
  var clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  var out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  var o = 0;
  for (var i = 0; i < clean.length; i += 4) {
    var a = __B64.indexOf(clean[i]);
    var b = __B64.indexOf(clean[i + 1]);
    var c = i + 2 < clean.length ? __B64.indexOf(clean[i + 2]) : 0;
    var d = i + 3 < clean.length ? __B64.indexOf(clean[i + 3]) : 0;
    var n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length && i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (o < out.length && i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
function __b64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += __B64[(n >> 18) & 63] + __B64[(n >> 12) & 63];
    s += i + 1 < bytes.length ? __B64[(n >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? __B64[n & 63] : '=';
  }
  return s;
}
var __memfs = { files: {}, writes: [] };
(function (files) {
  for (var p in files) __memfs.files[p] = __unb64(files[p]);
})(__FILES__);
function __text(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try {
    return decodeURIComponent(escape(s));
  } catch (e) {
    return s;
  }
}
globalThis.fs = {
  readFile: function (path, options) {
    var f = __memfs.files[path];
    if (!f) return Promise.reject(new Error('no such file: ' + path));
    var binary = options && (options.encoding === 'binary' || options.binary);
    return Promise.resolve(binary ? new Uint8Array(f) : __text(f));
  },
  writeFile: function (path, data) {
    var bytes = typeof data === 'string' ? __unb64(__b64(new Uint8Array(Array.prototype.map.call(unescape(encodeURIComponent(data)), function (c) { return c.charCodeAt(0); })))) : new Uint8Array(data);
    __memfs.files[path] = bytes;
    __memfs.writes.push({ path: path, data: typeof data === 'string' ? data : bytes });
    return Promise.resolve(bytes.length);
  },
  listDir: function (dir) {
    var prefix = dir.replace(/\/+$/, '') + '/';
    var entries = [];
    for (var p in __memfs.files)
      if (p.indexOf(prefix) === 0 && p.slice(prefix.length).indexOf('/') < 0)
        entries.push({ name: p.slice(prefix.length), isFile: true, isDirectory: false, size: __memfs.files[p].length });
    return Promise.resolve(entries);
  },
};
