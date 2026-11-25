/**
 * 二维码编码器（自写，零外部依赖）。
 *
 * 契约要求插件能自己把扫码登录 URL 变成二维码图片，且不允许装 `qrcode` 之类的 npm
 * 包、不允许联网。所以这里内嵌一份完整的 QR 编码实现：
 *
 * - 字节模式（mode 0100），纠错等级 **M**，版本 1–10 自动选择（容量 14–213 字节）；
 * - Reed–Solomon 纠错（GF(256)，本原多项式 0x11D）；
 * - 定位/分隔/时序/校正图案、暗模块、格式信息（BCH 15,5 + 掩码 0x5412）、
 *   版本信息（BCH 18,6，版本 ≥7）、8 种掩码按标准四项惩罚分选优；
 * - 数据码字按标准之字形从右下角放置，功能模块不参与掩码。
 *
 * 对外三个入口：`qrMatrix`（矩阵，测试/调试用）、`renderQrPng`（PNG 字节）、
 * `createQr`（`lib/index.js` 装配用的薄包装，等价于把两个函数挂在一个对象上）。
 *
 * @module @local/bilibili/qr
 */

import { BiliError, CODES } from './errors.js';
import { encodePng } from './png.js';

/** 目前只实现的纠错等级（契约固定 M）。 */
const SUPPORTED_ECC = 'M';

/** 版本范围。 */
const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** 纠错等级 M、字节模式（mode 0100）下各版本的容量（字节）。 */
const BYTE_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/**
 * 纠错等级 M 的 RS 分块结构（版本 1–10）。
 * `eccPerBlock` 是每块纠错码字数；`groups` 是若干组 `[块数, 每块数据码字数]`。
 */
const BLOCK_SPECS_M = [
  { eccPerBlock: 10, groups: [[1, 16]] },
  { eccPerBlock: 16, groups: [[1, 28]] },
  { eccPerBlock: 26, groups: [[1, 44]] },
  { eccPerBlock: 18, groups: [[2, 32]] },
  { eccPerBlock: 24, groups: [[2, 43]] },
  { eccPerBlock: 16, groups: [[4, 27]] },
  { eccPerBlock: 18, groups: [[4, 31]] },
  { eccPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { eccPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { eccPerBlock: 26, groups: [[4, 43], [1, 44]] },
];

/** 各版本校正图案中心坐标（版本 1 没有）。 */
const ALIGNMENT_CENTERS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 掩码函数（row/col 从 0 起，返回 true 表示该数据模块取反）。 */
const MASK_FUNCTIONS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

/** 惩罚分权重（QR 规范）。 */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** 二维码文本编码（UTF-8）。 */
const textEncoder = new TextEncoder();

/**
 * GF(2^8) 指数表/对数表，本原多项式 0x11D。
 * 指数表多留一倍长度，乘法时可以直接相加对数值而不取模。
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    GF_EXP[index] = value;
    GF_LOG[value] = index;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let index = 255; index < GF_EXP.length; index += 1) GF_EXP[index] = GF_EXP[index - 255];
}

/**
 * GF(256) 乘法。
 * @param {number} left - 左操作数。
 * @param {number} right - 右操作数。
 * @returns {number} 乘积。
 */
function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

/**
 * 计算 RS 生成多项式 ∏(x − α^i)（i=0..degree-1）的系数，按幂次从高到低。
 * @param {number} degree - 纠错码字数。
 * @returns {Uint8Array} 生成多项式系数。
 */
function rsComputeDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let term = 0; term < degree; term += 1) {
      result[term] = gfMultiply(result[term], root);
      if (term + 1 < degree) result[term] ^= result[term + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/**
 * 计算一段数据码字的 RS 校验余式（即纠错码字）。
 * @param {Uint8Array} data - 数据码字。
 * @param {Uint8Array} divisor - 生成多项式系数。
 * @returns {Uint8Array} 纠错码字。
 */
function rsComputeRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let index = 0; index < divisor.length; index += 1) {
      result[index] ^= gfMultiply(divisor[index], factor);
    }
  }
  return result;
}

