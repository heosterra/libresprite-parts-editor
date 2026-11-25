#!/usr/bin/env node
// headless の LibreSprite で窓（parts-editor.js の窓）を開き、画面を PNG に撮る。
//   node test/libresprite/run-dialog-shot.mjs --libresprite <実行ファイル> --out <shot.png>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const { values } = parseArgs({ options: { libresprite: { type: 'string' }, out: { type: 'string' } } });
if (!values.libresprite || !values.out) {
  console.error('--libresprite と --out が要ります');
  process.exit(2);
}
const editor = readFileSync(join(ROOT, 'parts-editor.js'), 'utf8').replace(/^\/\/\/permission.*$/gm, '');
const driver = readFileSync(join(HERE, 'dialog-shot.js'), 'utf8').split('__SHOT__').join(JSON.stringify(resolve(values.out)));
const script = join(mkdtempSync(join(tmpdir(), 'parts-editor-shot-')), 'shot.run.js');
writeFileSync(script, `${editor}\n;\n${driver}`);
const r = spawnSync(values.libresprite, ['-b', '--script', script], { encoding: 'utf8', timeout: 120000 });
const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('SHOT '));
console.log(line ?? r.stdout);
process.exit(line === 'SHOT true' ? 0 : 1);
