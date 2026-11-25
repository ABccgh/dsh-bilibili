/**
 * 极简内存 TTL 缓存（面板取数、热门/排行等只读接口用）。
 *
 * 没有外部依赖、没有定时器：过期条目在读取时按 `now()` 判定，写满后按插入顺序
 * 淘汰最旧的键。测试里注入 `now` 就能确定性地验证过期行为。
 *
 * @module @local/bilibili/cache
 */

/**
 * TTL 缓存实现。
 */
export class TtlCache {
  /**
   * @param {{ ttlMs?: number, now?: () => number, maxEntries?: number }} [options] - 选项。
   */
  constructor(options = {}) {
    const ttl = Number(options.ttlMs);
    /** 默认存活时间（毫秒）。 */
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.trunc(ttl) : 60000;
    /** 时间源（测试注入）。 */
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    const limit = Number(options.maxEntries);
    /** 最多缓存多少条。 */
    this.maxEntries = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 200;
    /** @type {Map<string, { value: any, expiresAt: number }>} */
    this.entries = new Map();
  }

  /**
   * 取缓存值；不存在或已过期返回 `undefined`。
   * @param {string} key - 键。
   * @returns {any} 值。
   */
  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * 判断键是否存在且未过期。
   * @param {string} key - 键。
   * @returns {boolean} 是否命中。
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  /**
   * 写入一条缓存。
   * @param {string} key - 键。
   * @param {any} value - 值。
   * @param {number} [ttlMs] - 本条覆盖的存活时间（毫秒）。
   * @returns {any} 写入的值（方便 `return cache.set(...)`）。
   */
  set(key, value, ttlMs) {
    const rawTtl = Number(ttlMs);
    const ttl = Number.isFinite(rawTtl) && rawTtl > 0 ? Math.trunc(rawTtl) : this.ttlMs;
    // 先删后插，让 Map 的插入顺序等价 LRU 的「最近写入」。
    this.entries.delete(key);
    this.entries.set(String(key), { value, expiresAt: this.now() + ttl });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return value;
  }

  /**
   * 删除一个键。
   * @param {string} key - 键。
   * @returns {boolean} 是否真的删除了。
   */
  delete(key) {
    return this.entries.delete(String(key));
  }

  /** 清空全部缓存。 */
  clear() {
    this.entries.clear();
  }

  /** 当前条目数（含尚未清理的过期条目）。 */
  get size() {
    return this.entries.size;
  }

  /**
   * 读缓存，未命中时调用 `loader` 并写入。
   *
   * 并发调用同一个 key 会共享同一个 Promise，避免面板打开瞬间打出一串重复请求。
   * @param {string} key - 键。
   * @param {() => Promise<any>} loader - 未命中时的加载器。
   * @param {number} [ttlMs] - 本条覆盖的存活时间。
   * @returns {Promise<any>} 值。
   */
  async memoize(key, loader, ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (typeof loader !== 'function') throw new TypeError('memoize 需要一个 loader 函数');
    /** @type {Promise<any>} */
    const pending = Promise.resolve().then(loader);
    // 用一个占位 Promise 顶住并发，成功后换成真实值，失败则删掉占位。
    this.set(key, pending, ttlMs);
    try {
      const value = await pending;
      this.set(key, value, ttlMs);
      return value;
    } catch (error) {
      this.delete(key);
      throw error;
    }
  }
}

/**
 * 造一个 TTL 缓存。
 * @param {{ ttlMs?: number, now?: () => number, maxEntries?: number }} [options] - 选项。
 * @returns {TtlCache} 缓存。
 */
export function createTtlCache(options = {}) {
  return new TtlCache(options);
}

/**
 * 兼容别名：面板/路由代码里更习惯叫 cache。
 * @param {{ ttlMs?: number, now?: () => number, maxEntries?: number }} [options] - 选项。
 * @returns {TtlCache} 缓存。
 */
export function createCache(options = {}) {
  return new TtlCache(options);
}