/**
 * 某个版本的数据码字总数。
 * @param {number} version - 版本 1–10。
 * @returns {number} 数据码字数（不含纠错）。
 */
function dataCodewordCount(version) {
  const spec = BLOCK_SPECS_M[version - 1];
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

/**
 * 按字节数选择最小可用版本。
 * @param {number} byteLength - 字节数。
 * @returns {number | null} 版本 1–10；放不下时 null。
 */
function chooseVersion(byteLength) {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    if (byteLength <= BYTE_CAPACITY_M[version - 1]) return version;
  }
  return null;
}

/**
 * 往比特数组追加定长整数（高位在前）。
 * @param {number[]} bits - 目标比特数组。
 * @param {number} value - 整数值。
 * @param {number} length - 比特数。
 */
function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
}

/**
 * 把负载字节编码成数据码字（含模式指示符、长度、终止符与填充码字）。
 * @param {Uint8Array} bytes - UTF-8 负载。
 * @param {number} version - 版本 1–10。
 * @returns {number[]} 数据码字。
 */
function buildDataCodewords(bytes, version) {
  const totalData = dataCodewordCount(version);
  const totalBits = totalData * 8;
  /** @type {number[]} */
  const bits = [];
  appendBits(bits, 0b0100, 4); // 字节模式
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16); // 字符计数指示符
  for (const byte of bytes) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, totalBits - bits.length)); // 终止符
  while (bits.length % 8 !== 0) bits.push(0);

  /** @type {number[]} */
  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    codewords.push(byte);
  }
  const pad = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < totalData) {
    codewords.push(pad[padIndex % 2]);
    padIndex += 1;
  }
  return codewords;
}

/**
 * 分块、算纠错码字并按标准交错，得到最终码字流。
 * @param {number[]} dataCodewords - 数据码字。
 * @param {number} version - 版本 1–10。
 * @returns {number[]} 交错后的码字。
 */
function interleaveBlocks(dataCodewords, version) {
  const spec = BLOCK_SPECS_M[version - 1];
  /** @type {Array<{ data: number[], ecc: Uint8Array }>} */
  const blocks = [];
  let offset = 0;
  for (const [count, blockSize] of spec.groups) {
    for (let index = 0; index < count; index += 1) {
      const data = dataCodewords.slice(offset, offset + blockSize);
      offset += blockSize;
      blocks.push({ data, ecc: rsComputeRemainder(Uint8Array.from(data), rsComputeDivisor(spec.eccPerBlock)) });
    }
  }

  /** @type {number[]} */
  const result = [];
  const maxDataLength = Math.max(...blocks.map((block) => block.data.length));
  for (let index = 0; index < maxDataLength; index += 1) {
    for (const block of blocks) if (index < block.data.length) result.push(block.data[index]);
  }
  for (let index = 0; index < spec.eccPerBlock; index += 1) {
    for (const block of blocks) result.push(block.ecc[index]);
  }
  return result;
}

/**
 * 造一个 size×size 的二维布尔网格。
 * @param {number} size - 边长。
 * @param {boolean} fill - 初始值。
 * @returns {boolean[][]} 网格。
 */
function createGrid(size, fill) {
  return Array.from({ length: size }, () => new Array(size).fill(fill));
}

/**
 * 把格式信息（15 位）写到矩阵的两个副本位置，并画暗模块。
 *
 * 位置与 QR 规范一致：左上角绕定位图案一圈，另一份分布在右上/左下。
 * @param {(row: number, col: number, dark: boolean) => void} write - 写入函数。
 * @param {number} size - 矩阵边长。
 * @param {number} mask - 掩码编号 0–7。
 */
