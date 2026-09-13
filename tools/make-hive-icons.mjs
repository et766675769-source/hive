#!/usr/bin/env node
// 蜂群 HIVE · 图标生成
//
// 生成"自带底色"的图标方案：圆角方块 + 六边形 logo。
// 这样在浅色和深色任务栏/资源管理器里都看得清，不需要跟着主题换。
//
// 用法（在仓库根目录）：
//   node tools/make-hive-icons.mjs web/assets/hive-icon-white.png web/assets/hive-icon-black.png desktop desktop/icon-options.png
//
// 产出：desktop/hive-tile-dark.ico / hive-tile-light.ico / hive-tile-accent.ico
//       （各含 16/24/32/48/64/128/256 七帧），以及一张深浅底对照的预览图。
// 生成"自带底色"的图标方案：圆角方块 + 六边形 logo（浅色/深色都能看清）
// 用法：node make-tiles.mjs <whiteLogo.png> <blackLogo.png> <outDir> <previewPng>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* ── PNG 读写 ── */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, colorType = 0; const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, flat = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++], row = raw.subarray(pos, pos + stride); pos += stride;
    const base = y * stride, prev = base - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? flat[base + x - ch] : 0, up = y > 0 ? flat[prev + x] : 0, ul = y > 0 && x >= ch ? flat[prev + x - ch] : 0;
      let v;
      switch (f) {
        case 1: v = row[x] + left; break;
        case 2: v = row[x] + up; break;
        case 3: v = row[x] + ((left + up) >> 1); break;
        case 4: { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v = row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul); break; }
        default: v = row[x];
      }
      flat[base + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (ch === 4) { rgba[i * 4] = flat[i * 4]; rgba[i * 4 + 1] = flat[i * 4 + 1]; rgba[i * 4 + 2] = flat[i * 4 + 2]; rgba[i * 4 + 3] = flat[i * 4 + 3]; }
    else { rgba[i * 4] = flat[i * 3]; rgba[i * 4 + 1] = flat[i * 3 + 1]; rgba[i * 4 + 2] = flat[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  }
  return { w, h, rgba };
}
function logoBox(img) {
  let minX = img.w, maxX = -1, minY = img.h, maxY = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (img.rgba[(y * img.w + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 面积平均缩放（只处理 RGBA，用于把 256 的成品降到小尺寸） */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = src.w / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < src.h; sy++) {
        for (let sx = x0; sx < x1 && sx < src.w; sx++) {
          const i = (sy * src.w + sx) * 4;
          const al = src.rgba[i + 3] / 255;
          r += src.rgba[i] * al; g += src.rgba[i + 1] * al; b += src.rgba[i + 2] * al; a += al; n++;
        }
      }
      const di = (y * size + x) * 4;
      const alpha = n ? a / n : 0;
      if (alpha > 0) {
        out[di] = Math.round(r / a); out[di + 1] = Math.round(g / a); out[di + 2] = Math.round(b / a);
        out[di + 3] = Math.round(alpha * 255);
      }
    }
  }
  return { w: size, h: size, rgba: out };
}

/** 圆角方块铺底 + 六边形 logo 居中（4x 超采样做抗锯齿） */
function makeTile(logo, bg, size = 256) {
  const box = logoBox(logo);
  const radius = size * 0.235;
  const pad = size * 0.17;
  const inner = size - pad * 2;
  const logoScale = inner / Math.max(box.w, box.h);
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let lr = 0, lg = 0, lb = 0, la = 0, ln = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 圆角方块
          const dx = Math.max(radius - px, px - (size - radius), 0);
          const dy = Math.max(radius - py, py - (size - radius), 0);
          const inTile = Math.sqrt(dx * dx + dy * dy) <= radius + 1e-6;
          if (inTile) bgHits++;
          // logo 采样
          const lx = (px - (size - box.w * logoScale) / 2) / logoScale + box.minX;
          const ly = (py - (size - box.h * logoScale) / 2) / logoScale + box.minY;
          const sxi = Math.round(lx), syi = Math.round(ly);
          if (sxi >= 0 && syi >= 0 && sxi < logo.w && syi < logo.h) {
            const i = (syi * logo.w + sxi) * 4;
            const al = logo.rgba[i + 3] / 255;
            if (al > 0) { lr += logo.rgba[i] * al; lg += logo.rgba[i + 1] * al; lb += logo.rgba[i + 2] * al; la += al; }
          }
          ln++;
        }
      }
      const bgA = bgHits / (SS * SS);
      const logoA = la / ln;
      const di = (y * size + x) * 4;
      if (bgA <= 0 && logoA <= 0) continue;
      // logo 叠在方块上
      const outA = logoA + bgA * (1 - logoA);
      const mix = (logoC, bgC) => (logoC * logoA + bgC * bgA * (1 - logoA)) / (outA || 1);
      out[di] = Math.round(outA ? mix(lr / (la || 1), bg[0]) : 0);
      out[di + 1] = Math.round(outA ? mix(lg / (la || 1), bg[1]) : 0);
      out[di + 2] = Math.round(outA ? mix(lb / (la || 1), bg[2]) : 0);
      out[di + 3] = Math.round(outA * 255);
    }
  }
  return { w: size, h: size, rgba: out };
}

