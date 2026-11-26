#!/usr/bin/env node
// 本物の LibreSprite（headless: -b --script）で、読み込み → 直す → 書き戻しの往復を確かめる。
//
//   node test/libresprite/run.mjs --libresprite <LibreSprite の実行ファイル> --parts <部位のフォルダ> [--sprite <立ち絵.png>]
//        [--mode ase|inapp|both] [--edit-layer head] [--work <作業のフォルダ>]
//
// - ase:   CLI で .ase を作る → LibreSprite で開いて 1 画素直し .ase に保存 → CLI で書き戻す（fs の口の無い 1.3 向けの道）
// - inapp: parts-editor.js をそのまま LibreSprite で走らせ、読み込み・書き戻しを通す（fs の口のある版向けの道）。
//          fs は記憶の中の模擬に差し替える（権限は使わず、本物のファイルには触れない）
//
// 部位のフォルダは作業のフォルダへ写してから使う（元のフォルダは書き換えない）。
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { decodePng as refDecode } from '../../lib/png.mjs';
import { describeWrite, openFolder } from '../../cli/parts-ase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const { core } = require(join(ROOT, 'parts-editor.js'));

const { values } = parseArgs({
  options: {
    libresprite: { type: 'string' },
    parts: { type: 'string' },
    sprite: { type: 'string' },
    mode: { type: 'string', default: 'both' },
    'edit-layer': { type: 'string', default: 'head' },
    work: { type: 'string' },
  },
});
if (!values.libresprite || !values.parts) {
  console.error('--libresprite と --parts が要ります');
  process.exit(2);
}

const srcDir = resolve(values.parts);
const spritePath = values.sprite ?? join(dirname(srcDir), `${basename(srcDir).replace(/-parts$/, '')}.png`);
const work = values.work ? resolve(values.work) : mkdtempSync(join(tmpdir(), 'parts-editor-'));
mkdirSync(join(work, 'ase'), { recursive: true });
let failures = 0;