function drawFormatBits(write, size, mask) {
  const data = (0b00 << 3) | mask; // 纠错等级 M 的两位是 00
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bitAt = (index) => ((bits >>> index) & 1) !== 0;

  // 第一份：左上角
  for (let index = 0; index <= 5; index += 1) write(index, 8, bitAt(index));
  write(7, 8, bitAt(6));
  write(8, 8, bitAt(7));
  write(8, 7, bitAt(8));
  for (let index = 9; index < 15; index += 1) write(8, 14 - index, bitAt(index));
  // 第二份：右上 + 左下
  for (let index = 0; index < 8; index += 1) write(8, size - 1 - index, bitAt(index));
  for (let index = 8; index < 15; index += 1) write(size - 15 + index, 8, bitAt(index));
  // 暗模块（固定为暗）
  write(size - 8, 8, true);
}

/**
 * 画所有与数据无关的功能图案（时序、定位、分隔、校正、版本、格式占位）。
 * @param {number} version - 版本 1–10。
 * @returns {{ size: number, modules: boolean[][], isFunction: boolean[][] }} 基础矩阵。
 */
function drawBasePatterns(version) {
  const size = version * 4 + 17;
  const modules = createGrid(size, false);
  const isFunction = createGrid(size, false);

  /**
   * 写一个功能模块。
   * @param {number} row - 行。
   * @param {number} col - 列。
   * @param {boolean} dark - 是否暗。
   */
  const set = (row, col, dark) => {
    modules[row][col] = dark;
    isFunction[row][col] = true;
  };

  // 1. 时序图案（先画；定位图案区域随后覆盖它，这是标准的叠放顺序）
  for (let index = 0; index < size; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }

  // 2. 三个定位图案 + 分隔符：以 7×7 为中心画 9×9，最外圈是浅色分隔符
  for (const [centerRow, centerCol] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let deltaRow = -4; deltaRow <= 4; deltaRow += 1) {
      for (let deltaCol = -4; deltaCol <= 4; deltaCol += 1) {
        const row = centerRow + deltaRow;
        const col = centerCol + deltaCol;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const distance = Math.max(Math.abs(deltaRow), Math.abs(deltaCol));
        if (distance === 4) set(row, col, false);
        else set(row, col, distance !== 2);
      }
    }
  }

  // 3. 校正图案（跳过与定位图案重叠的三个角）
  const centers = ALIGNMENT_CENTERS[version - 1];
  const lastCenter = size - 7;
  for (const centerRow of centers) {
    for (const centerCol of centers) {
      const overlapsFinder = (centerRow === 6 && centerCol === 6)
        || (centerRow === 6 && centerCol === lastCenter)
        || (centerRow === lastCenter && centerCol === 6);
      if (overlapsFinder) continue;
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaCol = -2; deltaCol <= 2; deltaCol += 1) {
          const distance = Math.max(Math.abs(deltaRow), Math.abs(deltaCol));
          set(centerRow + deltaRow, centerCol + deltaCol, distance !== 1);
        }
      }
    }
  }

  // 4. 版本信息（版本 ≥7）：18 位 BCH 码，两个副本
  if (version >= 7) {
    let remainder = version;
    for (let index = 0; index < 12; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) !== 0;
      const row = Math.floor(index / 3);
      const col = size - 11 + (index % 3);
      set(row, col, dark);
      set(col, row, dark);
    }
  }

  // 5. 格式信息先按掩码 0 占位，把相关模块标记成功能模块（数据放置要跳过它们）
  drawFormatBits(set, size, 0);

  return { size, modules, isFunction };
}

/**
 * 按标准之字形从右下角放置码字比特。
 * @param {number[]} codewords - 交错后的码字。
 * @param {boolean[][]} modules - 矩阵（就地写入）。
 * @param {boolean[][]} isFunction - 功能模块标记。
 */
function placeCodewords(codewords, modules, isFunction) {
  const size = modules.length;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖直时序图案所在列
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        if (isFunction[row][col] || bitIndex >= codewords.length * 8) continue;
        const dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        modules[row][col] = dark;
        bitIndex += 1;
      }
    }
  }
}

/**
 * 按四项标准规则给矩阵打惩罚分（用于选掩码）。
 * @param {boolean[][]} modules - 矩阵。
 * @returns {number} 惩罚分。
 */
