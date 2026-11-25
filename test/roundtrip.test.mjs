// 読み込み → 直す → 書き戻しの往復を、合成の部位のフォルダで確かめる。
// 画素を直していない所で、PNG の大きさ・位置・透明が変わらないこと、直していないファイルはバイト列まで変わらないこと。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAse, writeAse } from '../lib/ase.mjs';
import { decodePng as refDecode } from '../lib/png.mjs';
import { aseBytes, editedFromAse, nodeIo, openFolder } from '../cli/parts-ase.mjs';
import { GRID, MAP_COLORS, ORDER, makeFixtureDir } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');
const CLI = fileURLToPath(new URL('../cli/parts-ase.mjs', import.meta.url));

const snapshot = (dir) => new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]));
const changedFiles = (a, b) => [...b.keys()].filter((f) => !a.get(f)?.equals(b.get(f))).sort();
const clone = (img) => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('レイヤーの並び: 奥 → 手前に「隠れた所・部位」、その上に map とガイド。読み込んだ直後の合成は立ち絵と同じ', async () => {
  const { dir, imgs } = makeFixtureDir();
  const opened = await openFolder(dir);
  const names = opened.layers.map((l) => [l.name, l.visible, l.editable]);
  assert.deepEqual(names, [
    ['arm-l.hidden', false, true],
    ['arm-l', true, true],
    ['torso.hidden', false, true],
    ['torso', true, true],
    ['head.hidden', false, true],
    ['head', true, true],
    ['map', false, false],
    ['guide:arm-l', true, false],
    ['guide:torso', true, false],
    ['guide:head', true, false],
  ]);
  // 見えているレイヤーのうちガイド以外を下から重ねる
  const flat = core.blank(GRID, GRID);
  for (const l of opened.layers) {
    if (!l.visible || l.kind === 'guide') continue;
    for (let i = 0; i < GRID * GRID; i++) if (l.image.data[i * 4 + 3]) flat.data.set(l.image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  assert.ok(core.samePixels(flat, imgs.sprite));
});

test('ガイド: 部位の形（隠れた所も含む）の縁を部位の色で引き、隠れた所は 1 つおきの点、関節は不透明の点', async () => {
  const { dir, imgs } = makeFixtureDir();
  const opened = await openFolder(dir);
  const guide = opened.layers.find((l) => l.name === 'guide:arm-l').image;
  const color = MAP_COLORS['arm-l'];
  // 腕の左の縁（x = 8）は見えている所 → 線（途切れない）
  for (let y = 14; y <= 25; y++) assert.deepEqual(px(guide, 8, y), [...color, core.GUIDE_ALPHA], `y=${y}`);
  // 腕の右の縁（x = 13）は胴に隠れた所 → 1 つおき
  for (let y = 14; y <= 23; y++) {
    const p = px(guide, 13, y);
    if ((13 + y) % 2) assert.equal(p[3], 0, `y=${y}`);
    else assert.deepEqual(p, [...color, core.GUIDE_ALPHA], `y=${y}`);
  }
  // 中は引かない
  assert.equal(px(guide, 10, 20)[3], 0);
  // 関節（LeftArm 10.5, 13.5 → 10, 13）は不透明
  assert.deepEqual(px(guide, 10, 13), [...color, 255]);
  // 隠れた所のレイヤーは hidden.png のまま
  assert.ok(core.samePixels(opened.layers.find((l) => l.name === 'arm-l.hidden').image, imgs.hidden['arm-l']));
});

test('直さずに書き戻す: 何も書かない（CLI の check も 0 で終わる）', async () => {
  const { dir } = makeFixtureDir();
  const opened = await openFolder(dir);
  const ase = readAse(aseBytes(opened));
  const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.notes, []);
  const r = spawnSync(process.execPath, [CLI, 'check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('1 画素直す: 直した部位の PNG だけを書き、ほかのファイルはバイト列まで同じ。直した所以外の画素も同じ', async () => {
  const { dir, root } = makeFixtureDir();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  const head = opened.layers.find((l) => l.name === 'head');
  head.image.data.set([1, 2, 3, 255], (7 * GRID + 16) * 4);
  const asePath = join(root, 'edited.ase');
  writeFileSync(asePath, aseBytes(opened));
  const r = spawnSync(process.execPath, [CLI, 'save', asePath, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['head.png']);
  const want = clone(refDecode(before.get('head.png')));
  want.data.set([1, 2, 3, 255], (7 * GRID + 16) * 4);
  const got = refDecode(after.get('head.png'));
  assert.equal(got.width, GRID);
  assert.equal(got.height, GRID);
  assert.ok(core.samePixels(got, want));
  assert.equal(core.countDiff(got, refDecode(before.get('head.png'))), 1);
});

test('隠れた所のレイヤーを直す: <部位>.hidden.png だけを書く', async () => {
  const { dir } = makeFixtureDir();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  const hidden = opened.layers.find((l) => l.name === 'arm-l.hidden');
  hidden.image.data.set([9, 9, 9, 255], (20 * GRID + 12) * 4);
  const plan = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info));
  await core.writePlan(nodeIo, dir, plan);
  assert.deepEqual(changedFiles(before, snapshot(dir)), ['arm-l.hidden.png']);
});

test('画素を別の部位へ移す: 2 つの部位の PNG と map.png を書き、map はその画素を移した先の部位の色にする', async () => {
  const { dir } = makeFixtureDir();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  const torso = opened.layers.find((l) => l.name === 'torso').image;
  const head = opened.layers.find((l) => l.name === 'head').image;
  // 胴の (16, 14) を頭へ移す
  const o = (14 * GRID + 16) * 4;
  head.data.set(torso.data.subarray(o, o + 4), o);
  torso.data.set([0, 0, 0, 0], o);
  const plan = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info));
  assert.deepEqual(plan.writes.map((w) => w.file).sort(), ['head.png', 'map.png', 'torso.png']);
  await core.writePlan(nodeIo, dir, plan);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['head.png', 'map.png', 'torso.png']);
  const map = refDecode(after.get('map.png'));
  assert.deepEqual(px(map, 16, 14), [...MAP_COLORS.head, 255]);
  assert.equal(core.countDiff(map, refDecode(before.get('map.png'))), 1);
  // --no-map なら map は書かない
  const plan2 = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info), { updateMap: false });
  assert.ok(!plan2.writes.some((w) => w.file === 'map.png'));
});

