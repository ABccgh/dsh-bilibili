/**
 * `lib/qr.js` + `lib/png.js` 的离线测试。
 *
 * 正确性依据分三层（不依赖任何 npm 包、不联网）：
 * 1. **交叉验证**：`test/fixtures/t3-qr-reference.json` 是独立成熟实现（goQR.me 的
 *    `api.qrserver.com`，ecc=M、margin=0）生成的参考矩阵。测试要求我们的编码器在与参考
 *    相同的掩码下**逐模块完全一致**（掩码只是 8 种等价合法方案之一，所以用 `mask` 覆盖
 *    对齐后再比较其余全部比特）。
 * 2. **独立解码**：测试里另写了一份解码器（重建功能模块图、去掩码、之字形取码字、
 *    反交错、RS 校验子、解析字节模式负载），把参考矩阵和我们自己的矩阵都解回原文。
 * 3. **结构断言**：定位图案/分隔符/时序图案/暗模块/格式信息 BCH/版本信息 BCH/版本容量边界。
 *
 * PNG 用 chunk 级校验：签名、每块 CRC32、IHDR 字段、IDAT inflate 后每行过滤字节为 0、
 * 像素与输入 RGBA 一致；`renderQrPng` 再验证像素尺寸与矩阵/缩放/静区一致。
 *
 * @module test/qr.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { BiliError, CODES } from '../lib/errors.js';
import { encodePng, imageSizePng, pngDimensions } from '../lib/png.js';
import { createQr, qrMatrix, renderQrPng } from '../lib/qr.js';
import { readFixtureJson } from './helpers.js';

/** PNG 签名。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 纠错等级 M、字节模式容量（版本 1–10）。 */
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** 纠错等级 M 的 RS 分块结构（测试侧独立抄写，用于反交错与校验子）。 */
const BLOCKS_M = [
  { eccLen: 10, groups: [[1, 16]] },
  { eccLen: 16, groups: [[1, 28]] },
  { eccLen: 26, groups: [[1, 44]] },
  { eccLen: 18, groups: [[2, 32]] },
  { eccLen: 24, groups: [[2, 43]] },
  { eccLen: 16, groups: [[4, 27]] },
  { eccLen: 18, groups: [[4, 31]] },
  { eccLen: 22, groups: [[2, 38], [2, 39]] },
  { eccLen: 22, groups: [[3, 36], [2, 37]] },
  { eccLen: 26, groups: [[4, 43], [1, 44]] },
];

/** 校正图案中心坐标（版本 1–10）。 */
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

/**
 * 独立实现的 CRC32（PNG chunk 校验用）。
 * @param {Buffer} bytes - 输入。
 * @returns {number} CRC。
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 按 PNG chunk 切开并校验结构。
 * @param {Buffer} png - PNG 字节。
 * @returns {Array<{ type: string, data: Buffer, crcOk: boolean }>} chunk 列表。
 */
function readChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const storedCrc = png.readUInt32BE(offset + 8 + length);
    const expected = crc32(png.subarray(offset + 4, offset + 8 + length));
    chunks.push({ type, data, crcOk: storedCrc === expected });
    offset += 12 + length;
  }
  return chunks;
}

/**
 * 把 0/1 字符串行转成布尔矩阵。
 * @param {string[]} rows - 0/1 行。
 * @returns {boolean[][]} 矩阵。
 */
function rowsToMatrix(rows) {
  return rows.map((row) => [...row].map((char) => char === '1'));
}

/**
 * 读格式信息（15 位）并解析纠错等级与掩码。
 * 两位纠错码含义：0=M、1=L、2=H、3=Q。
 * @param {boolean[][]} matrix - 矩阵。
 * @returns {{ ecc: string, mask: number, raw: number }} 格式信息。
 */
function readFormatInfo(matrix) {
  const size = matrix.length;
  let value = 0;
  for (let index = 0; index < 15; index += 1) {
    let bit = false;
    if (index <= 5) bit = matrix[index][8];
    else if (index === 6) bit = matrix[7][8];
    else if (index === 7) bit = matrix[8][8];
    else if (index === 8) bit = matrix[8][7];
    else bit = matrix[8][14 - index];
    value |= (bit ? 1 : 0) << index;
  }
  const dataBits = (value ^ 0x5412) >>> 10;
  return {
    ecc: 'MLHQ'[(dataBits >> 3) & 0b11],
    mask: dataBits & 0b111,
    raw: value,
  };
}

