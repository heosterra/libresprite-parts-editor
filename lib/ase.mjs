// .ase（Aseprite / LibreSprite の形式）の読み書き。RGBA（32bit）・1 コマだけを扱う。
// 形式は LibreSprite の docs/files/ase.txt に従う。
import { deflateSync, inflateSync } from 'node:zlib';

const HEADER_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;

/** レイヤーの flags */
export const LAYER_FLAGS = { visible: 1, editable: 2 };

class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.parts.push(b);
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v, 0);
    this.parts.push(b);
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v, 0);
    this.parts.push(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.parts.push(b);
  }
  zeros(n) {
    this.parts.push(Buffer.alloc(n));
  }
  bytes(b) {
    this.parts.push(Buffer.from(b));
  }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    this.u16(b.length);
    this.parts.push(b);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

function chunk(type, body) {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(body.length + 6, 0);
  head.writeUInt16LE(type, 4);
  return Buffer.concat([head, body]);
}

/**
 * .ase を作る。
 * layers: 下（奥）から上（手前）の順の [{ name, image: { width, height, data: RGBA }, visible, editable }]
 */
export function writeAse({ width, height, layers }) {
  const chunks = [];
  for (const l of layers) {
    const w = new Writer();
    w.u16((l.visible ? LAYER_FLAGS.visible : 0) | (l.editable ? LAYER_FLAGS.editable : 0));
    w.u16(0); // 画像のレイヤー
    w.u16(0); // 子の深さ
    w.u16(0);
    w.u16(0);
    w.u16(0); // 合成: 普通
    w.u8(255); // 不透明度
    w.zeros(3);
    w.str(l.name);
    chunks.push(chunk(CHUNK_LAYER, w.done()));
  }
  layers.forEach((l, index) => {
    // l.cel（{ x, y, width, height, data }）があれば、絵の大きさでない cel として書く（LibreSprite が詰めた cel を真似る試験のため）
    const cel = l.cel ?? { x: 0, y: 0, width, height, data: l.image.data };
    if (!l.cel && (l.image.width !== width || l.image.height !== height)) throw new Error(`レイヤーの大きさが違います: ${l.name}`);
    const w = new Writer();
    w.u16(index);
    w.i16(cel.x);
    w.i16(cel.y);
    w.u8(255);
    w.u16(2); // 圧縮した画像
    w.zeros(7);
    w.u16(cel.width);
    w.u16(cel.height);
    w.bytes(deflateSync(Buffer.from(cel.data.buffer, cel.data.byteOffset, cel.data.length), { level: 9 }));
    chunks.push(chunk(CHUNK_CEL, w.done()));
  });
  const body = Buffer.concat(chunks);
  const frame = Buffer.alloc(16);
  frame.writeUInt32LE(16 + body.length, 0);
  frame.writeUInt16LE(FRAME_MAGIC, 4);
  frame.writeUInt16LE(Math.min(chunks.length, 0xffff), 6);
  frame.writeUInt16LE(100, 8); // コマの長さ（ms）
  frame.writeUInt32LE(chunks.length, 12); // 新しい形式の chunk の数
  const header = Buffer.alloc(128);
  const size = 128 + frame.length + body.length;
  header.writeUInt32LE(size, 0);
  header.writeUInt16LE(HEADER_MAGIC, 4);
  header.writeUInt16LE(1, 6); // コマの数
  header.writeUInt16LE(width, 8);
  header.writeUInt16LE(height, 10);
  header.writeUInt16LE(32, 12); // RGBA
  header.writeUInt32LE(1, 14); // レイヤーの不透明度が有効
  header.writeUInt16LE(100, 18);
  header.writeUInt16LE(0, 32); // 色の数（RGBA では使わない）
  header.writeUInt8(1, 34); // 画素の幅の比
  header.writeUInt8(1, 35); // 画素の高さの比
  return Buffer.concat([header, frame, body]);
}

/**
 * .ase を読む（最初のコマだけ）。
 * 返す: { width, height, layers: [{ name, type, visible, editable, opacity, image: RGBA（絵の大きさ）| null }] }
 */
export function readAse(buf) {
  if (buf.length < 128 || buf.readUInt16LE(4) !== HEADER_MAGIC) throw new Error('.ase ではありません');
  const frames = buf.readUInt16LE(6);
  const width = buf.readUInt16LE(8);
  const height = buf.readUInt16LE(10);
  const depth = buf.readUInt16LE(12);
  if (depth !== 32) throw new Error(`RGBA（32bit）以外の .ase は扱えません（${depth}bit）。LibreSprite で色の形を RGB にしてから保存してください`);
  const layers = [];
  let pos = 128;
  for (let f = 0; f < frames && f < 1; f++) {
    const frameBytes = buf.readUInt32LE(pos);
    if (buf.readUInt16LE(pos + 4) !== FRAME_MAGIC) throw new Error('.ase のコマの頭が壊れています');
    let count = buf.readUInt16LE(pos + 6);
    const newCount = buf.readUInt32LE(pos + 12);
    if (count === 0xffff || (newCount && newCount > count)) count = newCount || count;
    let cpos = pos + 16;
    const end = pos + frameBytes;
    for (let c = 0; c < count && cpos + 6 <= end; c++) {
      const size = buf.readUInt32LE(cpos);
      const type = buf.readUInt16LE(cpos + 4);
      const body = buf.subarray(cpos + 6, cpos + size);
      if (type === CHUNK_LAYER) {
        const flags = body.readUInt16LE(0);
        const ltype = body.readUInt16LE(2);
        const opacity = body.readUInt8(12);
        const nameLen = body.readUInt16LE(16);
        const name = body.toString('utf8', 18, 18 + nameLen);
        layers.push({
          name,
          type: ltype,
          visible: !!(flags & LAYER_FLAGS.visible),
          editable: !!(flags & LAYER_FLAGS.editable),
          opacity,
          image: null,
        });
      } else if (type === CHUNK_CEL) {
        const index = body.readUInt16LE(0);
        const x = body.readInt16LE(2);
        const y = body.readInt16LE(4);
        const celType = body.readUInt16LE(7);
        const layer = layers[index];
        if (layer && (celType === 0 || celType === 2)) {
          const cw = body.readUInt16LE(16);
          const ch = body.readUInt16LE(18);
          const raw = celType === 0 ? body.subarray(20, 20 + cw * ch * 4) : inflateSync(body.subarray(20));
          if (raw.length < cw * ch * 4) throw new Error(`.ase の cel の画素が足りません（レイヤー ${layer.name}）`);
          const img = { width, height, data: new Uint8Array(width * height * 4) };
          for (let yy = 0; yy < ch; yy++) {
            const sy = y + yy;
            if (sy < 0 || sy >= height) continue;
            for (let xx = 0; xx < cw; xx++) {
              const sx = x + xx;
              if (sx < 0 || sx >= width) continue;
              const s = (yy * cw + xx) * 4;
              const o = (sy * width + sx) * 4;
              img.data[o] = raw[s];
              img.data[o + 1] = raw[s + 1];
              img.data[o + 2] = raw[s + 2];
              img.data[o + 3] = raw[s + 3];
            }
          }
          layer.image = img;
        }
      }
      cpos += size;
    }
    pos += frameBytes;
  }
  return { width, height, layers };
}
