#!/usr/bin/env node
// 蜂群 HIVE · 头像库对齐工具
//
// 头像库的规则是「脸在 (0,0)、发型在 (0,0)，直接叠加，不许动图层」。
// 这条规则成立的前提是**发型图已经按固定脸型对齐**——但实测那 100 张并没有：
// 发帘下沿散布在 y=18~170（对齐好的库应该只有一个值），约 1/3 会把眼睛盖住。
//
// 这个工具就干一件事：把每一张发型图整幅平移，让它的"头"回到该在的位置，
// 并把结果写回库里。这样叠加规则不用破，App 一行都不用改。
//
// 目标（取自旧库实测的稳定规律）：
//   · 发帘下沿 = 眼睛上沿(y=114) 上方 19px  →  y = 95
//   · 发块质心 x = 眼睛中心(x=121.5) 右侧 10px  →  x = 131.5
//
// 用法：
//   node tools/fix-avatar-library.mjs                     # 正式写回（自动先备份）
//   node tools/fix-avatar-library.mjs --dry               # 只看会怎么改，不写盘
//   node tools/fix-avatar-library.mjs --dir "D:\随机头像库"

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { hairMetrics } from '../server/align.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const dirIndex = argv.indexOf('--dir');
const LIB = dirIndex >= 0 && argv[dirIndex + 1]
  ? argv[dirIndex + 1]
  : process.env.HIVE_AVATAR_DIR || 'D:\\随机头像库';

const TARGET_FRINGE = 95;      // = 眼睛上沿 114 − 19
const TARGET_CX = 131.5;       // = 眼睛中心 121.5 + 10
const SIZE = 256;

// 脸的五官位置（由 face/base-face-reference.png 实测）
const EYE = { x0: 92, x1: 151, y0: 114, y1: 126, cx: 121.5 };
const BAND_HALF = 25;          // 找发帘只看眼睛左右各 25px
const CLIP_CAP = 30;           // 发型顶部最多让画布切掉多少
const COVER_LIMIT = 0.1;       // 眼睛区域最多允许被盖住多少（对齐得好的库是 0%）

/** 平移 (dx,dy) 之后，眼睛区域被盖住的比例。 */
function coverageAfter(img, dx, dy) {
  let covered = 0;
  let total = 0;
  for (let y = EYE.y0; y <= EYE.y1; y++) {
    for (let x = EYE.x0; x <= EYE.x1; x++) {
      total++;
      const sx = x - dx;
      const sy = y - dy;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      if (img.rgba[(sy * img.width + sx) * 4 + 3] > 128) covered++;
    }
  }
  return covered / total;
}

/** 平移 (dx,dy) 之后，发帘下沿落在哪儿（只看眼睛上沿以上、眼睛所在竖带里的最低头发像素）。 */
function fringeAfter(img, dx, dy) {
  let best = null;
  for (let y = 0; y <= EYE.y0; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = Math.round(EYE.cx) - BAND_HALF; x <= Math.round(EYE.cx) + BAND_HALF; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= img.width) continue;
      if (img.rgba[(sy * img.width + sx) * 4 + 3] > 16) {
        best = y;
        break;
      }
    }
  }
  return best;
}

/** 平移量会被画布切掉多少像素（发型顶部 / 左右越界）。 */
function clippedPixels(img, dx, dy) {
  let clipped = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] <= 16) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= img.width || ty >= img.height) clipped++;
    }
  }
  return clipped;
}

/**
 * 选一个平移量：先满足"眼睛不被盖住"，再尽量贴近发帘目标位置，同时不让画布切太多。
 * （AI 图集里裁出来的构图差得多的，前两条没法同时满足，就以"眼睛看得见"优先。）
 */
function solveShift(img, metrics) {
  const dx = Math.round(TARGET_CX - metrics.cx);
  let best = null;
  for (let dy = -60; dy <= 50; dy += 1) {
    const topClip = Math.max(0, -(dy + metrics.minY));
    if (topClip > CLIP_CAP) continue;
    const clipped = clippedPixels(img, dx, dy);
    if (clipped / Math.max(1, metrics.width * metrics.height) > 0.06) continue;
    const cover = coverageAfter(img, dx, dy);
    const fringe = fringeAfter(img, dx, dy);
    const fringeError = fringe === null ? 0 : Math.abs(fringe - TARGET_FRINGE);
    // 眼睛没露出来直接重罚；其次是发帘离目标多远；再其次少削一点
    const cost = cover * 1000 + fringeError * 2 + topClip * 0.5;
    if (!best || cost < best.cost) best = { dx, dy, cover, fringe, topClip, cost };
  }
  return best;
}

/* ── 读写 PNG（只处理 8 位 RGBA/灰度调色板，库里都是 RGBA）── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                      // filter 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function decodeRgba(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只支持 RGBA / RGB 的 PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const flat = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const base = y * stride;
    const prev = base - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? flat[base + x - channels] : 0;
      const up = y > 0 ? flat[prev + x] : 0;
      const upLeft = y > 0 && x >= channels ? flat[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 1: v = row[x] + left; break;
        case 2: v = row[x] + up; break;
        case 3: v = row[x] + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: v = row[x];
      }
      flat[base + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 4) {
      rgba[i * 4] = flat[i * 4];
      rgba[i * 4 + 1] = flat[i * 4 + 1];
      rgba[i * 4 + 2] = flat[i * 4 + 2];
      rgba[i * 4 + 3] = flat[i * 4 + 3];
    } else {
      rgba[i * 4] = flat[i * 3];
      rgba[i * 4 + 1] = flat[i * 3 + 1];
      rgba[i * 4 + 2] = flat[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** 整幅平移（dx 右、dy 下），出界的像素直接丢掉。 */