/**
 * 读版本信息（仅版本 ≥7 存在），并做 BCH 校验。
 * @param {boolean[][]} matrix - 矩阵。
 * @returns {{ version: number, bchOk: boolean }} 版本信息。
 */
function readVersionInfo(matrix) {
  const size = matrix.length;
  let value = 0;
  for (let index = 0; index < 18; index += 1) {
    const row = Math.floor(index / 3);
    const col = size - 11 + (index % 3);
    value |= (matrix[row][col] ? 1 : 0) << index;
  }
  let remainder = value;
  for (let index = 17; index >= 12; index -= 1) {
    if (((remainder >>> index) & 1) !== 0) remainder ^= 0x1f25 << (index - 12);
  }
  return { version: value >>> 12, bchOk: remainder === 0 };
}

/**
 * 重建「功能模块」图（独立实现，供解码器与断言使用）。
 * @param {number} version - 版本 1–10。
 * @returns {boolean[][]} 功能模块标记。
 */
function rebuildFunctionMap(version) {
  const size = version * 4 + 17;
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (row, col) => {
    isFunction[row][col] = true;
  };
  // 左上 9×9（定位 + 分隔 + 格式）
  for (let row = 0; row < 9; row += 1) for (let col = 0; col < 9; col += 1) mark(row, col);
  // 右上 9 行 × 8 列（定位 + 分隔 + 格式行）
  for (let row = 0; row < 9; row += 1) for (let col = size - 8; col < size; col += 1) mark(row, col);
  // 左下 8 行 × 9 列（定位 + 分隔 + 格式列 + 暗模块）
  for (let row = size - 8; row < size; row += 1) for (let col = 0; col < 9; col += 1) mark(row, col);
  // 时序图案（整行/整列，与定位重叠的部分本来也是功能模块）
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  // 校正图案
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
          mark(centerRow + deltaRow, centerCol + deltaCol);
        }
      }
    }
  }
  // 版本信息（≥7）
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      const row = Math.floor(index / 3);
      const col = size - 11 + (index % 3);
      mark(row, col);
      mark(col, row);
    }
  }
  return isFunction;
}

/**
 * 掩码条件（独立实现）。
 * @param {number} mask - 掩码编号。
 * @param {number} row - 行。
 * @param {number} col - 列。
 * @returns {boolean} 是否取反。
 */
function maskAt(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new Error(`非法掩码 ${mask}`);
  }
}

/** 测试侧独立的 GF(2^8) 表（本原多项式 0x11D）。 */
const GF_EXP = (() => {
  const table = new Uint8Array(512);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    table[index] = value;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) table[index] = table[index - 255];
  return table;
})();
const GF_LOG = (() => {
  const table = new Uint8Array(256);
  for (let index = 0; index < 255; index += 1) table[GF_EXP[index]] = index;
  return table;
})();

/**
 * GF(256) 乘法（测试侧独立实现）。
 * @param {number} left - 左操作数。
 * @param {number} right - 右操作数。
 * @returns {number} 乘积。
 */
function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[(GF_LOG[left] + GF_LOG[right]) % 255];
}

/**
 * 把一组码字按 QR 规范反交错。
 * @param {number[]} codewords - 交错后的码字。
 * @param {number} version - 版本 1–10。
 * @returns {{ blocks: Array<{ data: number[], ecc: number[] }>, eccLen: number }} 反交错结果。
 */
function deinterleave(codewords, version) {
  const spec = BLOCKS_M[version - 1];
  /** @type {Array<{ data: number[], ecc: number[], dataLen: number }>} */
  const blocks = [];
  for (const [count, dataLen] of spec.groups) {
    for (let index = 0; index < count; index += 1) blocks.push({ dataLen, data: [], ecc: [] });
  }
  let cursor = 0;
  const maxDataLen = Math.max(...blocks.map((block) => block.dataLen));
  for (let index = 0; index < maxDataLen; index += 1) {
    for (const block of blocks) if (index < block.dataLen) block.data.push(codewords[cursor++]);
  }
  for (let index = 0; index < spec.eccLen; index += 1) {
    for (const block of blocks) block.ecc.push(codewords[cursor++]);
  }
  return { blocks, eccLen: spec.eccLen };
}

/**
 * 校验一块码字在 α^0…α^(eccLen-1) 处的 RS 校验子是否全为 0。
 * @param {{ data: number[], ecc: number[] }} block - 一块码字。
 * @param {number} eccLen - 纠错码字数。
 * @returns {boolean} 是否全部为 0。
 */
