/* Génère les icônes PNG de la PWA (aucune dépendance externe). */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(path, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filtre None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // profondeur
  ihdr[9] = 6;  // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

const GLYPH = [
  [0, 1, 1, 1, 0],
  [1, 1, 0, 1, 1],
  [1, 0, 1, 0, 1],
  [1, 1, 0, 1, 1],
  [0, 1, 1, 1, 0],
];

function makeIcon(size, { bleed = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [0x10, 0x13, 0x1a];
  const cell = [0x4c, 0x8d, 0xff];
  const line = [0x2d, 0x35, 0x46];

  const put = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = a;
  };

  const radius = bleed ? 0 : Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      if (radius > 0) {
        const cx = Math.min(Math.max(x, radius), size - 1 - radius);
        const cy = Math.min(Math.max(y, radius), size - 1 - radius);
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      }
      put(x, y, bg, inside ? 255 : 0);
    }
  }

  // Grille 5x5 centrée. En mode maskable on la rétrécit pour rester dans la
  // zone sûre (cercle de 80 %).
  const span = Math.round(size * (bleed ? 0.44 : 0.62));
  const step = span / 5;
  const ox = Math.round((size - span) / 2);
  const oy = Math.round((size - span) / 2);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      if (!GLYPH[r][c]) continue;
      const x0 = Math.round(ox + c * step);
      const y0 = Math.round(oy + r * step);
      const x1 = Math.round(ox + (c + 1) * step);
      const y1 = Math.round(oy + (r + 1) * step);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, cell);
    }
  }
  const t = Math.max(1, Math.round(size * 0.008));
  for (let k = 0; k <= 5; k++) {
    const p = Math.round(ox + k * step);
    for (let y = oy; y <= oy + span; y++) for (let d = 0; d < t; d++) put(p + d, y, line);
    const q = Math.round(oy + k * step);
    for (let x = ox; x <= ox + span; x++) for (let d = 0; d < t; d++) put(x, q + d, line);
  }
  return rgba;
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const dir = new URL('../icons/', import.meta.url).pathname;
writePng(`${dir}icon-192.png`, 192, 192, makeIcon(192));
writePng(`${dir}icon-512.png`, 512, 512, makeIcon(512));
writePng(`${dir}icon-maskable-512.png`, 512, 512, makeIcon(512, { bleed: true }));
console.log('icônes générées');
