// 絵の上の関節（joints-drawn.json）を、関節ごとのレイヤー（joint:<関節>）にして動かし、書き戻すことを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAse, writeAse } from '../lib/ase.mjs';
import { aseBytes, editedFromAse, nodeIo, openFolder } from '../cli/parts-ase.mjs';
import { GRID, MAP_COLORS, makeFixtureDir } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');
const CLI = fileURLToPath(new URL('../cli/parts-ase.mjs', import.meta.url));

/** 小数の値と、x/y 以外のキーも残ることを確かめるための joints-drawn.json */
const DRAWN = { Head: { x: 16.1, y: 11.9 }, LeftArm: { x: 10.45, y: 13.5, note: 'keep' } };

function fixture() {
  const fx = makeFixtureDir('jt', { one: true });
  writeFileSync(join(fx.dir, 'joints-drawn.json'), JSON.stringify(DRAWN, null, 2) + '\n');
  return fx;
}
const snapshot = (dir) => new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]));
const changedFiles = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((f) => !a.get(f)?.equals(b.get(f) ?? Buffer.alloc(0))).sort();
const layer = (opened, name) => opened.layers.find((l) => l.name === name).image;
const opaque = (img) => {
  const out = [];
  for (let i = 0; i < GRID * GRID; i++) if (img.data[i * 4 + 3] === 255) out.push([i % GRID, Math.floor(i / GRID)]);
  return out;
};
const setPx = (img, x, y, rgba) => img.data.set(rgba, (y * GRID + x) * 4);
const planOf = (opened) =>
  core.planSave(opened.info, opened.current, editedFromAse(readAse(writeAse({ width: GRID, height: GRID, layers: opened.layers })), opened.info));

test('関節: joints-drawn.json があると、部位の上に関節ごとのレイヤーができる。点は関節の入っている画素（切り捨て）に 1 つ、色はその関節を root に持つ部位の色', async () => {
  const { dir } = fixture();
  const opened = await openFolder(dir);
  const names = opened.layers.map((l) => l.name);
  assert.deepEqual(names.slice(-2), ['joint:Head', 'joint:LeftArm']);
  assert.ok(names.indexOf('joint:Head') > names.indexOf('head'));
  assert.deepEqual(opaque(layer(opened, 'joint:Head')), [[16, 11]]);
  assert.deepEqual(opaque(layer(opened, 'joint:LeftArm')), [[10, 13]]);
  const arm = layer(opened, 'joint:LeftArm');
  assert.deepEqual([...arm.data.subarray((13 * GRID + 10) * 4, (13 * GRID + 10) * 4 + 4)], [...MAP_COLORS['arm-l'], 255]);
  // 上下左右は薄い印（書き戻しでは読まない）
  assert.equal(arm.data[(13 * GRID + 11) * 4 + 3], core.DRAWN_RING_ALPHA);
  for (const l of opened.layers.filter((l) => l.kind === 'joint')) assert.deepEqual([l.visible, l.editable], [true, true]);
});

test('関節: 動かさなければ何も書かない（小数の値はそのまま。CLI の check も 0）', async () => {
  const { dir } = fixture();
  const opened = await openFolder(dir);
  const plan = planOf(opened);
  assert.deepEqual(plan.writes, []);
  assert.deepEqual(plan.notes, []);
  const r = spawnSync(process.execPath, [CLI, 'check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('関節: 点を動かすと、その関節だけを画素の真ん中（i + 0.5）にして joints-drawn.json を書く。ほかの関節・キーの並び・部位の PNG は変えない', async () => {
  const { dir } = fixture();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  const img = layer(opened, 'joint:LeftArm');
  img.data.fill(0);
  setPx(img, 9, 15, [1, 2, 3, 255]);
  const plan = planOf(opened);
  assert.deepEqual(plan.notes, []);
  assert.deepEqual(
    plan.writes.map((w) => [w.file, w.kind, w.joints]),
    [['joints-drawn.json', 'joints', [{ name: 'LeftArm', from: { x: 10.45, y: 13.5 }, to: { x: 9.5, y: 15.5 } }]]]
  );
  await core.writePlan(nodeIo, dir, plan);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['joints-drawn.json']);
  const text = after.get('joints-drawn.json').toString('utf8');
  assert.equal(text, JSON.stringify({ Head: DRAWN.Head, LeftArm: { x: 9.5, y: 15.5, note: 'keep' } }, null, 2) + '\n');
});

test('関節: 元の点を消し忘れて新しい点を打っても、新しい点へ動いたと読む。迷う形（点が 2 つ以上・点が無い・レイヤーが無い）は書かずに知らせる', async () => {
  const { dir } = fixture();
  const opened = await openFolder(dir);
  setPx(layer(opened, 'joint:Head'), 20, 3, [9, 9, 9, 255]);
  let plan = planOf(opened);
  assert.deepEqual(plan.writes.find((w) => w.kind === 'joints').joints.map((m) => [m.name, m.to]), [['Head', { x: 20.5, y: 3.5 }]]);

  setPx(layer(opened, 'joint:Head'), 21, 3, [9, 9, 9, 255]);
  layer(opened, 'joint:LeftArm').data.fill(0);
  plan = planOf(opened);
  assert.ok(!plan.writes.some((w) => w.kind === 'joints'));
  assert.ok(plan.notes.includes('joint Head has 3 opaque px, left as is (keep one)'));
  assert.ok(plan.notes.includes('joint LeftArm has no opaque px, left as is'));

  const ase = readAse(writeAse({ width: GRID, height: GRID, layers: opened.layers.filter((l) => l.kind !== 'joint') }));
  plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.notes, ['joint layer not found, left as is: Head', 'joint layer not found, left as is: LeftArm']);
});

test('関節: CLI の save で .ase から書き戻す（--dry-run は書かない）。joints-drawn.json の無いフォルダは関節のレイヤーを作らない', async () => {
  const { root, dir } = fixture();
  const opened = await openFolder(dir);
  const img = layer(opened, 'joint:Head');
  img.data.fill(0);
  setPx(img, 17, 10, [5, 5, 5, 255]);
  const asePath = join(root, 'jt-parts.ase');
  writeFileSync(asePath, aseBytes(opened));
  const before = snapshot(dir);
  let r = spawnSync(process.execPath, [CLI, 'save', asePath, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /書く予定: joints-drawn.json（関節 1: Head 16.1,11.9 → 17.5,10.5）/);
  assert.deepEqual(changedFiles(before, snapshot(dir)), []);
  r = spawnSync(process.execPath, [CLI, 'save', asePath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(changedFiles(before, snapshot(dir)), ['joints-drawn.json']);

  const plain = await openFolder(makeFixtureDir('np', { one: true }).dir);
  assert.ok(!plain.layers.some((l) => l.kind === 'joint'));
});

test('関節: 左右対称の値（中心 x = 16 から ±2.36）は、画素でも左右対称に置く（四捨五入だと片側だけ 1 画素ずれる）', async () => {
  const fx = makeFixtureDir('sym', { one: true });
  writeFileSync(join(fx.dir, 'joints-drawn.json'), JSON.stringify({ Head: { x: 18.36, y: 20.5 }, LeftArm: { x: 13.64, y: 20.5 } }, null, 2) + '\n');
  const opened = await openFolder(fx.dir);
  const [[a]] = opaque(layer(opened, 'joint:Head'));
  const [[b]] = opaque(layer(opened, 'joint:LeftArm'));
  // 画素 i の鏡は 31 - i（32 画素の絵の真ん中は 16.0）
  assert.equal(a + b, GRID - 1);
});