function rsSyndromesZero(block, eccLen) {
  const bytes = [...block.data, ...block.ecc];
  for (let root = 0; root < eccLen; root += 1) {
    const x = GF_EXP[root];
    let value = 0;
    for (const byte of bytes) value = gfMultiply(value, x) ^ byte;
    if (value !== 0) return false;
  }
  return true;
}

/**
 * 独立解码一个二维码矩阵：取码字 → 反交错 → RS 校验 → 解析字节模式负载。
 * @param {boolean[][]} matrix - 矩阵。
 * @returns {{ text: string, version: number, ecc: string, mask: number, blocksOk: boolean,
 *   paddingOk: boolean, totalCodewords: number }} 解码结果。
 */
function decodeMatrix(matrix) {
  const size = matrix.length;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 10, `矩阵边长 ${size} 不是合法二维码尺寸`);
  const format = readFormatInfo(matrix);
  const isFunction = rebuildFunctionMap(version);
  const spec = BLOCKS_M[version - 1];
  const totalCodewords = spec.groups.reduce((sum, [count, dataLen]) => sum + count * (dataLen + spec.eccLen), 0);

  /** @type {number[]} */
  const bits = [];
  outer: for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        if (isFunction[row][col]) continue;
        if (bits.length >= totalCodewords * 8) break outer;
        const raw = matrix[row][col] ? 1 : 0;
        bits.push(raw ^ (maskAt(format.mask, row, col) ? 1 : 0));
      }
    }
  }
  assert.equal(bits.length, totalCodewords * 8, '数据模块数量不足以放下全部码字');

  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | bits[index + offset];
    codewords.push(value);
  }

  const { blocks, eccLen } = deinterleave(codewords, version);
  const blocksOk = blocks.every((block) => rsSyndromesZero(block, eccLen));
  const dataCodewords = blocks.flatMap((block) => block.data);

  // 解析比特流
  let cursor = 0;
  const readBits = (count) => {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = dataCodewords[cursor >>> 3];
      const bit = (byte >>> (7 - (cursor & 7))) & 1;
      value = (value << 1) | bit;
      cursor += 1;
    }
    return value;
  };
  const mode = readBits(4);
  assert.equal(mode, 0b0100, '负载模式不是字节模式（0100）');
  const length = readBits(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let index = 0; index < length; index += 1) bytes.push(readBits(8));

  // 校验终止符 + 填充码字（0xEC/0x11 交替）
  let paddingOk = true;
  const remaining = dataCodewords.length * 8 - cursor;
  for (let index = 0; index < Math.min(4, remaining); index += 1) {
    if (readBits(1) !== 0) paddingOk = false;
  }
  while (cursor % 8 !== 0 && cursor < dataCodewords.length * 8) {
    if (readBits(1) !== 0) paddingOk = false;
  }
  const padValues = [0xec, 0x11];
  let padIndex = 0;
  while (cursor < dataCodewords.length * 8) {
    if (readBits(8) !== padValues[padIndex % 2]) paddingOk = false;
    padIndex += 1;
  }

  return {
    text: new TextDecoder().decode(Uint8Array.from(bytes)),
    version,
    ecc: format.ecc,
    mask: format.mask,
    blocksOk,
    paddingOk,
    totalCodewords,
  };
}

/**
 * 断言三个定位图案与分隔符的形状。
 * @param {boolean[][]} matrix - 矩阵。
 */
function assertFinderPatterns(matrix) {
  const size = matrix.length;
  for (const [topRow, leftCol] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let deltaRow = 0; deltaRow < 7; deltaRow += 1) {
      for (let deltaCol = 0; deltaCol < 7; deltaCol += 1) {
        const expected = deltaRow === 0 || deltaRow === 6 || deltaCol === 0 || deltaCol === 6
          || (deltaRow >= 2 && deltaRow <= 4 && deltaCol >= 2 && deltaCol <= 4);
        assert.equal(
          matrix[topRow + deltaRow][leftCol + deltaCol],
          expected,
          `定位图案 (${topRow + deltaRow},${leftCol + deltaCol}) 形状不对`,
        );
      }
    }
  }
  // 分隔符：定位图案外侧一圈全浅
  for (let index = 0; index < 8; index += 1) {
    assert.equal(matrix[7][index], false);
    assert.equal(matrix[index][7], false);
    assert.equal(matrix[7][size - 1 - index], false);
    assert.equal(matrix[index][size - 8], false);
    assert.equal(matrix[size - 8][index], false);
    assert.equal(matrix[size - 1 - index][7], false);
  }
}