function writeIco(frames, outFile) {
  const sizes = frames.map((f) => f.w);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = 6 + frames.length * 16;
  const entries = [];
  for (const f of frames) {
    const png = encodePng(f.w, f.w, f.rgba);
    const e = Buffer.alloc(16);
    e[0] = f.w >= 256 ? 0 : f.w; e[1] = f.w >= 256 ? 0 : f.w;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
    f.png = png;
  }
  fs.writeFileSync(outFile, Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]));
  return fs.statSync(outFile).size;
}

/* ── 主流程 ── */
const [whiteFile, blackFile, outDir, previewFile] = process.argv.slice(2);
const white = decodePng(whiteFile);
const black = decodePng(blackFile);
fs.mkdirSync(outDir, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const options = [
  { key: 'tile-dark', label: '深色方块+白六边形', logo: white, bg: [23, 24, 28] },
  { key: 'tile-light', label: '浅色方块+黑六边形', logo: black, bg: [246, 247, 249] },
  { key: 'tile-accent', label: '主题蓝方块+白六边形', logo: white, bg: [59, 130, 246] },
];

const made = [];
for (const opt of options) {
  const master = makeTile(opt.logo, opt.bg, 256);
  const frames = SIZES.map((s) => resize(master, s));
  const out = path.join(outDir, `hive-${opt.key}.ico`);
  const bytes = writeIco(frames, out);
  fs.writeFileSync(path.join(outDir, `hive-${opt.key}.png`), encodePng(256, 256, master.rgba));
  made.push({ ...opt, master, out, bytes });
  console.log(`${out}  ${bytes} 字节 (${SIZES.join('/')})`);
}

// 预览图：上排=深色底，下排=浅色底；每版 64/32/16 三个尺寸，最后附上现在的纯白/纯黑版
const previews = [
  ...made,
  { key: 'hex-white', label: '现在的纯白版', master: null },
  { key: 'hex-black', label: '现在的纯黑版', master: null },
];
const cellW = 120, cellH = 110;
const W = cellW * previews.length, H = cellH * 2;
const sheet = Buffer.alloc(W * H * 4);
function put(img, ox, oy) {
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const si = (y * img.w + x) * 4, di = ((oy + y) * W + ox + x) * 4;
    if (oy + y >= H || ox + x >= W) continue;
    const a = img.rgba[si + 3] / 255;
    for (let c = 0; c < 3; c++) sheet[di + c] = Math.round(img.rgba[si + c] * a + sheet[di + c] * (1 - a));
    sheet[di + 3] = 255;
  }
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const di = (y * W + x) * 4;
  const dark = y < cellH;
  const v = dark ? 32 : 243;
  sheet[di] = v; sheet[di + 1] = v + (dark ? 1 : 0); sheet[di + 2] = v + (dark ? 4 : 2); sheet[di + 3] = 255;
}
for (let row = 0; row < 2; row++) previews.forEach((p, k) => {
  const ox = k * cellW;
  const tiles = [];
  for (const s of [64, 32, 16]) {
    if (p.master) tiles.push(resize(p.master, s));
    else {
      const src = p.key === 'hex-white' ? white : black;
      const box = logoBox(src);
      const out = Buffer.alloc(s * s * 4);
      const scale = s / Math.max(box.w, box.h);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const sx = Math.round((x - (s - box.w * scale) / 2) / scale + box.minX);
        const sy = Math.round((y - (s - box.h * scale) / 2) / scale + box.minY);
        if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
        const si = (sy * src.w + sx) * 4, di = (y * s + x) * 4;
        out[di] = src.rgba[si]; out[di + 1] = src.rgba[si + 1]; out[di + 2] = src.rgba[si + 2]; out[di + 3] = src.rgba[si + 3];
      }
      tiles.push({ w: s, h: s, rgba: out });
    }
  }
  // 在同一行里并排摆三个尺寸
  let cursor = ox + 8;
  for (const t of tiles) {
    const oy = row * cellH + Math.round((cellH - t.h) / 2);
    put(t, cursor, oy);
    cursor += t.w + 6;
  }
});
fs.writeFileSync(previewFile, encodePng(W, H, sheet));
console.log(`\n预览图：${previewFile}（${W}x${H}）`);
console.log('上排=深色任务栏底色，下排=浅色底色；每格从左到右 64px / 32px / 16px');
made.forEach((m, i) => console.log(`  第 ${i + 1} 格：${m.label}`));
console.log(`  第 ${made.length + 1} 格：现在的纯白版    第 ${made.length + 2} 格：现在的纯黑版`);
