// 試験のための、小さな合成の部位のフォルダ（heosterra の 〇〇-parts と同じ形）を作る。
// heosterra の絵はこのリポジトリに入れない（本体は private のため）。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodePng } from '../lib/png.mjs';

export const GRID = 32;
/** 奥 → 手前 */
export const ORDER = ['arm-l', 'torso', 'head'];
/** map.png の色（PART_COLORS に無い名前も混ぜ、map から色を読むことを試す） */
export const MAP_COLORS = { 'arm-l': [220, 60, 60], torso: [255, 140, 180], head: [10, 200, 250] };

const COLORS = { 'arm-l': [200, 150, 120, 255], torso: [90, 120, 200, 255], head: [240, 210, 180, 255] };

/** 部位の形（全体。隠れた所も含む） */
function shape(name, x, y) {
  if (name === 'head') return (x - 16) ** 2 + (y - 7) ** 2 <= 25;
  if (name === 'torso') return x >= 11 && x <= 21 && y >= 12 && y <= 24;
  if (name === 'arm-l') return x >= 8 && x <= 13 && y >= 13 && y <= 26;
  return false;
}

const blank = () => ({ width: GRID, height: GRID, data: new Uint8Array(GRID * GRID * 4) });

/** 部位の絵を作り、{ own, hidden, map, sprite } を返す */
export function makeImages() {
  const own = {};
  const hidden = {};
  for (const n of ORDER) {
    own[n] = blank();
    hidden[n] = blank();
  }
  const map = blank();
  const sprite = blank();
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const o = (y * GRID + x) * 4;
      // 手前から見て、最初に形のある部位が見えている所
      let front = null;
      for (let k = ORDER.length - 1; k >= 0; k--)
        if (shape(ORDER[k], x, y)) {
          front = ORDER[k];
          break;
        }
      for (const n of ORDER) {
        if (!shape(n, x, y)) continue;
        // 縁は暗い線
        const edge = !shape(n, x - 1, y) || !shape(n, x + 1, y) || !shape(n, x, y - 1) || !shape(n, x, y + 1);
        const c = edge ? [40, 30, 30, 255] : COLORS[n];
        (n === front ? own : hidden)[n].data.set(c, o);
      }
      if (front) {
        map.data.set([...MAP_COLORS[front], 255], o);
        sprite.data.set(own[front].data.subarray(o, o + 4), o);
      }
    }
  return { own, hidden, map, sprite };
}

export const JOINTS = {
  Spine: { x: 16.2, y: 23.5, near: -1 },
  Neck: { x: 16.4, y: 12.1, near: -1 },
  Head: { x: 16.1, y: 11.9, near: -1 },
  HeadTop: { x: 16.0, y: 2.2, near: -1 },
  LeftArm: { x: 10.5, y: 13.5, near: -1.1 },
  LeftHand: { x: 10.5, y: 25.5, near: -1.1 },
};

export function makeJson() {
  return {
    grid: GRID,
    joints: JOINTS,
    parts: [
      { name: 'torso', root: 'Spine', tip: 'Neck', parent: null, pixels: 0, hidden: 0 },
      { name: 'head', root: 'Head', tip: 'HeadTop', parent: 'torso', pixels: 0, hidden: 0 },
      { name: 'arm-l', root: 'LeftArm', tip: 'LeftHand', parent: 'torso', pixels: 0, hidden: 0 },
    ],
    order: ORDER,
  };
}

/** 一時のフォルダに 〇〇-parts を作り、そのパスを返す（立ち絵は隣に <名前>.png） */
export function makeFixtureDir(name = 'fx') {
  const root = mkdtempSync(join(tmpdir(), 'parts-editor-test-'));
  const dir = join(root, `${name}-parts`);
  mkdirSync(dir);
  const imgs = makeImages();
  for (const n of ORDER) {
    writeFileSync(join(dir, `${n}.png`), encodePng(imgs.own[n]));
    writeFileSync(join(dir, `${n}.hidden.png`), encodePng(imgs.hidden[n]));
  }
  writeFileSync(join(dir, 'map.png'), encodePng(imgs.map));
  writeFileSync(join(dir, 'parts.json'), JSON.stringify(makeJson(), null, 2));
  writeFileSync(join(root, `${name}.png`), encodePng(imgs.sprite));
  return { root, dir, imgs };
}
