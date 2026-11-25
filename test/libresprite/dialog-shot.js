// （run-dialog-shot.mjs が、この前に parts-editor.js をつなげて走らせる）
// headless で窓を開き、窓が描かれたあとの画面を PNG に撮る。
PartsApp.openDialog();
setTimeout(function () {
  console.log('SHOT ' + app.takeScreenshot(__SHOT__));
}, 500);