test('レイヤーが消えた部位は書かず、知らせる。重なった画素も知らせる', async () => {
  const { dir } = makeFixtureDir();
  const opened = await openFolder(dir);
  const layers = opened.layers.filter((l) => l.name !== 'head');
  // 胴の画素を腕にも描く（見えている所の重なり）
  const arm = layers.find((l) => l.name === 'arm-l').image;
  const torso = layers.find((l) => l.name === 'torso').image;
  const o = (18 * GRID + 16) * 4;
  arm.data.set(torso.data.subarray(o, o + 4), o);
  const ase = readAse(writeAse({ width: GRID, height: GRID, layers }));
  const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.writes.map((w) => w.file), ['arm-l.png']);
  assert.ok(plan.notes.some((n) => n.includes('head.png')));
  assert.ok(plan.notes.some((n) => n.includes('1 px are visible in 2+ part layers')));
});

test('.ase: LibreSprite が詰めた cel（位置のずれた小さい cel）も、絵の大きさに戻して読む', async () => {
  const { dir } = makeFixtureDir();
  const opened = await openFolder(dir);
  // 頭のレイヤーを、画素のある所だけの cel にして書く
  const layers = opened.layers.map((l) => {
    if (l.name !== 'head') return l;
    let x0 = GRID;
    let y0 = GRID;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++)
        if (l.image.data[(y * GRID + x) * 4 + 3]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) data.set(l.image.data.subarray(((y0 + y) * GRID + x0) * 4, ((y0 + y) * GRID + x0 + w) * 4), y * w * 4);
    return { ...l, cel: { x: x0, y: y0, width: w, height: h, data } };
  });
  const ase = readAse(writeAse({ width: GRID, height: GRID, layers }));
  const head = ase.layers.find((l) => l.name === 'head');
  assert.ok(core.samePixels(head.image, opened.current.own.head));
  const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.writes, []);
});

test('CLI open: 既定の置き場はフォルダの隣の <フォルダ名>.ase。save は .ase の名前からフォルダを決める', () => {
  const { dir, root } = makeFixtureDir('def');
  const before = snapshot(dir);
  const r = spawnSync(process.execPath, [CLI, 'open', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const asePath = join(root, 'def-parts.ase');
  assert.ok(existsSync(asePath));
  assert.deepEqual(changedFiles(before, snapshot(dir)), []);
  const s = spawnSync(process.execPath, [CLI, 'save', asePath], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stdout + s.stderr);
  assert.match(s.stdout, /変わった部位はありません/);
  assert.deepEqual(changedFiles(before, snapshot(dir)), []);
});

test('json: order に無い部位は最後（手前）に足す。order が無ければ parts の順', () => {
  const a = core.readPartsJson(JSON.stringify({ parts: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], order: ['b', 'x', 'a'] }));
  assert.deepEqual(a.order, ['b', 'a', 'c']);
  const b = core.readPartsJson(JSON.stringify({ parts: [{ name: 'a' }, { name: 'b' }] }));
  assert.deepEqual(b.order, ['a', 'b']);
  assert.throws(() => core.readPartsJson(JSON.stringify({ parts: [{ name: 'a' }], order: ['a', 'a'] })));
  assert.equal(core.pickJson(['a.png', 'parts.json', 'x.json']), 'parts.json');
  assert.equal(core.pickJson(['a.png', 'only.json']), 'only.json');
  assert.throws(() => core.pickJson(['a.json', 'b.json']));
  assert.deepEqual(ORDER, ['arm-l', 'torso', 'head']);
});
