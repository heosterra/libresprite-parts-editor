// （run-v13-toggle.mjs が、この前に parts-editor.js をつなげて走らせる）
// fs の口の無い版で、スクリプトが読めて、.ase を開いた絵で表示の切り替えが動くか。
try {
  console.log('RESULT hasFs ' + JSON.stringify(PartsApp.hasFs()));
  app.open(__ASE__);
  console.log('RESULT activeSprite ' + JSON.stringify(typeof app.activeSprite));
  console.log('RESULT guide ' + JSON.stringify([PartsApp.toggle('guide'), PartsApp.toggle('guide')]));
  // 隠れた所のレイヤーは無いので、hidden は対象なし（null）
  console.log('RESULT hidden ' + JSON.stringify(PartsApp.toggle('hidden')));
  console.log('RESULT map ' + JSON.stringify([PartsApp.toggle('map'), PartsApp.toggle('map')]));
  // headless では窓は作れない（null）。作ろうとして落ちないことだけ見る
  console.log('RESULT openDialog ' + JSON.stringify(PartsApp.openDialog()));
} catch (e) {
  console.log('RESULT error ' + JSON.stringify(String(e && e.stack ? e.stack : e)));
}
