// public/icon.svg と同じ図柄の PNG アイコンを依存なしで生成する
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BLUE = [0x1f, 0x6f, 0xeb];
const WHITE = [0xff, 0xff, 0xff];
const LIGHT = [0x9e, 0xc5, 0xfe];

// 512 基準の角丸矩形（x, y, w, h, r, color）。maskable 用に round=false で全面塗り
const shapes = (round) => [
  [0, 0, 512, 512, round ? 96 : 0, BLUE],
  [136, 104, 240, 304, 24, WHITE],
  [176, 168, 160, 24, 12, BLUE],
  [176, 232, 160, 20, 10, LIGHT],
  [176, 284, 120, 20, 10, LIGHT],
  [176, 336, 140, 20, 10, LIGHT],
];

function inside(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, round) {
  const s = shapes(round);
  const rows = [];
  const SS = 3; // 3x3 スーパーサンプリングでアンチエイリアス
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = ((x + (sx + 0.5) / SS) * 512) / size;
          const py = ((y + (sy + 0.5) / SS) * 512) / size;
          let col = null;
          for (const sh of s) if (inside(px, py, sh)) col = sh[5];
          if (col) acc = [acc[0] + col[0], acc[1] + col[1], acc[2] + col[2], acc[3] + 255];
        }
      const n = SS * SS;
      const a = acc[3] / n;
      const k = acc[3] ? 255 / acc[3] : 0;
      row.set([Math.round(acc[0] * k), Math.round(acc[1] * k), Math.round(acc[2] * k), Math.round(a)], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync('public/icon-192.png', png(192, true));
writeFileSync('public/icon-512.png', png(512, true));
// iOS は角を自前で丸めるので全面塗り
writeFileSync('public/apple-touch-icon.png', png(180, false));
console.log('icons written');
