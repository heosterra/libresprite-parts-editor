// LibreSprite の中で走らせる確かめ（headless: libresprite -b --script このファイル）。
// パスなどは、下の変数の値を test/libresprite/run.mjs が書き換えた写しを走らせて渡す。
//  1. CLI が作った .ase を開き、レイヤーの名前・表示・編集の可否を出す
//  2. ガイドを隠して、合成した絵を PNG に書き出す（立ち絵と同じかは run.mjs が確かめる）
//  3. 部位のレイヤー（__EDIT_LAYER__）の 1 画素を直し、.ase に保存する（書き戻しは run.mjs が CLI で行う）
var ASE = '__ASE__';
var FLAT = '__FLAT__';
var EDITED = '__EDITED__';
var EDIT_LAYER = '__EDIT_LAYER__';
var EDIT_X = __EDIT_X__;
var EDIT_Y = __EDIT_Y__;

function out(k, v) {
  console.log('RESULT ' + k + ' ' + JSON.stringify(v));
}

try {
  var doc = app.open(ASE);
  out('opened', !!doc);
  out('version', app.version);
  out('hasFs', typeof fs === 'object');
  var names = [];
  for (var i = 0; i < sprite.layerCount; i++) {
    var l = sprite.layer(i);
    names.push([l.name, l.isVisible, l.isEditable]);
  }
  out('layers', names);
  out('size', [sprite.width, sprite.height, sprite.colorMode]);

  // ガイドを隠して平らにした絵を書き出す
  for (i = 0; i < sprite.layerCount; i++) {
    var g = sprite.layer(i);
    if (g.name.indexOf('guide:') === 0) g.isVisible = false;
  }
  sprite.saveAs(FLAT, true);
  out('flat', FLAT);
  // 表示を戻す
  for (i = 0; i < sprite.layerCount; i++) {
    var g2 = sprite.layer(i);
    if (g2.name.indexOf('guide:') === 0) g2.isVisible = true;
  }

  // 1 画素だけ直す
  var target = null;
  for (i = 0; i < sprite.layerCount; i++) if (sprite.layer(i).name === EDIT_LAYER) target = sprite.layer(i);
  var cel = target.cel(0);
  var img = cel.image;
  var before = img.getPixel(EDIT_X - cel.x, EDIT_Y - cel.y);
  img.putPixel(EDIT_X - cel.x, EDIT_Y - cel.y, app.pixelColor.rgba(1, 2, 3, 255));
  out('edited', [EDIT_LAYER, EDIT_X, EDIT_Y, before]);
  sprite.saveAs(EDITED, true);
  out('saved', EDITED);
} catch (e) {
  out('error', String(e));
}