function check(ok, label, detail) {
  console.log(`${ok ? 'OK  ' : 'NG  '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function runLibreSprite(script) {
  const r = spawnSync(values.libresprite, ['-b', '--script', script], { encoding: 'utf8', timeout: 180000 });
  const results = {};
  const parts = {};
  for (const line of `${r.stdout}`.split('\n')) {
    const m = /^RESULT (\S+) (.*)$/.exec(line);
    if (m) results[m[1]] = JSON.parse(m[2]);
    const p = /^RESULTPART (\S+) (\d+) (\d+) (.*)$/.exec(line);
    if (p) {
      parts[p[1]] ??= { n: Number(p[3]), chunks: [] };
      parts[p[1]].chunks[Number(p[2])] = p[4];
    }
  }
  for (const [k, v] of Object.entries(parts)) {
    const got = v.chunks.filter((c) => c !== undefined).length;
    if (got !== v.n) throw new Error(`LibreSprite の出力が欠けました: ${k}（${got}/${v.n}）`);
    results[k] = JSON.parse(v.chunks.join(''));
  }
  if (results.error) console.log(`LibreSprite のスクリプトのエラー: ${results.error}`);
  return results;
}

/** 型紙の __名前__ をすべて置き換える */
function fill(text, map) {
  for (const [k, v] of Object.entries(map)) text = text.split(k).join(v);
  return text;
}

function samePng(a, b) {
  return core.samePixels(a, b);
}

/**
 * 直さずに書き戻したときの見込みを Node の core で計算する:
 * エディタの見た目（ガイドと関節を除く合成）、書くファイル、分け直したあとの見えている所
 */
async function expectNoEdit(dir) {
  const opened = await openFolder(dir);
  const { width: w, height: h, order } = opened.info;
  const parts = {};
  const flat = core.blank(w, h);
  for (const l of opened.layers) {
    if (l.kind === 'part') parts[l.name] = l.image;
    if (!l.visible || l.kind === 'guide' || l.kind === 'joint') continue;
    for (let i = 0; i < w * h; i++) if (l.image.data[i * 4 + 3]) flat.data.set(l.image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  const plan = core.planSave(opened.info, opened.current, { parts });
  // 直す画素を選ぶ元: 2 枚の形は分け直したあとの見えている所、1 枚の形は <部位>.png そのもの
  const own = opened.info.format === 'one' ? opened.current.own : core.splitParts(order, parts, w, h).own;
  return { flat, files: plan.writes.map((x) => x.file).sort(), plan, own, format: opened.info.format };
}

/** ガイドを隠した合成が、部位を重ねた見込みの絵と同じか。立ち絵との違いも数で出す */
function checkFlat(flat, want, label) {
  check(samePng(flat, want.flat), `${label}: 読み込んだ直後の合成（ガイドを除く）が、部位（見えている所 + 隠れた所）を order の順に重ねた絵と同じ`, `違う画素 ${core.countDiff(flat, want.flat)}`);
  if (!existsSync(spritePath)) {
    console.log(`（立ち絵 ${spritePath} が無いので、立ち絵との比べは飛ばします）`);
    return;
  }
  const stand = refDecode(readFileSync(spritePath));
  const d = core.countDiff(flat, stand);
  // はみ出しの無い方向（直さずに書き戻して何も変わらない方向）では、立ち絵と同じはず
  // 1 枚の形は、order の順に重ねると手前の部位の描き足しが奥の部位の見えている所に被る所があり、立ち絵と少し違う（数だけ出す）
  if (want.format === 'one') console.log(`     ${label}: 立ち絵と違う画素 ${d}（1 枚の形: 手前の部位の描き足しが、奥の部位の見えている所に被る所）`);
  else if (!want.files.length) check(d === 0, `${label}: 立ち絵とも同じ`, `違う画素 ${d}`);
  else console.log(`     ${label}: 立ち絵と違う画素 ${d}（隠れた所の下書きが立ち絵の外へはみ出しているため）`);
}

/** 期待するレイヤーの並び。joints-drawn.json があれば、その関節のレイヤーが一番上に並ぶ */
function expectedLayers(order, dir) {
  const list = [['map', false, false]];
  for (const n of order) list.push([`guide:${n}`, true, false]);
  for (const n of order) list.push([n, true, true]);
  const drawn = join(dir, core.DRAWN_FILE);
  if (existsSync(drawn)) for (const j of Object.keys(JSON.parse(readFileSync(drawn, 'utf8')))) list.push([`joint:${j}`, true, true]);
  return list;
}

/** 作業のフォルダの全ファイルのバイト列 */
function snapshot(dir) {
  const m = new Map();
  for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) m.set(f, readFileSync(join(dir, f)));
  return m;
}

/** 直す画素: 直さずに書き戻したあと（分け直したあと）も、その部位の見えている所である画素 */
function pickEditPixel(want, layer) {
  const img = want.own[layer];
  if (!img) throw new Error(`部位 ${layer} がありません`);
  for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4 + 3]) return [i % img.width, Math.floor(i / img.width), img];
  throw new Error(`${layer} の見えている所に画素がありません`);
}

/** 書く予定の内訳（はみ出しのある方向で、どのファイルのどれだけの画素が動くか） */
function describePlan(plan) {
  return plan.writes.map((w) => describeWrite(w)).join(' / ');
}

function expectOneEdit(beforeImg, afterBytes, x, y, label) {
  const after = refDecode(afterBytes);
  const want = { width: beforeImg.width, height: beforeImg.height, data: new Uint8Array(beforeImg.data) };
  const o = (y * want.width + x) * 4;
  want.data.set([1, 2, 3, 255], o);
  check(after.width === want.width && after.height === want.height, `${label}: 大きさが変わらない`, `${after.width}×${after.height}`);
  check(core.samePixels(after, want), `${label}: 直した 1 画素だけが変わり、ほかの画素（位置・透明）は同じ`, `期待との違い ${core.countDiff(after, want)} 画素`);
}

async function modeAse() {
  console.log('\n== ase: CLI → LibreSprite → CLI ==');
  const dir = join(work, 'ase', basename(srcDir));
  cpSync(srcDir, dir, { recursive: true });
  const asePath = `${dir}.ase`;
  const cli = join(ROOT, 'cli/parts-ase.mjs');
  const want = await expectNoEdit(dir);
  const open = spawnSync(process.execPath, [cli, 'open', dir], { encoding: 'utf8' });
  check(open.status === 0, 'CLI open', open.stdout.trim() || open.stderr.trim());

  // 直さずに書き戻す（CLI が作った .ase のまま）。はみ出しの無い方向では何も書かない。
  // はみ出しのある方向では見込みのファイルだけを書く（以降の確かめは、書き戻したあとのフォルダを元にする）
  const s0 = spawnSync(process.execPath, [cli, 'save', asePath], { encoding: 'utf8' });
  if (!want.files.length) check(s0.status === 0 && /変わった部位・関節はありません/.test(s0.stdout), 'CLI save（直していない .ase）: 何も書かない', s0.stdout.trim());
  else {
    const wrote = [...s0.stdout.matchAll(/^書きます: (\S+?)（/gm)].map((m) => m[1]).sort();
    check(s0.status === 0 && JSON.stringify(wrote) === JSON.stringify(want.files), `CLI save（直していない .ase）: はみ出しの分け直しで ${want.files.length} ファイルを書く`, describePlan(want.plan));
  }
  const before = snapshot(dir);
  const editLayer = values['edit-layer'];
  const [ex, ey, editBefore] = pickEditPixel(want, editLayer);
  const flatPath = join(work, 'ase', 'flat.png');
  const editedPath = join(work, 'ase', 'edited.ase');
  const script = fill(readFileSync(join(HERE, 'roundtrip-ase.js'), 'utf8'), {
    __ASE__: asePath,
    __FLAT__: flatPath,
    __EDITED__: editedPath,
    __EDIT_LAYER__: editLayer,
    __EDIT_X__: String(ex),
    __EDIT_Y__: String(ey),
  });
  const scriptPath = join(work, 'ase', 'roundtrip-ase.run.js');
  writeFileSync(scriptPath, script);
  const r = runLibreSprite(scriptPath);
  check(r.opened === true, `LibreSprite（${r.version}）で .ase を開ける`);
  const order = core.readPartsJson(readFileSync(join(dir, 'parts.json'), 'utf8')).order;
  check(JSON.stringify(r.layers) === JSON.stringify(expectedLayers(order, dir)), 'レイヤーの名前・並び（奥 → 手前）・表示・編集の可否', `${r.layers?.length} レイヤー`);
  if (existsSync(flatPath)) checkFlat(refDecode(readFileSync(flatPath)), want, 'ase');
  else check(false, 'ガイドを隠した合成を PNG に書き出せる');

  // LibreSprite が保存した .ase（1 画素直したもの）から書き戻す
  const s1 = spawnSync(process.execPath, [cli, 'save', editedPath, '--dir', dir], { encoding: 'utf8' });
  check(s1.status === 0, 'CLI save（LibreSprite が保存した .ase）', s1.stdout.trim() || s1.stderr.trim());
  const after = snapshot(dir);
  const changed = [...after.keys()].filter((f) => !before.get(f)?.equals(after.get(f)));
  check(JSON.stringify(changed) === JSON.stringify([`${editLayer}.png`]), '書き換わったファイルは直した部位の PNG だけ（ほかはバイト列まで同じ）', changed.join(', '));
  if (after.get(`${editLayer}.png`)) expectOneEdit(editBefore, after.get(`${editLayer}.png`), ex, ey, 'ase');

  // 書き戻した PNG を LibreSprite でも開けるか（開いて PNG に書き直し、画素を比べる）
  const reread = join(work, 'ase', 'reread.png');
  spawnSync(values.libresprite, ['-b', join(dir, `${editLayer}.png`), '--save-as', reread], { encoding: 'utf8', timeout: 120000 });
  check(existsSync(reread) && core.samePixels(refDecode(readFileSync(reread)), refDecode(after.get(`${editLayer}.png`))), 'このスクリプトの書いた PNG を LibreSprite で開いて同じ画素');
}

async function modeInapp() {
  console.log('\n== inapp: parts-editor.js を LibreSprite の中で（fs は記憶の中の模擬） ==');
  const memDir = `/mem/${basename(srcDir)}`;
  const files = {};
  for (const f of readdirSync(srcDir)) if (statSync(join(srcDir, f)).isFile()) files[`${memDir}/${f}`] = readFileSync(join(srcDir, f)).toString('base64');
  const editLayer = values['edit-layer'];
  const want = await expectNoEdit(srcDir);
  const [ex, ey, editBefore] = pickEditPixel(want, editLayer);
  // 権限の宣言（///permission）は外す: 本物の fs を使わないので要らない
  const editor = readFileSync(join(ROOT, 'parts-editor.js'), 'utf8').replace(/^\/\/\/permission.*$/gm, '');
  const script = [
    fill(readFileSync(join(HERE, 'memfs-prelude.js'), 'utf8'), { __FILES__: JSON.stringify(files) }),
    editor,
    fill(readFileSync(join(HERE, 'inapp-driver.js'), 'utf8'), {
      __DIR__: JSON.stringify(memDir),
      __EDIT_LAYER__: JSON.stringify(editLayer),
      __EDIT_X__: String(ex),
      __EDIT_Y__: String(ey),
    }),
  ].join('\n;\n');
  const scriptPath = join(work, 'inapp.run.js');
  writeFileSync(scriptPath, script);
  const r = runLibreSprite(scriptPath);
  check(r.done === true && !r.error, `LibreSprite（${r.version}）で parts-editor.js の読み込み・書き戻しが通る`);
  if (!r.layers) return;
  const order = core.readPartsJson(readFileSync(join(srcDir, 'parts.json'), 'utf8')).order;
  check(JSON.stringify(r.layers) === JSON.stringify(expectedLayers(order, srcDir)), 'レイヤーの名前・並び（奥 → 手前）・表示・編集の可否', `${r.layers.length} レイヤー`);
  check(JSON.stringify(r.size) === JSON.stringify([editBefore.width, editBefore.height, 0]), '絵の大きさと色の形（RGB）', JSON.stringify(r.size));
  checkFlat(core.decodePng(Buffer.from(r.flatPng, 'base64')), want, 'inapp');
  const noEdit = Array.isArray(r.writesNoEdit) ? r.writesNoEdit.map((p) => p.slice(memDir.length + 1)).sort() : null;
  if (!want.files.length) check(noEdit && noEdit.length === 0, '直さずに書き戻す: 何も書かない', JSON.stringify(r.writesNoEdit));
  else check(JSON.stringify(noEdit) === JSON.stringify(want.files), `直さずに書き戻す: はみ出しの分け直しで ${want.files.length} ファイルを書く（Node の見込みと同じ）`, JSON.stringify(noEdit));
  check(JSON.stringify(r.toggleGuide) === '[false,true]' && JSON.stringify(r.toggleMap) === '[true,false]', '表示の切り替え（ガイド・map）', JSON.stringify([r.toggleGuide, r.toggleMap]));
  check(r.toggleHidden === null, '隠れた所の切り替えは無い（toggle("hidden") は対象なし）', JSON.stringify(r.toggleHidden));
  const w = r.writesEdit ?? [];
  check(w.length === 1 && w[0][0] === `${memDir}/${editLayer}.png`, '1 画素直して書き戻す: 直した部位の PNG だけを書く', JSON.stringify(w.map((x) => x[0])));
  if (w[0]) {
    const bytes = Buffer.from(w[0][1], 'base64');
    writeFileSync(join(work, `inapp-${editLayer}.png`), bytes);
    expectOneEdit(editBefore, bytes, ex, ey, 'inapp');
  }
  console.log(`窓に出る文: ${JSON.stringify(r.logs)}`);
}

if (values.mode === 'ase' || values.mode === 'both') await modeAse();
if (values.mode === 'inapp' || values.mode === 'both') await modeInapp();
console.log(`\n作業のフォルダ: ${work}`);
console.log(failures ? `NG: ${failures} 件` : 'すべて OK');
process.exit(failures ? 1 : 0);