function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  /**
   * 统计一条线（行或列）上的连续同色与类定位图案。
   * @param {(index: number) => boolean} getter - 取线上的第 index 个模块。
   */
  const scanLine = (getter) => {
    let runColor = getter(0);
    let runLength = 1;
    for (let index = 1; index < size; index += 1) {
      const color = getter(index);
      if (color === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);
        runColor = color;
        runLength = 1;
      }
    }
    if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);

    // 类定位图案 1:1:3:1:1，前后任一侧要有 4 个浅色模块
    const patterns = [[1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]];
    for (let start = 0; start + 11 <= size; start += 1) {
      for (const pattern of patterns) {
        let matched = true;
        for (let index = 0; index < 11; index += 1) {
          if (getter(start + index) !== (pattern[index] === 1)) {
            matched = false;
            break;
          }
        }
        if (matched) score += PENALTY_N3;
      }
    }
  };

  for (let row = 0; row < size; row += 1) scanLine((index) => modules[row][index]);
  for (let col = 0; col < size; col += 1) scanLine((index) => modules[index][col]);

  // 2×2 同色方块
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const color = modules[row][col];
      if (modules[row][col + 1] === color && modules[row + 1][col] === color && modules[row + 1][col + 1] === color) {
        score += PENALTY_N2;
      }
    }
  }

  // 暗色占比偏离 50% 的程度
  let darkCount = 0;
  for (const row of modules) {
    for (const cell of row) if (cell) darkCount += 1;
  }
  const total = size * size;
  const deviation = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  score += Math.max(0, deviation) * PENALTY_N4;
  return score;
}

/**
 * 深拷贝一个布尔网格。
 * @param {boolean[][]} grid - 网格。
 * @returns {boolean[][]} 副本。
 */
function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

/**
 * 建矩阵：画功能图案、放数据、八种掩码逐一试算并按惩罚分选最优。
 * @param {number[]} codewords - 交错后的码字。
 * @param {number} version - 版本 1–10。
 * @param {number | undefined} forcedMask - 指定掩码（仅调试/交叉验证用，正常流程传 undefined）。
 * @returns {boolean[][]} 最终矩阵（true 为暗）。
 */
function buildMatrix(codewords, version, forcedMask) {
  const { size, modules: base, isFunction } = drawBasePatterns(version);
  placeCodewords(codewords, base, isFunction);

  /**
   * 按掩码生成候选矩阵。
   * @param {number} mask - 掩码编号。
   * @returns {boolean[][]} 候选矩阵。
   */
  const candidateFor = (mask) => {
    const candidate = cloneGrid(base);
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (!isFunction[row][col] && MASK_FUNCTIONS[mask](row, col)) candidate[row][col] = !candidate[row][col];
      }
    }
    drawFormatBits((row, col, dark) => {
      candidate[row][col] = dark;
    }, size, mask);
    return candidate;
  };

  if (forcedMask !== undefined) return candidateFor(forcedMask);

  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestModules = null;
  for (let mask = 0; mask < MASK_FUNCTIONS.length; mask += 1) {
    const candidate = candidateFor(mask);
    const penalty = penaltyScore(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestModules = candidate;
    }
  }
  return bestModules;
}

/**
 * 生成二维码矩阵。
 * @param {string} text - 要编码的文本（按 UTF-8 编码成字节模式）。
 * @param {{ ecc?: string, mask?: number }} [options] - 选项；`ecc` 目前只允许 `'M'`；
 *   `mask` 是掩码覆盖（0–7），仅交叉验证/调试用，正常调用不要传（会按惩罚分自动选）。
 * @returns {boolean[][]} 矩阵，`true` 表示暗模块，下标是 `[row][col]`。
 * @throws {BiliError} 内容过长、类型不对或纠错等级不支持时。
 */
