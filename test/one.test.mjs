// 1 枚の形（heosterra の 2026-11-25 から: <部位>.png が見えている所＋隠れた所の 1 枚。.hidden.png は無い。
// 見えている所は map.png で決まる）の読み込み・書き戻しを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAse, writeAse } from '../lib/ase.mjs';
import { decodePng as refDecode, encodePng as refEncode } from '../lib/png.mjs';
import { aseBytes, editedFromAse, nodeIo, openFolder } from '../cli/parts-ase.mjs';
import { GRID, MAP_COLORS, ORDER, makeFixtureDir } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');
const CLI = fileURLToPath(new URL('../cli/parts-ase.mjs', import.meta.url));

const snapshot = (dir) => new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]));
const changedFiles = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((f) => !a.get(f)?.equals(b.get(f) ?? Buffer.alloc(0))).sort();
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const planOf = (opened, layers = opened.layers) =>
  core.planSave(opened.info, opened.current, editedFromAse(readAse(writeAse({ width: GRID, height: GRID, layers })), opened.info));

test('1 枚の形: .hidden.png が 1 つも無いフォルダは 1 枚の形。部位のレイヤーは <部位>.png そのまま、並びは map・ガイドが一番下', async () => {
  assert.equal(core.folderFormat(['a.png', 'map.png', 'parts.json']), 'one');
  assert.equal(core.folderFormat(['a.png', 'a.hidden.png', 'map.png', 'parts.json']), 'split');
  const { dir, imgs } = makeFixtureDir('one', { one: true });
  const opened = await openFolder(dir);
  assert.equal(opened.info.format, 'one');
  assert.deepEqual(
    opened.layers.map((l) => [l.name, l.visible, l.editable]),
    [
      ['map', false, false],
      ['guide:arm-l', true, false],
      ['guide:torso', true, false],
      ['guide:head', true, false],
      ['arm-l', true, true],
      ['torso', true, true],
      ['head', true, true],
    ]
  );
  for (const n of ORDER) assert.ok(core.samePixels(opened.layers.find((l) => l.name === n).image, imgs.full[n]), n);
});

test('1 枚の形: 直さずに書き戻すと何も書かない（CLI の check も 0 で終わる）', async () => {
  const { dir } = makeFixtureDir('one', { one: true });
  const opened = await openFolder(dir);
  const plan = planOf(opened);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.notes, []);
  const r = spawnSync(process.execPath, [CLI, 'check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /部位のフォルダの形: 1 枚/);
});

test('1 枚の形: 隠れた所を直すと <部位>.png だけを書く。分け直さず、.hidden.png も map.png も書かない', async () => {
  const { dir, imgs } = makeFixtureDir('one', { one: true });
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  // 腕の (12, 20) は胴に隠れた所（map では胴）。腕と胴の両方の絵に画素がある所でも、分け直さない
  const arm = opened.layers.find((l) => l.name === 'arm-l').image;
  arm.data.set([9, 9, 9, 255], (20 * GRID + 12) * 4);
  const plan = planOf(opened);
  assert.deepEqual(
    plan.writes.map((w) => [w.file, w.diff, w.visibleDiff]),
    [['arm-l.png', 1, 0]]
  );
  assert.deepEqual(plan.notes, []);
  await core.writePlan(nodeIo, dir, plan);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['arm-l.png']);
  const want = { width: GRID, height: GRID, data: new Uint8Array(imgs.full['arm-l'].data) };
  want.data.set([9, 9, 9, 255], (20 * GRID + 12) * 4);
  assert.ok(core.samePixels(refDecode(after.get('arm-l.png')), want));
  // 胴の絵は前のまま（胴の見えている所も変わらない）
  assert.ok(after.get('torso.png').equals(before.get('torso.png')));
});

test('1 枚の形: 見えている所（map.png の部位のマス）を直すと、数えて知らせる（map.png は書かない）', async () => {
  const { dir } = makeFixtureDir('one', { one: true });
  const opened = await openFolder(dir);
  const head = opened.layers.find((l) => l.name === 'head').image;
  head.data.set([1, 2, 3, 255], (7 * GRID + 16) * 4);
  const plan = planOf(opened);
  assert.deepEqual(
    plan.writes.map((w) => [w.file, w.diff, w.visibleDiff]),
    [['head.png', 1, 1]]
  );
  assert.ok(plan.notes.some((n) => n.startsWith('1 px changed in visible cells (map.png)')));
  assert.ok(!plan.writes.some((w) => w.file === 'map.png'));
});

