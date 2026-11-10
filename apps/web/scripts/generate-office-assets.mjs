// Sinh tài sản pixel art của Virtual Office (tự vẽ, không dùng tài sản của dự án hay thương hiệu khác).
// Chạy: node apps/web/scripts/generate-office-assets.mjs
// Kết quả: apps/web/public/office/{characters,icons,tiles}.png. Kích thước ô và thứ tự khung khớp
// apps/web/src/office/renderer-pixi/assets.ts.
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'office');

// --- mã hóa PNG tối thiểu (RGBA 8 bit) ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
};
const encodePng = (w, h, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.writeUInt8(8, 8); // độ sâu bit
  header.writeUInt8(6, 9); // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0; // filter none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set([r, g, b, a], (y * this.w + x) * 4);
  }
  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.set(x + i, y + j, color);
  }
  /** Vẽ bản đồ ký tự: '#' dùng `color`, ký tự khác trong `palette` dùng màu tương ứng, '.' trong suốt. */
  map(x, y, rows, color, palette = {}) {
    rows.forEach((row, j) =>
      [...row].forEach((ch, i) => {
        if (ch === '.') return;
        this.set(x + i, y + j, ch === '#' ? color : palette[ch]);
      }),
    );
  }
}

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

// --- nhân vật: 16x24, 2 khung (A, B) mỗi avatar_key ---
const AVATARS = [
  { key: 'developer', shirt: '#3b5bdb', pants: '#2b2f3a', hair: '#3a2a1c', extra: 'headphones' },
  { key: 'analyst', shirt: '#2f9e6e', pants: '#3a3f4b', hair: '#6b3f1d', extra: 'glasses' },
  { key: 'tester', shirt: '#e8890c', pants: '#2f3a4a', hair: '#1f1f1f', extra: 'cap' },
  { key: 'manager', shirt: '#2a2f45', pants: '#1d2030', hair: '#8a8a8a', extra: 'tie' },
  { key: 'generic', shirt: '#6d7686', pants: '#394150', hair: '#4a3b2a', extra: 'none' },
];
const SKIN = hex('#f1c9a0');
const DARK = hex('#1b1b22');

function drawCharacter(c, ox, a, frame) {
  const hair = hex(a.hair);
  const shirt = hex(a.shirt);
  const pants = hex(a.pants);
  const bob = frame === 1 ? 1 : 0; // khung B: cả người nhích 1px, chân co
  c.rect(ox + 5, 3 + bob, 6, 2, hair);
  c.rect(ox + 4, 4 + bob, 1, 3, hair);
  c.rect(ox + 11, 4 + bob, 1, 3, hair);
  c.rect(ox + 5, 5 + bob, 6, 5, SKIN);
  c.rect(ox + 6, 7 + bob, 1, 1, DARK);
  c.rect(ox + 9, 7 + bob, 1, 1, DARK);
  c.rect(ox + 4, 10 + bob, 8, 8, shirt);
  c.rect(ox + 2, 11 + bob, 2, 6, shirt);
  c.rect(ox + 12, 11 + bob, 2, 6, shirt);
  c.rect(ox + 2, 17 + bob, 2, 1, SKIN);
  c.rect(ox + 12, 17 + bob, 2, 1, SKIN);
  c.rect(ox + 5, 18 + bob, 2, 5 - bob, pants);
  c.rect(ox + 9, 18 + bob, 2, 5 - bob, pants);
  if (a.extra === 'headphones') {
    c.rect(ox + 3, 5 + bob, 1, 3, DARK);
    c.rect(ox + 12, 5 + bob, 1, 3, DARK);
    c.rect(ox + 4, 3 + bob, 8, 1, DARK);
  } else if (a.extra === 'glasses') {
    c.rect(ox + 5, 7 + bob, 6, 1, DARK);
  } else if (a.extra === 'cap') {
    c.rect(ox + 4, 2 + bob, 8, 2, hex('#2b8a3e'));
    c.rect(ox + 10, 4 + bob, 3, 1, hex('#2b8a3e'));
  } else if (a.extra === 'tie') {
    c.rect(ox + 7, 10 + bob, 2, 7, hex('#c92a2a'));
  }
}