export function qrMatrix(text, options = {}) {
  const ecc = options.ecc === undefined ? SUPPORTED_ECC : String(options.ecc).toUpperCase();
  if (ecc !== SUPPORTED_ECC) {
    throw new BiliError(`二维码纠错等级只支持 ${SUPPORTED_ECC}，收到 ${JSON.stringify(options.ecc)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '契约固定用 M；调用方通常不需要传 ecc。',
    });
  }
  if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) {
    throw new BiliError(`二维码 mask 必须是 0–7 的整数，收到 ${JSON.stringify(options.mask)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '不传时按惩罚分自动选择最佳掩码。',
    });
  }
  if (typeof text !== 'string') {
    throw new BiliError('二维码内容必须是字符串。', {
      code: CODES.INVALID_ARGUMENT,
      hint: '把要编码的 URL 或文本作为第一个参数传入。',
    });
  }

  const bytes = textEncoder.encode(text);
  const version = chooseVersion(bytes.length);
  if (version === null) {
    throw new BiliError(`二维码内容过长：${bytes.length} 字节，最多支持 ${BYTE_CAPACITY_M[MAX_VERSION - 1]} 字节（版本 ${MAX_VERSION}、纠错等级 M、字节模式）。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '缩短 URL（例如改用 b23.tv 短链）后再生成二维码。',
    });
  }

  const dataCodewords = buildDataCodewords(bytes, version);
  const codewords = interleaveBlocks(dataCodewords, version);
  return buildMatrix(codewords, version, options.mask);
}

/**
 * 校验缩放倍数。
 * @param {unknown} value - 原始值。
 * @returns {number} 合法的整数倍数。
 */
function normalizeScale(value) {
  const scale = value === undefined ? 6 : value;
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) {
    throw new BiliError(`二维码 scale 必须是 1–64 的整数，收到 ${JSON.stringify(value)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '不传时默认 6（每个模块 6 像素）。',
    });
  }
  return scale;
}

/**
 * 校验静区宽度（模块数）。
 * @param {unknown} value - 原始值。
 * @returns {number} 合法的整数静区。
 */
function normalizeMargin(value) {
  const margin = value === undefined ? 4 : value;
  if (!Number.isInteger(margin) || margin < 0 || margin > 16) {
    throw new BiliError(`二维码 margin 必须是 0–16 的整数，收到 ${JSON.stringify(value)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '不传时默认 4（QR 规范要求至少 4 个模块的静区）。',
    });
  }
  return margin;
}

/**
 * 把文本渲染成二维码 PNG。
 *
 * 像素布局：`(矩阵边长 + 2×margin) × scale` 的正方形，黑模块为不透明黑，其余为不透明白。
 * @param {string} text - 要编码的文本。
 * @param {{ scale?: number, margin?: number, ecc?: string }} [options] - 渲染选项。
 * @returns {Buffer} PNG 字节。
 * @throws {BiliError} 参数不合法或内容过长时。
 */
export function renderQrPng(text, options = {}) {
  const matrix = qrMatrix(text, options);
  const size = matrix.length;
  const scale = normalizeScale(options.scale);
  const margin = normalizeMargin(options.margin);
  const dimension = (size + margin * 2) * scale;

  // 先整块填白（RGBA 全 0xFF），再画黑模块。
  const rgba = Buffer.alloc(dimension * dimension * 4, 0xff);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!matrix[row][col]) continue;
      for (let pixelRow = 0; pixelRow < scale; pixelRow += 1) {
        let offset = (((row + margin) * scale + pixelRow) * dimension + (col + margin) * scale) * 4;
        for (let pixelCol = 0; pixelCol < scale; pixelCol += 1) {
          rgba[offset] = 0;
          rgba[offset + 1] = 0;
          rgba[offset + 2] = 0;
          offset += 4;
        }
      }
    }
  }

  return encodePng({ width: dimension, height: dimension, rgba });
}

/**
 * 造一个二维码服务对象（`lib/index.js` 用 `deps.qr` 传给工具层）。
 * @returns {{ qrMatrix: Function, renderQrPng: Function, renderPng: Function }} 服务。
 */
export function createQr() {
  return { qrMatrix, renderQrPng, renderPng: renderQrPng };
}