/**
 * 断言时序图案。
 * @param {boolean[][]} matrix - 矩阵。
 */
function assertTimingPatterns(matrix) {
  const size = matrix.length;
  for (let index = 8; index <= size - 9; index += 1) {
    assert.equal(matrix[6][index], index % 2 === 0, `时序图案 row6 col${index} 不对`);
    assert.equal(matrix[index][6], index % 2 === 0, `时序图案 col6 row${index} 不对`);
  }
}

/**
 * 断言一个校正图案（5×5）。
 * @param {boolean[][]} matrix - 矩阵。
 * @param {number} centerRow - 中心行。
 * @param {number} centerCol - 中心列。
 */
function assertAlignmentPattern(matrix, centerRow, centerCol) {
  for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
    for (let deltaCol = -2; deltaCol <= 2; deltaCol += 1) {
      const distance = Math.max(Math.abs(deltaRow), Math.abs(deltaCol));
      assert.equal(matrix[centerRow + deltaRow][centerCol + deltaCol], distance !== 1, '校正图案形状不对');
    }
  }
}

test('png: encodePng 产出合法 PNG（签名 / chunk CRC / IHDR / IDAT 过滤字节 / 像素）', () => {
  const width = 3;
  const height = 2;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = index * 10;
    rgba[index * 4 + 1] = 255 - index * 10;
    rgba[index * 4 + 2] = index * 5;
    rgba[index * 4 + 3] = 255;
  }
  const png = encodePng({ width, height, rgba });
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE, 'PNG 签名不对');

  const chunks = readChunks(png);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  for (const chunk of chunks) assert.equal(chunk.crcOk, true, `${chunk.type} 的 CRC32 不对`);

  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(ihdr.readUInt32BE(0), width);
  assert.equal(ihdr.readUInt32BE(4), height);
  assert.equal(ihdr[8], 8); // 位深
  assert.equal(ihdr[9], 6); // RGBA
  assert.equal(ihdr[10], 0);
  assert.equal(ihdr[11], 0);
  assert.equal(ihdr[12], 0);
  assert.equal(chunks[2].data.length, 0);

  const raw = zlib.inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    assert.equal(raw[row * (1 + width * 4)], 0, '行过滤字节必须为 0');
    for (let col = 0; col < width * 4; col += 1) {
      assert.equal(raw[row * (1 + width * 4) + 1 + col], rgba[row * width * 4 + col], '像素值被改写');
    }
  }

  assert.deepEqual(pngDimensions(png), { width, height });
  assert.deepEqual(imageSizePng(png), { width, height });
});

test('png: 非法输入抛 TypeError', () => {
  assert.throws(() => encodePng({ width: 0, height: 1, rgba: Buffer.alloc(4) }), TypeError);
  assert.throws(() => encodePng({ width: 2, height: 2, rgba: Buffer.alloc(4) }), TypeError);
  assert.throws(() => pngDimensions(Buffer.from('not a png')), TypeError);
});

test('qr: 版本自动选择符合容量边界（14/26/42/62/84/106/122/152/180/213 字节）', () => {
  for (let version = 1; version <= CAPACITY_M.length; version += 1) {
    const atCapacity = qrMatrix('a'.repeat(CAPACITY_M[version - 1]));
    assert.equal(atCapacity.length, version * 4 + 17, `容量 ${CAPACITY_M[version - 1]} 字节应为版本 ${version}`);
    assert.equal(atCapacity.length % 4, 1);
    if (version > 1) {
      const overPrevious = qrMatrix('a'.repeat(CAPACITY_M[version - 2] + 1));
      assert.equal(overPrevious.length, version * 4 + 17, `超过上一版本容量一个字节应升到版本 ${version}`);
    }
  }
});

