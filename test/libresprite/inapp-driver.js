// （run.mjs が、この前に「記憶の中の fs」と parts-editor.js をつなげて走らせる）
// parts-editor.js の読み込み・書き戻しを、本物の LibreSprite の上で通す。
// fs だけは記憶の中の模擬（__memfs）で、本物のファイルには触れない。
(async function () {
  // console の 1 行は長いと切れるので、800 字ずつに分けて出す（run.mjs がつなぎ直す）
  function out(k, v) {
    var s = JSON.stringify(v);
    var n = Math.max(1, Math.ceil(s.length / 800));
    for (var i = 0; i < n; i++) console.log('RESULTPART ' + k + ' ' + i + ' ' + n + ' ' + s.slice(i * 800, (i + 1) * 800));
  }
  try {
    out('version', app.version);
    var dir = __DIR__;
    var editLayer = __EDIT_LAYER__;
    var ex = __EDIT_X__;
    var ey = __EDIT_Y__;
    var logs = [];
    var report = function (m) {
      logs.push(m);
    };

    await PartsApp.load(dir, report);
    var names = [];
    for (var i = 0; i < sprite.layerCount; i++) {
      var l = sprite.layer(i);
      names.push([l.name, l.isVisible, l.isEditable]);
    }
    out('layers', names);
    out('size', [sprite.width, sprite.height, sprite.colorMode]);

    // 見えているレイヤーのうちガイド以外を重ねた絵（立ち絵と同じかは run.mjs が確かめる）
    var W = sprite.width;
    var H = sprite.height;
    var flat = new Uint8Array(W * H * 4);
    for (i = 0; i < sprite.layerCount; i++) {
      var ly = sprite.layer(i);
      if (!ly.isVisible || ly.name.indexOf('guide:') === 0) continue;
      var px = PartsApp.layerPixels(ly, W, H);
      for (var k = 0; k < W * H; k++)
        if (px.data[k * 4 + 3]) {
          flat[k * 4] = px.data[k * 4];
          flat[k * 4 + 1] = px.data[k * 4 + 1];
          flat[k * 4 + 2] = px.data[k * 4 + 2];
          flat[k * 4 + 3] = px.data[k * 4 + 3];
        }
    }
    out('flatPng', __b64(PartsCore.encodePng({ width: W, height: H, data: flat })));

    // 直さずに書き戻す → 何も書かれないこと
    __memfs.writes = [];
    await PartsApp.save(dir, report);
    out('writesNoEdit', __memfs.writes.map(function (w) { return w.path; }));

    // 表示の切り替え
    out('toggleGuide', [PartsApp.toggle('guide'), PartsApp.toggle('guide')]);
    out('toggleHidden', [PartsApp.toggle('hidden'), PartsApp.toggle('hidden')]);
    out('toggleMap', [PartsApp.toggle('map'), PartsApp.toggle('map')]);

    // 1 画素だけ直して書き戻す
    var target = null;
    for (i = 0; i < sprite.layerCount; i++) if (sprite.layer(i).name === editLayer) target = sprite.layer(i);
    var cel = target.cel(0);
    cel.image.putPixel(ex - cel.x, ey - cel.y, app.pixelColor.rgba(1, 2, 3, 255));
    __memfs.writes = [];
    await PartsApp.save(dir, report);
    out('writesEdit', __memfs.writes.map(function (w) { return [w.path, typeof w.data === 'string' ? w.data : __b64(w.data)]; }));
    out('logs', logs);
  } catch (e) {
    out('error', String(e && e.stack ? e.stack : e));
  }
  out('done', true);
})();
