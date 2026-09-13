/**
 * 修正思路：优先挪「发型层」——它是被裁歪的那一层，挪正之后每款发型的发帘
 * 都落在眼睛上方同一位置、开口中轴都对着画布中线；发型挪不动（已经贴着画布边）
 * 的余量再交给「脸层」补，两层都保证不出画布。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ── 脸层基准（由 face/base-face-reference.png 实测得到，256 画布坐标）── */

const FACE_EYE_TOP = 114;      // 眼睛上沿
const FRINGE_GAP = 14;         // 发帘下沿离眼睛上沿留多少
const BASE = 256;              // 库里约定的画布边长
const BAND = [80, 190];        // 只看头部中带，避免把两侧发丝外面的空隙当成开口
const CLAMP_FACE_X = 24;       // 脸层兜底水平平移上限
const CLAMP_FACE_Y = [-60, 50]; // 脸层兜底垂直平移上限（往下 50px 时下巴正好到画布底）

/** 取 PNG 的 alpha 通道（支持 8 位灰度/真彩/灰度+alpha/真彩+alpha/调色板）。 */
function decodeAlpha(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || depth !== 8 || !idat.length) return null;
  // 只支持无隔行扫描（库里都是默认的 0）
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
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
      let value;
      switch (filter) {
        case 1: value = row[x] + left; break;
        case 2: value = row[x] + up; break;
        case 3: value = row[x] + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: value = row[x];
      }
      flat[base + x] = value & 0xff;
    }
  }

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 3) {
      const index = flat[i];
      alpha[i] = trns && index < trns.length ? trns[index] : 255;
    } else if (colorType === 0) alpha[i] = 255;
    else if (colorType === 2) alpha[i] = 255;
    else if (colorType === 4) alpha[i] = flat[i * 2 + 1];
    else alpha[i] = flat[i * 4 + 3];
  }
  return { width, height, alpha };
}

/**
 * 找"头部开口"：只看中间那条竖带，取最长的连续不透明段（发帘），
 * 它之后第一段连续透明区域就是脸露出来的地方。
 */
function headWindow(image) {
  const { width, height, alpha } = image;
  const scale = width / BASE;
  const x0 = Math.round(BAND[0] * scale);
  const x1 = Math.round(BAND[1] * scale);
  const spans = x1 - x0 + 1;
  if (spans <= 4) return null;

  const frac = [];
  const centroid = [];
  for (let y = 0; y < height; y++) {
    let transparent = 0;
    let sum = 0;
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      if (alpha[row + x] <= 16) {
        transparent++;
        sum += x;
      }
    }
    frac.push(transparent / spans);
    centroid.push(transparent ? sum / transparent : width / 2);
  }

  let start = -1;
  let bestStart = -1;
  let bestLength = 0;
  for (let y = 0; y <= height; y++) {
    const opaque = y < height && frac[y] <= 0.4;
    if (opaque) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      if (y - start > bestLength) {
        bestLength = y - start;
        bestStart = start;
      }
      start = -1;
    }
  }
  if (bestStart < 0 || bestLength < 20 * scale) return null;

  let top = -1;
  let bottom = -1;
  for (let y = bestStart + bestLength; y < height; y++) {
    if (frac[y] >= 0.6) {
      if (top < 0) top = y;
      bottom = y;
    } else if (top >= 0 && frac[y] < 0.4) break;
  }
  if (top < 0) return null;

  let sum = 0;
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    if (frac[y] >= 0.6) {
      sum += centroid[y];
      count++;
    }
  }
  return { top: top / scale, centerX: (count ? sum / count : width / 2) / scale };
}

const cache = new Map();

/** 发型图里不透明像素的包围盒（画布坐标），用来限制修正量。 */
function opaqueBox(image) {
  const { width, height, alpha } = image;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

/**
 * 算出一张发型图的修正量（单位是 256 画布坐标）：
 *   hair —— 发型层平移；face —— 发型挪不动时脸层补的余量。
 * 返回 null 表示这张图找不到开口，按库里「左上角对齐、直接叠加」的原始约定画。
 */
export function faceAlign(file) {
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${file}@${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);

  let result = null;
  try {
    const image = decodeAlpha(fs.readFileSync(file));
    const window = image ? headWindow(image) : null;
    const box = image && window ? opaqueBox(image) : null;
    if (window && box) {
      const scale = image.width / BASE;
      // 需要的"相对位移"：脸相对发型要往右下挪多少
      const relX = window.centerX - BASE / 2;
      const relY = window.top - (FACE_EYE_TOP - FRINGE_GAP);
      // 优先挪发型（反向），但发型不能出画布，挪不动的部分交给脸
      const hairDx = Math.max(-box.minX / scale, Math.min((image.width - 1 - box.maxX) / scale, -relX));
      const hairDy = Math.max(-box.minY / scale, Math.min((image.height - 1 - box.maxY) / scale, -relY));
      result = {
        hair: { dx: Math.round(hairDx), dy: Math.round(hairDy) },
        face: {
          dx: Math.max(-CLAMP_FACE_X, Math.min(CLAMP_FACE_X, Math.round(relX + hairDx))),
          dy: Math.max(CLAMP_FACE_Y[0], Math.min(CLAMP_FACE_Y[1], Math.round(relY + hairDy))),
        },
        fringe: Math.round(window.top),
      };
    }
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}