test('qr: 与独立实现（goQR.me）的参考矩阵逐模块一致（版本 1–10）', () => {
  const fixture = readFixtureJson('t3-qr-reference.json');
  assert.ok(Array.isArray(fixture.entries) && fixture.entries.length >= 12, '参考 fixture 条目不足');
  const versionsSeen = new Set();
  for (const entry of fixture.entries) {
    const reference = rowsToMatrix(entry.rows);
    const size = reference.length;
    assert.equal(size, entry.size);
    const mine = qrMatrix(entry.payload, { mask: entry.mask });
    assert.equal(mine.length, size, `版本尺寸不一致：${JSON.stringify(entry.payload.slice(0, 16))}`);
    const difference = mine.reduce(
      (count, row, rowIndex) => count + row.reduce((sum, cell, colIndex) => sum + ((cell ? 1 : 0) !== Number(entry.rows[rowIndex][colIndex]) ? 1 : 0), 0),
      0,
    );
    assert.equal(difference, 0, `与参考矩阵有 ${difference} 个模块不一致：${JSON.stringify(entry.payload.slice(0, 24))}`);
    // 参考矩阵的格式信息必须是 ECC M，且掩码与 fixture 记录一致
    const format = readFormatInfo(reference);
    assert.equal(format.ecc, 'M', '参考矩阵不是 ECC M');
    assert.equal(format.mask, entry.mask);
    versionsSeen.add((size - 17) / 4);
  }
  for (let version = 1; version <= 10; version += 1) {
    assert.equal(versionsSeen.has(version), true, `参考 fixture 缺少版本 ${version}`);
  }
});

test('qr: 独立解码器能解回参考矩阵的负载（含 UTF-8）并验证 RS/填充', () => {
  const fixture = readFixtureJson('t3-qr-reference.json');
  for (const entry of fixture.entries) {
    const decoded = decodeMatrix(rowsToMatrix(entry.rows));
    assert.equal(decoded.text, entry.payload, `参考矩阵解出的文本不对：${JSON.stringify(entry.payload.slice(0, 24))}`);
    assert.equal(decoded.version, (entry.size - 17) / 4);
    assert.equal(decoded.ecc, 'M');
    assert.equal(decoded.mask, entry.mask);
    assert.equal(decoded.blocksOk, true, '参考矩阵 RS 校验子不为 0（反交错/分块表有误）');
    assert.equal(decoded.paddingOk, true, '参考矩阵的终止符或填充码字不符合规范');
  }
});

test('qr: 自己生成的矩阵能被独立解码器还原（版本 1–10 全量采样）', () => {
  for (let version = 1; version <= 10; version += 1) {
    const capacity = CAPACITY_M[version - 1];
    const payload = `v${version}:` + 'k'.repeat(capacity - String(version).length - 2);
    assert.equal(Buffer.byteLength(payload), capacity);
    const matrix = qrMatrix(payload);
    const decoded = decodeMatrix(matrix);
    assert.equal(decoded.text, payload);
    assert.equal(decoded.version, version);
    assert.equal(decoded.ecc, 'M');
    assert.equal(decoded.blocksOk, true);
    assert.equal(decoded.paddingOk, true);
  }
  // UTF-8 多字节负载（中文按 3 字节/字，走字节模式）
  const chinese = '登录 B 站：这是一个测试二维码';
  const chineseMatrix = qrMatrix(chinese);
  assert.equal(decodeMatrix(chineseMatrix).text, chinese);
});

test('qr: 定位图案 / 分隔符 / 时序图案 / 暗模块 / 校正图案形状正确', () => {
  for (const version of [1, 2, 6, 7, 10]) {
    const payload = 's'.repeat(CAPACITY_M[version - 1]);
    const matrix = qrMatrix(payload, { mask: 0 });
    const size = version * 4 + 17;
    assertFinderPatterns(matrix);
    assertTimingPatterns(matrix);
    assert.equal(matrix[size - 8][8], true, '暗模块必须是暗的');
    const centers = ALIGNMENT_CENTERS[version - 1];
    const lastCenter = size - 7;
    for (const centerRow of centers) {
      for (const centerCol of centers) {
        const overlapsFinder = (centerRow === 6 && centerCol === 6)
          || (centerRow === 6 && centerCol === lastCenter)
          || (centerRow === lastCenter && centerCol === 6);
        if (!overlapsFinder) assertAlignmentPattern(matrix, centerRow, centerCol);
      }
    }
  }
});

test('qr: 格式信息 BCH 与版本信息 BCH 自洽', () => {
  for (const version of [1, 6, 7, 10]) {
    const matrix = qrMatrix('z'.repeat(CAPACITY_M[version - 1]));
    const format = readFormatInfo(matrix);
    assert.equal(format.ecc, 'M');
    assert.ok(format.mask >= 0 && format.mask <= 7);
    // 15 位格式串先去掉固定的 0x5412 掩码，再做 BCH(15,5) 余式校验
    let remainder = format.raw ^ 0x5412;
    for (let index = 14; index >= 10; index -= 1) {
      if (((remainder >>> index) & 1) !== 0) remainder ^= 0x537 << (index - 10);
    }
    assert.equal(remainder, 0, '格式信息 BCH 校验失败');

    const versionInfo = readVersionInfo(matrix);
    if (version >= 7) {
      assert.equal(versionInfo.bchOk, true, '版本信息 BCH 校验失败');
      assert.equal(versionInfo.version, version);
    }
  }
});

