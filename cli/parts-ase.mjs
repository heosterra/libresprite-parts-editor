#!/usr/bin/env node
// 補助の CLI: fs の口の無い LibreSprite（1.3 など）のために、部位のフォルダと .ase を行き来する。
//
//   node cli/parts-ase.mjs open  <部位のフォルダ> [--out <file.ase>]
//     部位を、レイヤーに分けた .ase にする（既定の置き場: フォルダの隣の <フォルダ名>.ase）
//   node cli/parts-ase.mjs save  <file.ase> [--dir <部位のフォルダ>] [--dry-run] [--no-map]
//     LibreSprite で直して保存した .ase から、部位ごとの PNG へ書き戻す（画素の変わったファイルだけ）
//   node cli/parts-ase.mjs check <部位のフォルダ>
//     読み込み → .ase → 書き戻しの往復で、どのファイルも変わらないことを確かめる（何も書かない）
//
// レイヤーの並び・ガイド・書き戻しの決まりは parts-editor.js（LibreSprite のスクリプト）と同じものを使う。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readAse, writeAse } from '../lib/ase.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');

/** Node の fs を core の io の形にする */
export const nodeIo = {
  list: async (dir) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()),
  read: async (path) => new Uint8Array(readFileSync(path)),
  readText: async (path) => readFileSync(path, 'utf8'),
  write: async (path, data) => writeFileSync(path, typeof data === 'string' ? data : Buffer.from(data)),
};

export async function openFolder(dir) {
  const r = await core.loadFolder(nodeIo, dir);
  const built = core.buildLayers(r.info, { own: r.current.own, hidden: r.current.hidden, map: r.current.map });
  return { ...r, layers: built.layers };
}

export function aseBytes(opened) {
  return writeAse({ width: opened.info.width, height: opened.info.height, layers: opened.layers });
}

/** .ase のレイヤーから、部位の画素を集める */
export function editedFromAse(ase, info) {
  if (ase.width !== info.width || ase.height !== info.height)
    throw new Error(`.ase の大きさ ${ase.width}×${ase.height} が部位の ${info.width}×${info.height} と違います`);
  const byName = new Map();
  for (const l of ase.layers) if (l.type === 0 && !byName.has(l.name)) byName.set(l.name, l);
  const edited = { own: {}, hidden: {} };
  let found = 0;
  for (const name of info.order) {
    const l = byName.get(name);
    if (l) {
      edited.own[name] = l.image ?? core.blank(info.width, info.height);
      found++;
    }
    const h = byName.get(name + core.LAYER.hiddenSuffix);
    if (h) edited.hidden[name] = h.image ?? core.blank(info.width, info.height);
  }
  if (!found) throw new Error('.ase に部位のレイヤーがありません');
  return edited;
}

export async function planFromAse(asePath, dir, options) {
  const r = await core.loadFolder(nodeIo, dir);
  const ase = readAse(readFileSync(asePath));
  return { ...r, plan: core.planSave(r.info, r.current, editedFromAse(ase, r.info), options) };
}

function defaultAsePath(dir) {
  const abs = resolve(dir);
  return join(dirname(abs), `${basename(abs)}.ase`);
}

function defaultDir(asePath) {
  const abs = resolve(asePath);
  const dir = abs.replace(/\.ase$/i, '');
  if (dir !== abs && existsSync(dir) && statSync(dir).isDirectory()) return dir;
  throw new Error(`部位のフォルダが分かりません。--dir で指してください（${basename(abs)} の隣に同じ名前のフォルダがありません）`);
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      dir: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-map': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, target] = positionals;
  if (values.help || !cmd || !target) {
    console.log(
      [
        '使い方:',
        '  node cli/parts-ase.mjs open  <部位のフォルダ> [--out <file.ase>]',
        '  node cli/parts-ase.mjs save  <file.ase> [--dir <部位のフォルダ>] [--dry-run] [--no-map]',
        '  node cli/parts-ase.mjs check <部位のフォルダ>',
      ].join('\n')
    );
    return values.help ? 0 : 2;
  }
  const options = { updateMap: !values['no-map'] };
  if (cmd === 'open') {
    const opened = await openFolder(target);
    const out = values.out ?? defaultAsePath(target);
    writeFileSync(out, aseBytes(opened));
    console.log(`${out} を作りました（${opened.layers.length} レイヤー。奥 → 手前: ${opened.info.order.join(' → ')}）`);
    if (opened.info.missing.length) console.log(`PNG の無い部位（空のレイヤー）: ${opened.info.missing.join(', ')}`);
    return 0;
  }
  if (cmd === 'save') {
    const dir = values.dir ?? defaultDir(target);
    const { plan } = await planFromAse(target, dir, options);
    for (const n of plan.notes) console.log(`注意: ${n}`);
    if (!plan.writes.length) {
      console.log('変わった部位はありません（何も書いていません）');
      return 0;
    }
    for (const w of plan.writes) console.log(`${values['dry-run'] ? '書く予定' : '書きます'}: ${w.file}${w.diff !== undefined ? `（${w.diff} 画素）` : ''}`);
    if (!values['dry-run']) await core.writePlan(nodeIo, dir, plan);
    return 0;
  }
  if (cmd === 'check') {
    const opened = await openFolder(target);
    const ase = readAse(aseBytes(opened));
    const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info), options);
    if (plan.writes.length) {
      console.log(`往復で変わるファイルがあります: ${plan.writes.map((w) => w.file).join(', ')}`);
      return 1;
    }
    console.log(`往復で変わるファイルはありません（${opened.info.order.length} 部位・${opened.layers.length} レイヤー）`);
    return 0;
  }
  console.error(`知らない命令です: ${cmd}`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('parts-ase.mjs')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`失敗しました: ${e.message}`);
      process.exit(1);
    }
  );
}