function translate(img, dx, dy) {
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < img.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (y * img.width + x) * 4;
      out[di] = img.rgba[si];
      out[di + 1] = img.rgba[si + 1];
      out[di + 2] = img.rgba[si + 2];
      out[di + 3] = img.rgba[si + 3];
    }
  }
  return { width: img.width, height: img.height, rgba: out };
}

/** 白底叠加（预览图用）。 */
function composeOnWhite(face, hair) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    let r = 255;
    const aF = face.rgba[i * 4 + 3] / 255;
    r = face.rgba[i * 4] * aF + r * (1 - aF);
    const aH = hair.rgba[i * 4 + 3] / 255;
    r = hair.rgba[i * 4] * aH + r * (1 - aH);
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = Math.round(r);
    out[i * 4 + 3] = 255;
  }
  return { width: SIZE, height: SIZE, rgba: out };
}

/** 10x10 目录图。 */
function catalog(images, cell = 200) {
  const out = Buffer.alloc(cell * 10 * cell * 10 * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = 255;
  }
  images.forEach((img, index) => {
    const rx = index % 10;
    const ry = Math.floor(index / 10);
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const sx = Math.min(255, Math.round((x / cell) * 256 - 0.5));
        const sy = Math.min(255, Math.round((y / cell) * 256 - 0.5));
        const si = (sy * 256 + sx) * 4;
        const di = ((ry * cell + y) * cell * 10 + (rx * cell + x)) * 4;
        out[di] = img.rgba[si];
        out[di + 1] = img.rgba[si + 1];
        out[di + 2] = img.rgba[si + 2];
        out[di + 3] = 255;
      }
    }
  });
  return { width: cell * 10, height: cell * 10, rgba: out };
}

/* ── 主流程 ─────────────────────────────────────────────── */

const hairDir = path.join(LIB, 'hair');
const facePath = path.join(LIB, 'face', 'base-face-reference.png');
if (!fs.existsSync(hairDir) || !fs.existsSync(facePath)) {
  console.error(`找不到头像库：${LIB}`);
  process.exit(1);
}

const names = fs.readdirSync(hairDir).filter((n) => /\.png$/i.test(n)).sort();
console.log(`头像库：${LIB}（${names.length} 张发型）${DRY ? '  [dry-run，不写盘]' : ''}`);

const backupDir = path.join(LIB, 'source', 'hair-original');
if (!DRY && !fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(hairDir, name), path.join(backupDir, name));
  console.log(`原图已备份到 ${backupDir}`);
}

const before = [];
const after = [];
const shifted = [];
const report = [];
for (const name of names) {
  const file = path.join(hairDir, name);
  const metrics = hairMetrics(file);
  if (!metrics || metrics.fringe === null) {
    console.log(`  ${name}：量不出发帘，跳过`);
    continue;
  }
  const img = decodeRgba(fs.readFileSync(file));
  const shift = solveShift(img, metrics);
  before.push({ fringe: metrics.fringe, cx: metrics.cx, cover: coverageAfter(img, 0, 0) });
  if (!shift || (shift.dx === 0 && shift.dy === 0)) {
    report.push({ name, ...shift, beforeCover: coverageAfter(img, 0, 0) });
    continue;
  }

  const moved = translate(img, shift.dx, shift.dy);
  if (!DRY) fs.writeFileSync(file, encodePng(moved.width, moved.height, moved.rgba));
  shifted.push({ name, dx: shift.dx, dy: shift.dy });
  report.push({ name, ...shift, beforeCover: coverageAfter(img, 0, 0) });
}
console.log(`移动了 ${shifted.length} 张；未动 ${before.length - shifted.length} 张`);

const stat = (label, values) => {
  const s = [...values].sort((a, b) => a - b);
  console.log(`  ${label}：中位 ${s[Math.floor(s.length / 2)].toFixed(2)}  p10 ${s[Math.floor(s.length * 0.1)].toFixed(2)}  p90 ${s[Math.floor(s.length * 0.9)].toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`);
};
console.log('\n修正前：');
stat('眼睛被盖住', before.map((b) => b.cover * 100));
stat('发帘位置 y', before.map((b) => b.fringe));
console.log('修正后（按算出来的平移量模拟）：');
stat('眼睛被盖住', report.map((r) => r.cover * 100));
stat('发帘位置 y', report.filter((r) => r.fringe !== null).map((r) => r.fringe));
stat('顶部被切 px', report.map((r) => r.topClip));
const bad = report.filter((r) => r.cover > COVER_LIMIT);
console.log(`眼睛仍被盖住 >${COVER_LIMIT * 100}% 的：${bad.length} 个 ${bad.slice(0, 8).map((b) => `${b.name}(${(b.cover * 100).toFixed(0)}%)`).join(' ')}`);

// 重生成预览图
if (!DRY) {
  const face = decodeRgba(fs.readFileSync(facePath));
  const composed = [];
  const hairOnly = [];
  for (const name of names) {
    const hair = decodeRgba(fs.readFileSync(path.join(hairDir, name)));
    composed.push(composeOnWhite(face, hair));
    hairOnly.push(hair);
  }
  const previewDir = path.join(LIB, 'preview');
  fs.mkdirSync(previewDir, { recursive: true });
  const c1 = catalog(composed);
  const c2 = catalog(hairOnly);
  fs.writeFileSync(path.join(previewDir, 'hair-catalog-100.png'), encodePng(c1.width, c1.height, c1.rgba));
  fs.writeFileSync(path.join(previewDir, 'hair-only-catalog-100.png'), encodePng(c2.width, c2.height, c2.rgba));
  console.log(`\n预览图已重生成：preview/hair-catalog-100.png、preview/hair-only-catalog-100.png`);
}
