/**
 * 头像库对齐修正（零依赖，只用 node:zlib）
 *
 * 库里 100 个发型是从 AI 图集里按格子裁出来的，每张图里"头"的位置都不一样；
 * 脸只有一张，直接按库的约定（左上角对齐）叠加，就会出现"发帘压住眼睛""脸歪在发型一边"。
 *
 * 目标几何不是拍脑袋定的：量了旧预览图 preview/hair-catalog.png（那一套是能接受的）里的
 * 14 个格子，得到几条稳定规律 ——
 *   · 发帘下沿在眼睛上沿上方 19px（中位，范围 3~34）
 *   · 发块质心比眼睛中心偏右 10px（中位，范围 7~15）
 *   · 眼睛从来没被发帘盖住过（0%）
 * 每张新发型图都往这上面靠：优先挪发型层（它是被裁歪的那层），挪不动（已经贴画布边）
 * 的余量交给脸层补，两层都保证不出画布。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ── 基准值（由 face/base-face-reference.png + 旧预览图实测，256 画布坐标）── */

const EYE_TOP = 114;        // 眼睛上沿
const EYE_CX = 121.5;       // 两只眼睛的中心
const CHIN = 205;           // 找发帘只在这个高度以上找，免得把垂到下巴以下的发梢算进来
const TARGET_GAP = 19;      // 发帘下沿离眼睛上沿的目标距离（旧库中位数）
const TARGET_DX = 10;       // 发块质心相对眼睛中心的目标偏移（旧库就是偏右一点）
const BAND_HALF = 25;       // 找发帘时只看眼睛左右各 25px 的竖带
const BASE = 256;           // 库里约定的画布边长
const CLAMP_FACE_X = 24;    // 脸层兜底水平平移上限
const CLAMP_FACE_Y = [-60, 50]; // 脸层兜底垂直平移上限（往下 50px 时下巴正好到画布底）
const ALLOW_CLIP = 30;      // 允许发型顶部被画布切掉多少：宁可削一点发顶，也别把整张脸压到圆盘底部

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
 * 量两张"基准数值"，跟旧预览图同一个算法：
 *   fringe —— 眼睛所在竖带里、下巴以上的最低头发像素（= 发帘下沿）
 *   cx     —— 发型不透明像素的质心横坐标（= 发块重心）
 */
function measureHair(image) {
  const { width, height, alpha } = image;
  const scale = width / BASE;

  let cx = 0;
  let cy = 0;
  let count = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (alpha[row + x] > 16) {
        cx += x;
        cy += y;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!count) return null;

  const bandHalf = BAND_HALF * scale;
  const center = EYE_CX * scale;
  const chin = Math.min(height - 1, CHIN * scale);
  const from = Math.max(0, Math.round(center - bandHalf));
  const to = Math.min(width - 1, Math.round(center + bandHalf));
  let fringe = -1;
  for (let y = 0; y <= chin; y++) {
    const row = y * width;
    for (let x = from; x <= to; x++) {
      if (alpha[row + x] > 16) {
        fringe = y;
        break;
      }
    }
  }

  return {
    scale,
    cx: cx / count / scale,
    cy: cy / count / scale,
    fringe: fringe < 0 ? null : fringe / scale,
    minX: minX / scale,
    maxX: maxX / scale,
    minY: minY / scale,
    maxY: maxY / scale,
    width: width / scale,
    height: height / scale,
  };
}

const cache = new Map();

/**
 * 只量不修：读出这张发型图的原始指标（发帘位置、发块质心、不透明范围）。
 * 给 tools/fix-avatar-library.mjs 重裁库素材用。
 */
export function hairMetrics(file) {
  try {
    const image = decodeAlpha(fs.readFileSync(file));
    return image ? measureHair(image) : null;
  } catch {
    return null;
  }
}

/**
 * 算出一张发型图的修正量（单位是 256 画布坐标）：
 *   hair —— 发型层平移；face —— 发型挪不动时脸层补的余量。
 * 返回 null 表示这张图没有可用像素，按库里「左上角对齐、直接叠加」的原始约定画。
 *
 * 注意：这只是**诊断/参考**。库的「组合规则」要求两层同左上角直接叠加，
 * 所以 App 不会套用这个结果（见 AGENTS.md 第五节）。
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
    const hair = image ? measureHair(image) : null;
    if (hair) {
      // 需要的"相对位移"：脸相对发型要往右下挪多少
      const relX = hair.cx - (EYE_CX + TARGET_DX);
      const relY = (hair.fringe === null ? EYE_TOP - TARGET_GAP : hair.fringe) - (EYE_TOP - TARGET_GAP);
      // 优先挪发型（反向）：横向不能出画布；纵向允许削掉一点发顶
      //（这样就不用把"脸"往下推太多，免得整张脸沉到圆盘底部）
      const hairDx = Math.max(-hair.minX, Math.min(hair.width - 1 - hair.maxX, -relX));
      const hairDy = Math.max(-(hair.minY + ALLOW_CLIP), Math.min(hair.height - 1 - hair.maxY, -relY));
      result = {
        hair: { dx: Math.round(hairDx), dy: Math.round(hairDy) },
        face: {
          dx: Math.max(-CLAMP_FACE_X, Math.min(CLAMP_FACE_X, Math.round(relX + hairDx))),
          dy: Math.max(CLAMP_FACE_Y[0], Math.min(CLAMP_FACE_Y[1], Math.round(relY + hairDy))),
        },
        fringe: hair.fringe === null ? null : Math.round(hair.fringe),
      };
    }
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}