const characters = new Canvas(16 * 2, 24 * AVATARS.length);
AVATARS.forEach((a, row) => {
  for (let frame = 0; frame < 2; frame += 1) {
    const sub = new Canvas(16, 24);
    drawCharacter(sub, 0, a, frame);
    for (let y = 0; y < 24; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const o = (y * 16 + x) * 4;
        if (sub.px[o + 3] === 0) continue;
        characters.set(frame * 16 + x, row * 24 + y, [...sub.px.subarray(o, o + 4)]);
      }
    }
  }
});

// --- biểu tượng trạng thái: 8x8, thứ tự khớp EMPLOYEE_STATES ở assets.ts ---
const ICONS = {
  idle: {
    color: '#8a94a6',
    rows: [
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
      '........',
    ],
  },
  working: {
    color: '#f59f00',
    rows: [
      '...##...',
      '.#.##.#.',
      '..####..',
      '###..###',
      '###..###',
      '..####..',
      '.#.##.#.',
      '...##...',
    ],
  },
  thinking: {
    color: '#4c6ef5',
    rows: [
      '.######.',
      '#......#',
      '#.#.#.#.',
      '#......#',
      '.######.',
      '...#....',
      '..#.....',
      '........',
    ],
  },
  communicating: {
    color: '#1c7ed6',
    rows: [
      '########',
      '#......#',
      '#.####.#',
      '#......#',
      '#.####.#',
      '########',
      '..#.....',
      '.#......',
    ],
  },
  meeting: {
    color: '#7048e8',
    rows: [
      '..#..#..',
      '.###.###',
      '..#..#..',
      '.###.###',
      '.#.#.#.#',
      '........',
      '........',
      '........',
    ],
  },
  waiting_approval: {
    color: '#fab005',
    rows: [
      '########',
      '.#....#.',
      '..#..#..',
      '...##...',
      '...##...',
      '..#..#..',
      '.#.##.#.',
      '########',
    ],
  },
  completed: {
    color: '#2f9e44',
    rows: [
      '........',
      '.......#',
      '......##',
      '#....##.',
      '##..##..',
      '.####...',
      '..##....',
      '........',
    ],
  },
  error_blocked: {
    color: '#e03131',
    rows: [
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '...##...',
      '........',
      '...##...',
      '...##...',
    ],
  },
  break: {
    color: '#0ca678',
    rows: [
      '........',
      '.######.',
      '.#....##',
      '.#....#.',
      '.#....##',
      '.######.',
      '..####..',
      '........',
    ],
  },
};
const iconNames = Object.keys(ICONS);
const icons = new Canvas(8 * iconNames.length, 8);
iconNames.forEach((name, i) => icons.map(i * 8, 0, ICONS[name].rows, hex(ICONS[name].color)));

// --- ô nền 16x16: sàn department, sàn CEO Office, sàn Break Room, bàn làm việc ---
const tiles = new Canvas(16 * 4, 16);
const floor = (index, base, alt) => {
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1)
      tiles.set(index * 16 + x, y, hex(((x >> 3) + (y >> 3)) % 2 === 1 ? alt : base));
  }
};
floor(0, '#dfe6f1', '#d6deeb');
floor(1, '#efe3cf', '#e7d9c1');
floor(2, '#d9efe2', '#cfe8da');
// Bàn: mặt bàn nâu, màn hình tối với viền sáng.
tiles.rect(64 + 1, 6, 14, 8, hex('#9c6b3f'));
tiles.rect(64 + 1, 13, 14, 1, hex('#7a5230'));
tiles.rect(64 + 4, 1, 8, 6, hex('#2b2f3a'));
tiles.rect(64 + 5, 2, 6, 4, hex('#74c0fc'));
tiles.rect(64 + 7, 7, 2, 1, hex('#2b2f3a'));

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'characters.png'), encodePng(characters.w, characters.h, characters.px));
writeFileSync(join(OUT, 'icons.png'), encodePng(icons.w, icons.h, icons.px));
writeFileSync(join(OUT, 'tiles.png'), encodePng(tiles.w, tiles.h, tiles.px));
stdout.write(`Đã ghi characters.png, icons.png, tiles.png vào ${OUT}
`);