test('qr: 掩码自动选择是确定的，且每个掩码都能被解码', () => {
  const payload = 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=0a1b2c3d4e5f';
  const first = qrMatrix(payload);
  const second = qrMatrix(payload);
  assert.deepEqual(first, second, '同样输入两次生成的矩阵必须一致');
  for (let mask = 0; mask < 8; mask += 1) {
    const decoded = decodeMatrix(qrMatrix(payload, { mask }));
    assert.equal(decoded.text, payload);
    assert.equal(decoded.mask, mask);
    assert.equal(decoded.blocksOk, true);
  }
});

test('qr: 超长 / 非字符串 / 非法 ecc / 非法 mask 抛 BILI_INVALID_ARGUMENT', () => {
  assert.throws(
    () => qrMatrix('x'.repeat(CAPACITY_M[CAPACITY_M.length - 1] + 1)),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => qrMatrix(123),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => qrMatrix('x', { ecc: 'H' }),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => qrMatrix('x', { mask: 8 }),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  // 空字符串是合法的空负载
  assert.equal(qrMatrix('').length, 21);
});

test('renderQrPng: PNG 尺寸与矩阵/缩放/静区一致，黑模块画黑、静区画白', () => {
  const text = '登录测试 qr png';
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const scale = 3;
  const margin = 2;
  const png = renderQrPng(text, { scale, margin });
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);

  const dimension = (size + margin * 2) * scale;
  assert.deepEqual(pngDimensions(png), { width: dimension, height: dimension });

  const chunks = readChunks(png);
  const raw = zlib.inflateSync(chunks[1].data);
  const rowBytes = 1 + dimension * 4;
  assert.equal(raw.length, dimension * rowBytes);
  /**
   * 取某个像素的 RGBA。
   * @param {number} x - x。
   * @param {number} y - y。
   * @returns {number[]} RGBA。
   */
  const pixelAt = (x, y) => {
    const offset = y * rowBytes + 1 + x * 4;
    return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
  };
  // 左上角静区全白
  assert.deepEqual(pixelAt(0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixelAt(margin * scale - 1, margin * scale - 1), [255, 255, 255, 255]);
  // 模块 (0,0)（定位图案，必为暗）中心像素是黑
  assert.deepEqual(pixelAt(margin * scale + 1, margin * scale + 1), [0, 0, 0, 255]);
  // 右下角静区全白
  assert.deepEqual(pixelAt(dimension - 1, dimension - 1), [255, 255, 255, 255]);
  // 逐模块核对：暗模块取模块中心像素应为黑，浅模块应为白
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const x = (col + margin) * scale + Math.floor(scale / 2);
      const y = (row + margin) * scale + Math.floor(scale / 2);
      const pixel = pixelAt(x, y);
      assert.deepEqual(pixel, matrix[row][col] ? [0, 0, 0, 255] : [255, 255, 255, 255], `模块 (${row},${col}) 像素颜色不对`);
    }
  }
});

test('renderQrPng: 默认 scale=6 / margin=4，非法参数抛错', () => {
  const text = 'default options';
  const png = renderQrPng(text);
  const size = qrMatrix(text).length;
  assert.deepEqual(pngDimensions(png), { width: (size + 8) * 6, height: (size + 8) * 6 });
  assert.throws(
    () => renderQrPng(text, { scale: 0 }),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => renderQrPng(text, { scale: 2.5 }),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => renderQrPng(text, { margin: -1 }),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
});

test('createQr: 装配对象暴露 renderPng / qrMatrix，且与具名导出一致', () => {
  const service = createQr();
  assert.equal(typeof service.renderPng, 'function');
  assert.equal(typeof service.qrMatrix, 'function');
  assert.equal(service.renderPng('abc') instanceof Uint8Array, true);
  assert.deepEqual(service.qrMatrix('abc'), qrMatrix('abc'));
  assert.deepEqual(Buffer.from(service.renderPng('abc')), renderQrPng('abc'));
});