test('1 枚の形: ガイドは map.png の見えている所と部位の絵から引く（見えている所に接する輪は線、隠れた所にだけ接する輪は点）', async () => {
  const { dir } = makeFixtureDir('one', { one: true });
  const opened = await openFolder(dir);
  const guide = opened.layers.find((l) => l.name === 'guide:arm-l').image;
  const color = MAP_COLORS['arm-l'];
  for (let y = 13; y <= 26; y++) assert.deepEqual(px(guide, 7, y), [...color, core.GUIDE_ALPHA], `y=${y}`);
  for (let y = 14; y <= 23; y++) {
    const p = px(guide, 14, y);
    if ((14 + y) % 2) assert.equal(p[3], 0, `y=${y}`);
    else assert.deepEqual(p, [...color, core.GUIDE_ALPHA], `y=${y}`);
  }
});

test('1 枚の形: レイヤーの無い部位は書かずに知らせる。前の形の .ase（<部位>.hidden のレイヤー）も 1 枚に寄せて読む', async () => {
  const { dir } = makeFixtureDir('one', { one: true });
  const opened = await openFolder(dir);
  const plan = planOf(
    opened,
    opened.layers.filter((l) => l.name !== 'head')
  );
  assert.deepEqual(plan.writes, []);
  assert.ok(plan.notes.includes('layer not found, file left as is: head.png'));
  // 前の形: 部位の絵を、map で見えている所（<部位>）とそれ以外（<部位>.hidden）の 2 枚にしたもの
  const colors = core.partColors(ORDER, opened.current.own, opened.current.map, true);
  const s = core.splitByMap(ORDER, opened.current.own, opened.current.map, colors, GRID, GRID);
  const legacy = [];
  for (const n of ORDER) {
    legacy.push({ name: `${n}.hidden`, image: s.rest[n], visible: false, editable: true });
    legacy.push({ name: n, image: s.visible[n], visible: true, editable: true });
  }
  const plan2 = planOf(opened, legacy);
  assert.deepEqual(plan2.writes, []);
  assert.ok(plan2.notes.some((n) => n.startsWith('old layout: merged 3 ')));
});

test('救い方: 前の道具に分けられたフォルダ（.hidden.png が作られた）から開いた .ase を、git で戻して .hidden.png を消した 1 枚の形へ書き戻すと、直した部位だけが変わる', async () => {
  const { root, dir, imgs } = makeFixtureDir('one', { one: true });
  const before = snapshot(dir);
  // 前の道具の save と同じ分け方（order で一番手前が見えている所、奥は隠れた所）で分けたフォルダ
  const polluted = join(root, 'polluted-parts');
  mkdirSync(polluted);
  const split = core.splitParts(ORDER, imgs.full, GRID, GRID);
  for (const n of ORDER) {
    writeFileSync(join(polluted, `${n}.png`), refEncode(split.own[n]));
    writeFileSync(join(polluted, `${n}.hidden.png`), refEncode(split.hidden[n]));
  }
  writeFileSync(join(polluted, 'map.png'), readFileSync(join(dir, 'map.png')));
  writeFileSync(join(polluted, 'parts.json'), readFileSync(join(dir, 'parts.json')));
  const old = await openFolder(polluted);
  assert.equal(old.info.format, 'split');
  // そのフォルダから開いた .ase（部位のレイヤーは重ねた 1 枚＝元の 1 枚の絵）に手直しを入れる
  const torso = old.layers.find((l) => l.name === 'torso').image;
  torso.data.set([1, 2, 3, 255], (13 * GRID + 12) * 4);
  const asePath = join(root, 'polluted.ase');
  writeFileSync(asePath, aseBytes(old));
  // 1 枚の形のフォルダ（git で戻し、.hidden.png を消したもの）へ書き戻す
  const r = spawnSync(process.execPath, [CLI, 'save', asePath, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['torso.png']);
  const want = { width: GRID, height: GRID, data: new Uint8Array(imgs.full.torso.data) };
  want.data.set([1, 2, 3, 255], (13 * GRID + 12) * 4);
  assert.ok(core.samePixels(refDecode(after.get('torso.png')), want));
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.hidden.png')));
});
