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
import { GRID, MAP_COLORS, ORDER, PROTRUDE, makeFixtureDir } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { core } = require('../parts-editor.js');
const CLI = fileURLToPath(new URL('../cli/parts-ase.mjs', import.meta.url));

const snapshot = (dir) => new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f))]));
const changedFiles = (a, b) => [...b.keys()].filter((f) => !a.get(f)?.equals(b.get(f))).sort();
const clone = (img) => ({ width: img.width, height: img.height, data: new Uint8Array(img.data) });
const px = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

/** 見えているレイヤーのうちガイド以外を下から重ねる（エディタで見える絵） */
function flatten(layers) {
  const flat = core.blank(GRID, GRID);
  for (const l of layers) {
    if (!l.visible || l.kind === 'guide') continue;
    for (let i = 0; i < GRID * GRID; i++) if (l.image.data[i * 4 + 3]) flat.data.set(l.image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return flat;
}

/** 部位の PNG（見えている所）を全部合わせた絵 */
function unionOwn(dir) {
  const out = core.blank(GRID, GRID);
  for (const n of ORDER) {
    const img = refDecode(readFileSync(join(dir, `${n}.png`)));
    for (let i = 0; i < GRID * GRID; i++) if (img.data[i * 4 + 3]) out.data.set(img.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return out;
}

/** 前の形（v0.1）のレイヤー: 部位ごとに <部位>.hidden と <部位> の 2 枚、その上に map とガイド */
function legacyLayers(opened) {
  const layers = [];
  for (const n of ORDER) {
    layers.push({ name: `${n}.hidden`, image: opened.current.hidden[n], visible: false, editable: true });
    layers.push({ name: n, image: opened.current.own[n], visible: true, editable: true });
  }
  for (const l of opened.layers) if (l.kind !== 'part') layers.push(l);
  return layers;
}

test('レイヤーの並び: 一番下に map とガイド、その上に部位ごとに 1 枚（奥 → 手前）。<部位>.hidden のレイヤーは無い', async () => {
  const { dir, imgs } = makeFixtureDir();
  const opened = await openFolder(dir);
  const names = opened.layers.map((l) => [l.name, l.visible, l.editable]);
  assert.deepEqual(names, [
    ['map', false, false],
    ['guide:arm-l', true, false],
    ['guide:torso', true, false],
    ['guide:head', true, false],
    ['arm-l', true, true],
    ['torso', true, true],
    ['head', true, true],
  ]);
  // 部位のレイヤーは、隠れた所の上に見えている所を重ねたもの
  for (const n of ORDER) {
    const layer = opened.layers.find((l) => l.name === n).image;
    for (let i = 0; i < GRID * GRID; i++) {
      const src = imgs.own[n].data[i * 4 + 3] ? imgs.own[n] : imgs.hidden[n];
      assert.deepEqual([...layer.data.subarray(i * 4, i * 4 + 4)], [...src.data.subarray(i * 4, i * 4 + 4)], `${n} ${i}`);
    }
  }
  // 隠れた所がはみ出していなければ、読み込んだ直後の見た目は立ち絵と同じ
  assert.ok(core.samePixels(flatten(opened.layers), imgs.sprite));
});

test('ガイド: 部位の形（隠れた所も含む）の 1 画素外側の輪を部位の色で引き、隠れた所に接する所は 1 つおきの点、関節は不透明の点', async () => {
  const { dir, imgs } = makeFixtureDir();
  const opened = await openFolder(dir);
  const guide = opened.layers.find((l) => l.name === 'guide:arm-l').image;
  const color = MAP_COLORS['arm-l'];
  // 腕の左の縁（x = 8）は見えている所 → その外（x = 7）に線（途切れない）
  for (let y = 13; y <= 26; y++) assert.deepEqual(px(guide, 7, y), [...color, core.GUIDE_ALPHA], `y=${y}`);
  // 腕の右の縁（x = 13）は胴に隠れた所 → その外（x = 14）に 1 つおき
  for (let y = 14; y <= 23; y++) {
    const p = px(guide, 14, y);
    if ((14 + y) % 2) assert.equal(p[3], 0, `y=${y}`);
    else assert.deepEqual(p, [...color, core.GUIDE_ALPHA], `y=${y}`);
  }
  // 形の縁と中は引かない（部位の画素の下で隠れてしまうため）
  assert.equal(px(guide, 8, 20)[3], 0);
  assert.equal(px(guide, 10, 20)[3], 0);
  // ガイドは部位のレイヤーの下だが、形の外の輪なので、読み込んだ直後の見た目（ガイドも重ねる）でも見える
  const all = core.blank(GRID, GRID);
  for (const l of opened.layers) {
    if (!l.visible) continue;
    for (let i = 0; i < GRID * GRID; i++) if (l.image.data[i * 4 + 3]) all.data.set(l.image.data.subarray(i * 4, i * 4 + 4), i * 4);
  }
  assert.deepEqual(px(all, 7, 20), [...color, core.GUIDE_ALPHA]);
  // 部位の画素の上には被らない
  assert.deepEqual(px(all, 8, 20), px(imgs.own['arm-l'], 8, 20));
  // 関節（LeftArm 10.5, 13.5 → 10, 13）は不透明
  assert.deepEqual(px(guide, 10, 13), [...color, 255]);
  // 胴に隠れた腕の画素も、腕のレイヤーに入っている
  assert.equal(imgs.own['arm-l'].data[(20 * GRID + 12) * 4 + 3], 0);
  assert.deepEqual(px(opened.layers.find((l) => l.name === 'arm-l').image, 12, 20), px(imgs.hidden['arm-l'], 12, 20));
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

test('手前の部位に隠れた画素を直す: <部位>.hidden.png だけを書く', async () => {
  const { dir } = makeFixtureDir();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  // 腕の (12, 20) は胴に隠れている
  const arm = opened.layers.find((l) => l.name === 'arm-l');
  arm.image.data.set([9, 9, 9, 255], (20 * GRID + 12) * 4);
  const plan = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info));
  await core.writePlan(nodeIo, dir, plan);
  const after = snapshot(dir);
  assert.deepEqual(changedFiles(before, after), ['arm-l.hidden.png']);
  assert.deepEqual(px(refDecode(after.get('arm-l.hidden.png')), 12, 20), [9, 9, 9, 255]);
});

test('手前の部位を消す: 奥の部位の隠れた所が見えている所へ移り、保存後の見えている所を全部合わせるとエディタの見た目と同じ', async () => {
  const { dir } = makeFixtureDir();
  const before = snapshot(dir);
  const opened = await openFolder(dir);
  // 胴の (12, 20) を消す → その下の腕の画素が見えるようになる
  const torso = opened.layers.find((l) => l.name === 'torso').image;
  torso.data.set([0, 0, 0, 0], (20 * GRID + 12) * 4);
  const plan = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info));
  assert.deepEqual(plan.writes.map((w) => w.file).sort(), ['arm-l.hidden.png', 'arm-l.png', 'map.png', 'torso.png']);
  const armHidden = plan.writes.find((w) => w.file === 'arm-l.hidden.png');
  assert.equal(armHidden.diff, 1);
  assert.equal(armHidden.toOwn, 1);
  await core.writePlan(nodeIo, dir, plan);
  const after = snapshot(dir);
  assert.deepEqual(px(refDecode(after.get('arm-l.png')), 12, 20), px(opened.current.hidden['arm-l'], 12, 20));
  assert.equal(px(refDecode(after.get('arm-l.hidden.png')), 12, 20)[3], 0);
  assert.deepEqual(px(refDecode(after.get('map.png')), 12, 20), [...MAP_COLORS['arm-l'], 255]);
  assert.ok(core.samePixels(unionOwn(dir), flatten(opened.layers)));
});

test('はみ出した下書き: 読み込んだ直後の見た目に出て、直さずに書き戻すと見えている所へ移る（check は数を出して 1 で終わる）', async () => {
  const { dir, imgs } = makeFixtureDir('px', { protrude: true });
  const opened = await openFolder(dir);
  const flat = flatten(opened.layers);
  // 立ち絵と違うのは、はみ出した画素だけ
  assert.equal(core.countDiff(flat, imgs.sprite), PROTRUDE.length);
  const plan = core.planSave(opened.info, opened.current, editedFromAse(readAse(aseBytes(opened)), opened.info));
  const byFile = Object.fromEntries(plan.writes.map((w) => [w.file, w]));
  assert.deepEqual(Object.keys(byFile).sort(), ['map.png', 'torso.hidden.png', 'torso.png']);
  assert.equal(byFile['torso.png'].diff, PROTRUDE.length);
  assert.equal(byFile['torso.hidden.png'].diff, PROTRUDE.length);
  assert.equal(byFile['torso.hidden.png'].toOwn, PROTRUDE.length);
  assert.equal(byFile['map.png'].diff, PROTRUDE.length);
  const r = spawnSync(process.execPath, [CLI, 'check', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /torso\.hidden\.png（2 画素。隠れた所 → 見えている所 2）/);
  await core.writePlan(nodeIo, dir, plan);
  assert.ok(core.samePixels(unionOwn(dir), flat));
  // 一度書き戻したあとは、往復で変わらない
  const again = await openFolder(dir);
  const plan2 = core.planSave(again.info, again.current, editedFromAse(readAse(aseBytes(again)), again.info));
  assert.deepEqual(plan2.writes, []);
});

test('前の形の .ase（<部位>.hidden のレイヤーのある 2 枚の形）: 1 枚に寄せて読み、直していなければ何も書かず、寄せたことを知らせる', async () => {
  const { dir } = makeFixtureDir();
  const opened = await openFolder(dir);
  const layers = legacyLayers(opened);
  const ase = readAse(writeAse({ width: GRID, height: GRID, layers }));
  const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.writes, []);
  assert.ok(plan.notes.some((n) => n.startsWith('old layout: merged 3 ')));
  // 前の形で隠れた所のレイヤーを直したものも、<部位>.hidden.png へ書く
  const hidden = clone(opened.current.hidden['arm-l']);
  hidden.data.set([9, 9, 9, 255], (20 * GRID + 12) * 4);
  const edited = layers.map((l) => (l.name === 'arm-l.hidden' ? { ...l, image: hidden } : l));
  const plan2 = core.planSave(opened.info, opened.current, editedFromAse(readAse(writeAse({ width: GRID, height: GRID, layers: edited })), opened.info));
  assert.deepEqual(plan2.writes.map((w) => w.file), ['arm-l.hidden.png']);
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

test('レイヤーが消えた部位は書かず、知らせる。奥の部位に描いた画素は、手前の部位の下なら隠れた所になる', async () => {
  const { dir } = makeFixtureDir();
  const opened = await openFolder(dir);
  const layers = opened.layers.filter((l) => l.name !== 'head');
  // 胴の画素を、奥の腕にも描く（胴の下になるので腕の隠れた所）
  const arm = layers.find((l) => l.name === 'arm-l').image;
  const torso = layers.find((l) => l.name === 'torso').image;
  const o = (18 * GRID + 16) * 4;
  arm.data.set(torso.data.subarray(o, o + 4), o);
  const ase = readAse(writeAse({ width: GRID, height: GRID, layers }));
  const plan = core.planSave(opened.info, opened.current, editedFromAse(ase, opened.info));
  assert.deepEqual(plan.writes.map((w) => w.file), ['arm-l.hidden.png']);
  assert.ok(plan.notes.some((n) => n.includes('head.png')));
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
  assert.match(s.stdout, /変わった部位・関節はありません/);
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
