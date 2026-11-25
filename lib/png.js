/**
 * 最小 PNG 编码器（自写，零外部依赖）。
 *
 * 只做一件事：把 RGBA 像素缓冲编码成合法 PNG。实现方式是 PNG 规范里最朴素的组合：
 * 8 位 RGBA（color type 6）+ 每行过滤类型 0（None）+ zlib deflate 单 IDAT + IEND。
 * 每个 chunk 都按规范算 CRC32，所以产物可以通过任何标准解码器（浏览器、`file`、
 * Python 的 zlib/Pillow 等）解析。
 *
 * 为什么要自己写：插件零依赖（不能装 `pngjs`/`sharp`），而二维码附件只需要这一条路径。
 *
 * @module @local/bilibili/png
 */

import zlib from 'node:zlib';

/** PNG 文件签名：89 50 4E 47 0D 0A 1A 0A。 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 位深（8 位）。 */
const BIT_DEPTH = 8;

/** PNG 颜色类型：6 = 真彩色 + Alpha。 */
const COLOR_TYPE_RGBA = 6;

/** CRC32 查找表（多项式 0xEDB88320，即反射后的 0x04C11DB7）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32（PNG chunk 用）。
 * @param {Buffer} bytes - 输入字节。
 * @returns {number} 无符号 32 位 CRC。
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 组一个 PNG chunk：长度(4) + 类型(4) + 数据 + CRC32(4)。
 * @param {string} type - 4 字节 ASCII 类型（如 `IHDR`）。
 * @param {Buffer} data - chunk 数据。
 * @returns {Buffer} 完整 chunk。
 */
function buildChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * 校验并归一输入。
 * @param {{ width: number, height: number, rgba: Uint8Array | Buffer }} input - 像素输入。
 * @returns {{ width: number, height: number, pixels: Buffer }} 归一结果。
 * @throws {TypeError} 尺寸不是正整数，或像素缓冲长度不为 width*height*4 时。
 */
function normalizeInput(input) {
  const width = input?.width;
  const height = input?.height;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError('encodePng 需要正整数 width/height。');
  }
  const rgba = input?.rgba;
  if (rgba === undefined || rgba === null) throw new TypeError('encodePng 需要 rgba 像素缓冲。');
  const pixels = Buffer.isBuffer(rgba)
    ? rgba
    : (rgba instanceof Uint8Array)
      ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
      : Buffer.from(rgba);
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new TypeError(`encodePng 的像素缓冲长度应为 ${expected} 字节（${width}×${height}×4），实际 ${pixels.length}。`);
  }
  return { width, height, pixels };
}

/**
 * 把 RGBA 像素编码成 PNG 字节。
 *
 * 行过滤固定为 0（None）：二维码是纯黑纯白的大色块，deflate 已经能压到很小，
 * 再加自适应过滤只增加复杂度不增加收益。
 * @param {{ width: number, height: number, rgba: Uint8Array | Buffer }} input - 像素。
 * @returns {Buffer} PNG 字节。
 * @throws {TypeError} 入参不合法时。
 */
export function encodePng(input) {
  const { width, height, pixels } = normalizeInput(input);

  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    const target = row * (rowBytes + 1);
    raw[target] = 0; // 过滤类型 0：None
    pixels.copy(raw, target + 1, row * rowBytes, (row + 1) * rowBytes);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_TYPE_RGBA;
  ihdr[10] = 0; // 压缩方法：deflate
  ihdr[11] = 0; // 过滤方法：自适应（每行自带过滤字节）
  ihdr[12] = 0; // 非隔行

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 读 PNG 的宽高（只解析签名与 IHDR，不校验 CRC）。
 * @param {Uint8Array | Buffer} data - PNG 字节。
 * @returns {{ width: number, height: number }} 宽高。
 * @throws {TypeError} 不是 PNG 或 IHDR 不完整时。
 */
export function pngDimensions(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new TypeError('不是合法的 PNG 数据（签名不匹配或长度不足）。');
  }
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new TypeError('PNG 数据缺少 IHDR chunk。');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** `pngDimensions` 的别名（部分调用方按 imageSizePng 命名）。 */
export const imageSizePng = pngDimensions;
