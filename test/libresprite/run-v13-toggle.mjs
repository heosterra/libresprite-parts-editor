#!/usr/bin/env node
// fs の口の無い LibreSprite（1.3 など）で、parts-editor.js が読めて、表示の切り替えが動くかを確かめる。
//   node test/libresprite/run-v13-toggle.mjs --libresprite <実行ファイル> --ase <CLI で作った .ase>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const { values } = parseArgs({ options: { libresprite: { type: 'string' }, ase: { type: 'string' } } });
if (!values.libresprite || !values.ase) {
  console.error('--libresprite と --ase が要ります');
  process.exit(2);
}
const editor = readFileSync(join(ROOT, 'parts-editor.js'), 'utf8').replace(/^\/\/\/permission.*$/gm, '');
const driver = readFileSync(join(HERE, 'v13-toggle.js'), 'utf8').split('__ASE__').join(JSON.stringify(resolve(values.ase)));
const script = join(mkdtempSync(join(tmpdir(), 'parts-editor-v13-')), 'v13.run.js');
writeFileSync(script, `${editor}\n;\n${driver}`);
const r = spawnSync(values.libresprite, ['-b', '--script', script], { encoding: 'utf8', timeout: 120000 });
const got = {};
for (const line of `${r.stdout}`.split('\n')) {
  const m = /^RESULT (\S+) (.*)$/.exec(line);
  if (m) got[m[1]] = JSON.parse(m[2]);
}
const want = { hasFs: false, guide: [false, true], hidden: null, map: [true, false], openDialog: false };
let ng = 0;
for (const [k, v] of Object.entries(want)) {
  const ok = JSON.stringify(got[k]) === JSON.stringify(v);
  if (!ok) ng++;
  console.log(`${ok ? 'OK  ' : 'NG  '} ${k}: ${JSON.stringify(got[k])}`);
}
if (ng) console.log(r.stdout);
process.exit(ng ? 1 : 0);
