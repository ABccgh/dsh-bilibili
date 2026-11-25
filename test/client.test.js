/**
 * T4 客户端静态产物检查：client.js 可解析与注册装配、locale 键集、图标、预览图与 DETAIL。
 *
 * 只检查本任务产出的静态文件，不加载 DSH、不联网、不渲染浏览器半侧：
 * client.js 用 `vm` 捕获 `window.__ModuleLoader__`，执行 factory 与 apply（假 ctx），
 * 校验注册的 slot/key 与内嵌字典，而不是真的挂载 React 组件。
 *
 * 运行：node --test "test/client.test.js"
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/** 包根目录（本文件在 test/ 下）。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 10 个带专用卡片的工具名（顺序与本任务契约一致）。 */
const CARD_TOOL_NAMES = [
  'bili_status', 'bili_search', 'bili_video', 'bili_user', 'bili_ranking',
  'bili_popular', 'bili_hotwords', 'bili_comments', 'bili_danmaku', 'bili_login',
];

/** 11 项配置键（与 package.json / cordis.patch.yml / lib/config.js 一致）。 */
const CONFIG_KEYS = [
  'cookieEnv', 'requestTimeoutMs', 'maxListedItems', 'attachImages', 'downloadDir',
  'ffmpegPath', 'maxDownloadMb', 'panelEnabled', 'publicRoute', 'cacheTtlMs', 'wbiCacheTtlMs',
];

/** 读文本文件。 */
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

/** 读 JSON 文件。 */
function readJson(relative) {
  return JSON.parse(read(relative));
}

/** 递归收集叶子键（用「.」拼接），并校验叶子是字符串。 */
function leafKeys(value, prefix = '') {
  const keys = [];
  for (const [key, child] of Object.entries(value)) {
    const next = prefix === '' ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      keys.push(...leafKeys(child, next));
    } else {
      assert.equal(typeof child, 'string', `${next} 必须是字符串`);
      assert.notEqual(child.trim(), '', `${next} 不能是空串`);
      keys.push(next);
    }
  }
  return keys.sort();
}

/** 极简 XML 良构检查：剥注释后按标签栈配对，返回根元素名。 */
function assertWellFormedXml(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '');
  const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const stack = [];
  let rootName = null;
  let match;
  while ((match = tagPattern.exec(withoutComments)) !== null) {
    const [, closing, name, , selfClosing] = match;
    if (closing === '/') {
      assert.notEqual(stack.length, 0, `多余的结束标签 </${name}>`);
      assert.equal(stack.pop(), name, `结束标签 </${name}> 不匹配`);
      continue;
    }
    if (stack.length === 0) {
      assert.equal(rootName, null, 'XML 只能有一个根元素');
      rootName = name;
    }
    if (selfClosing !== '/') stack.push(name);
  }
  assert.equal(stack.length, 0, `未闭合标签：${stack.join(', ')}`);
  assert.notEqual(rootName, null, 'XML 没有根元素');
  return rootName;
}

/**
 * 从 source 的 index（必须是 `{`）起截取配对的对象字面量文本。
 * @param {string} source - 源码。
 * @param {number} index - `{` 的下标。
 * @returns {string} 含首尾花括号的字面量文本。
 */
function objectLiteralAt(source, index) {
  assert.equal(source[index], '{', 'objectLiteralAt 必须从 { 开始');
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (inString !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index, cursor + 1);
    }
  }
  throw new Error('对象字面量未闭合');
}

/** 取 client.js 里 `const DICT = …` 的字典对象。 */
function clientDict(source) {
  const start = source.indexOf('const DICT = ');
  assert.notEqual(start, -1, 'client.js 缺少 const DICT 内嵌字典');
  const index = source.indexOf('{', start);
  const literal = objectLiteralAt(source, index);
  // eslint-disable-next-line no-new-func -- 只为解析仓库内自检文件里的纯字面量。
  return new Function(`return (${literal});`)();
}

/** 用 vm 捕获 __ModuleLoader__ 的 load 调用。 */
function captureModule(source) {
  const captured = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          captured.push(spec);
        },
      },
    },
    console: { warn() {}, error() {}, log() {}, info() {} },
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.equal(captured.length, 1, 'client.js 必须恰好调用一次 __ModuleLoader__.load');
  return captured[0];
}

/** 最小 React 替身：factory 只定义组件，apply 不渲染，所以不需要真实实现。 */
const REACT_STUB = {
  createElement() {
    return null;
  },
  useState() {
    return [undefined, () => {}];
  },
  useEffect() {},
  useRef() {
    return { current: null };
  },
  useSyncExternalStore() {
    return false;
  },
};

/** 执行 factory，返回插件对象。 */
function loadPlugin(source) {
  const spec = captureModule(source);
  assert.equal(spec.id, '@local/bilibili', '模块 id 必须是包名 @local/bilibili');
  assert.equal(typeof spec.factory, 'function', 'factory 必须是函数');
  const plugin = spec.factory((name) => {
    assert.equal(name, 'react', 'factory 只应 require("react")');
    return REACT_STUB;
  });
  return plugin;
}

/** 假客户端 ctx：记录 locale 注册与 slots 注册，effect 立即执行。 */
function createFakeClientCtx() {
  const registrations = [];
  const localeRegisters = [];
  const disposers = [];
  const ctx = {
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    locale: {
      register(ns, dict) {
        localeRegisters.push({ ns, dict });
        return () => {};
      },
      bind(ns) {
        return (key, params) => {
          if (params === undefined) return key;
          return String(key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])));
        };
      },
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx, registrations, localeRegisters, disposers };
}

test('locale：zh 与 en 键集完全一致，且 meta 完整', () => {
  const zh = readJson('locale/zh.json');
  const en = readJson('locale/en.json');
  const zhKeys = leafKeys(zh);
  const enKeys = leafKeys(en);
  assert.deepEqual(zhKeys, enKeys);
  assert.ok(zhKeys.length > 150, `locale 键太少（实际 ${zhKeys.length}），疑似缺文案`);
  for (const [locale, dict] of [['zh', zh], ['en', en]]) {
    assert.ok(dict.meta.title.trim().length > 0, `${locale}.meta.title 不能为空`);
    assert.ok(dict.meta.description.trim().length > 40, `${locale}.meta.description 太短`);
    assert.equal(dict.meta.detail, 'docs/DETAIL.md', `${locale}.meta.detail 应指向 docs/DETAIL.md`);
    for (const segment of ['card', 'settings', 'panel']) {
      assert.equal(typeof dict[segment], 'object', `${locale} 缺少 ${segment} 段`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, zh.meta.detail)), 'meta.detail 指向的文件不存在');
  assert.match(en.meta.description, /^[A-Z0-9]/, 'en 描述应句首大写');
});

test('locale：包含 10 张卡片、11 项配置与面板三段文案', () => {
  const zh = readJson('locale/zh.json');
  const keys = new Set(leafKeys(zh));
  const required = [
    'card.preparing', 'card.running', 'card.failed', 'card.empty', 'card.parseFallback',
    'card.expand', 'card.collapse', 'card.more',
    'card.status.title', 'card.status.loggedIn', 'card.status.loggedOut',
    'card.search.title', 'card.search.empty', 'card.video.title', 'card.video.open',
    'card.video.parts', 'card.user.title', 'card.trend.title', 'card.trend.popularTitle',
    'card.hotwords.title', 'card.comments.title', 'card.danmaku.title', 'card.danmaku.distribution',
    'card.login.title', 'card.login.stateOk', 'card.login.qrHint',
    'settings.label', 'settings.title', 'settings.login.title', 'settings.scan.step1',
    'settings.config.title', 'settings.config.col.key', 'settings.limits.title', 'settings.limits.copyright',
    'settings.footer',
    'panel.title', 'panel.close', 'panel.refresh', 'panel.loading', 'panel.empty', 'panel.error',
    'panel.tab.hot', 'panel.tab.search', 'panel.tab.detail',
    'panel.hot.title', 'panel.search.title', 'panel.detail.title', 'panel.footer.copyright',
  ];
  for (const key of required) assert.ok(keys.has(key), `缺少 locale 键 ${key}`);
  for (const key of CONFIG_KEYS) {
    assert.ok(keys.has(`settings.config.keys.${key}`), `缺少配置说明 settings.config.keys.${key}`);
  }
});

test('client.js：vm 可解析、factory 返回 inject/apply 形状', () => {
  const source = read('client.js');
  const plugin = loadPlugin(source);
  // vm 里创建的数组原型与当前 realm 不同，转成本 realm 再比较。
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
  // 纯浏览器 JS：不能有 ESM 语句、不能 require 其它 DSH 客户端包。
  assert.doesNotMatch(source, /^\s*import\s/m, 'client.js 不能有 import');
  assert.doesNotMatch(source, /^\s*export\s/m, 'client.js 不能有 export');
  assert.ok(!source.includes("require('@deepseek-ai/"), '不能加载其他 DSH 客户端包');
  assert.ok(!source.includes('document.body'), '不能写 document.body');
  assert.ok(!source.includes('<script'), '不能注入脚本');
  assert.ok(source.includes("__ModuleLoader__.load({"), '缺少模板要求的模块加载器格式');
  assert.ok(source.includes("id: '@local/bilibili'"), '模块 id 必须是包名');
  assert.match(source, /factory\(require\)\s*\{/, 'factory 必须声明 require 参数');
});

test('client.js：apply 注册 10 张卡片 + 设置页 + 导航图标 + 侧栏按钮 + 抽屉浮层', () => {
  const source = read('client.js');
  const plugin = loadPlugin(source);
  const { ctx, registrations, localeRegisters } = createFakeClientCtx();
  plugin.apply(ctx);

  const cardRegistrations = registrations.filter((entry) => entry.options.name === 'tool.call.toolview');
  assert.deepEqual(
    cardRegistrations.map((entry) => entry.options.key),
    CARD_TOOL_NAMES,
    '10 个 tool.call.toolview key 必须齐全且顺序与契约一致',
  );
  for (const entry of cardRegistrations) {
    assert.equal(typeof entry.component, 'function', `卡片 ${entry.options.key} 必须是组件函数`);
    assert.equal(entry.options.locale, 'bili', '卡片必须声明 locale 命名空间');
  }

  const settings = registrations.filter((entry) => entry.options.name === 'settings.section');
  assert.equal(settings.length, 1, '必须恰好注册 1 个设置页');
  assert.equal(settings[0].options.id, 'bilibili');
  assert.equal(settings[0].options.order, 60);
  assert.equal(typeof settings[0].component, 'function');

  const sectionIcon = registrations.filter((entry) => entry.options.name === 'settings.section.icon');
  assert.equal(sectionIcon.length, 1, '必须恰好注册 1 个设置导航图标');
  assert.equal(sectionIcon[0].options.id, 'bilibili', '图标必须用 settings.section 的 id 匹配');
  assert.equal(typeof sectionIcon[0].component, 'function');

  const footer = registrations.filter((entry) => entry.options.name === 'sidebar.footer.action');
  assert.equal(footer.length, 1, '必须恰好注册 1 个侧栏按钮');
  assert.equal(footer[0].options.id, 'bilibili-panel');
  assert.equal(typeof footer[0].options.label, 'function', '侧栏按钮标签必须是 thunk（跟随语言切换）');
  assert.equal(typeof footer[0].component, 'function');

  const overlay = registrations.filter((entry) => entry.options.name === 'shell.overlay');
  assert.equal(overlay.length, 1, '必须恰好注册 1 个抽屉浮层');
  assert.equal(overlay[0].options.id, 'bilibili-panel.overlay');
  assert.equal(typeof overlay[0].component, 'function');

  assert.equal(localeRegisters.length, 1, '必须注册一次客户端 locale 词典');
  assert.equal(localeRegisters[0].ns, 'bili');
  assert.ok(localeRegisters[0].dict.zh !== undefined && localeRegisters[0].dict.en !== undefined, '词典必须含 zh/en');

  // locale 运行时按 dict[key] 直查：注册的词典必须是「扁平点路径」，嵌套对象会被忽略成键名。
  const registeredZh = localeRegisters[0].dict.zh;
  const registeredEn = localeRegisters[0].dict.en;
  for (const [locale, dict] of [['zh', registeredZh], ['en', registeredEn]]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${locale} 词典键 ${key} 必须是字符串（嵌套对象要拍平）`);
    }
  }
  for (const key of ['panel.title', 'panel.tab.hot', 'settings.label', 'card.status.title', 'card.video.title']) {
    assert.ok(registeredZh[key] !== undefined, `扁平键 ${key} 必须存在（否则界面显示原始键名）`);
    assert.ok(registeredEn[key] !== undefined, `英文扁平键 ${key} 必须存在`);
  }
  assert.deepEqual(Object.keys(registeredZh).sort(), Object.keys(registeredEn).sort(), 'zh/en 扁平键集必须一致');

  // 源码层面确认 5 类注册调用都存在，且都用 slots.inject 等待声明。
  assert.equal((source.match(/ctx\.slots\.register\(/g) ?? []).length, 5, '应有 5 处 slots.register 调用');
  assert.equal((source.match(/ctx\.slots\.inject\(/g) ?? []).length, 5, '应有 5 处 slots.inject 调用');
  for (const name of ['tool.call.toolview', 'settings.section', 'settings.section.icon', 'sidebar.footer.action', 'shell.overlay']) {
    assert.ok(source.includes(`'${name}'`), `缺少 ${name} 注册调用`);
  }
  assert.match(source, /name:\s*'tool\.call\.toolview'/, '缺少 tool.call.toolview 注册');
  assert.match(source, /name:\s*'settings\.section'/, '缺少 settings.section 注册');
  assert.match(source, /name:\s*'settings\.section\.icon'/, '缺少 settings.section.icon 注册');
  assert.match(source, /glyph\('brand'/, '设置图标必须复用 brand 字形');
  assert.equal(source.includes('M6.2 2.6 L4.8 13.4'), false, '热搜卡片不应再使用 # 字形');
  assert.match(source, /name:\s*'sidebar\.footer\.action'/, '缺少 sidebar.footer.action 注册');
  assert.match(source, /name:\s*'shell\.overlay'/, '缺少 shell.overlay 注册');
  assert.match(source, /ctx\.effect\(insertStyles/, '样式必须用 ctx.effect 管理清理');
  assert.match(source, /data-dsh-bilibili/, '样式标签必须带 data-dsh-bilibili');
});

test('client.js：内嵌字典与 locale/*.json 的 card/settings/panel 键集一致', () => {
  const source = read('client.js');
  const dict = clientDict(source);
  assert.ok(dict.zh !== undefined && dict.en !== undefined, 'DICT 必须含 zh/en');
  assert.deepEqual(leafKeys(dict.zh), leafKeys(dict.en), 'client 内嵌 zh/en 键集必须一致');

  for (const locale of ['zh', 'en']) {
    const jsonLocale = readJson(`locale/${locale}.json`);
    const expected = new Set(['card', 'settings', 'panel'].flatMap((segment) => leafKeys(jsonLocale[segment], segment)));
    const actual = new Set(leafKeys(dict[locale]));
    const missing = [...expected].filter((key) => !actual.has(key)).sort();
    const extra = [...actual].filter((key) => !expected.has(key)).sort();
    assert.deepEqual(missing, [], `${locale} 内嵌字典缺少键：${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${locale} 内嵌字典多出键：${extra.join(', ')}`);
  }
});

test('client.js：卡片解析最后一个 ```json 围栏块、错误态与封面/播放器约定', () => {
  const source = read('client.js');
  // 最后一个 json 围栏块（不是第一个）。
  assert.match(source, /while \(\(match = pattern\.exec\(text\)\) !== null\) last = match\[1\]/, '必须取最后一个 json 围栏块');
  assert.ok(source.includes('```json'), '必须识别 ```json 围栏块');
  assert.ok(source.includes('props.block') || source.includes('block.content'), '卡片必须从 props.block 取内容');
  assert.ok(source.includes('block.isError'), '必须处理 isError');
  assert.ok(source.includes('firstLine('), '错误态必须渲染首行');
  assert.ok(source.includes('humanText('), '必须剥离围栏块得到人类文本');
  // 封面走同源代理，不直连 hdslb。
  assert.ok(source.includes("'/dsh-bilibili/api/image'"), '封面必须走 /dsh-bilibili/api/image 代理');
  assert.ok(source.includes('?u=${encodeURIComponent(absolute)}'), '封面地址必须 encodeURIComponent');
  assert.ok(!source.includes('i0.hdslb.com'), '不能直连 hdslb');
  // 视频卡：官方 iframe 播放器 + 在 B 站打开。
  assert.ok(source.includes("'https://player.bilibili.com/player.html?bvid='"), '缺少 B 站播放器地址');
  assert.ok(source.includes('&autoplay=0&danmaku=0'), '播放器参数必须固定 autoplay=0&danmaku=0');
  assert.ok(source.includes("h('iframe'"), '视频卡必须内嵌 iframe 播放器');
  assert.ok(source.includes("'card.video.open'") || source.includes('card.video.open'), '缺少「在 B 站打开」');
  // 卡片使用宿主披露 hook 与本地化函数。
  assert.ok(source.includes('useDisclosure'), '卡片必须使用宿主 useDisclosure');
  assert.ok(source.includes('props.t'), '必须使用 props.t 本地化');
});

test('client.js：面板 store / useSyncExternalStore / 同源取数 / 无障碍约定', () => {
  const source = read('client.js');
  // 模块级 store + useSyncExternalStore。
  assert.match(source, /let panelOpen = false;/, '面板开合必须是模块级状态');
  assert.match(source, /const panelListeners = new Set\(\);/, '面板订阅者集合缺失');
  assert.ok(source.includes('useSyncExternalStore'), '必须用 useSyncExternalStore 同步开合');
  assert.match(source, /useSyncExternalStore\(subscribePanel, getPanelSnapshot\)/, '必须订阅模块级 store');
  // 面板三条 tab 与四个同源接口。
  for (const tab of ["'hot'", "'search'", "'detail'"]) {
    assert.ok(source.includes(tab), `缺少面板 tab ${tab}`);
  }
  for (const route of ['/hot', '/search', '/video', '/status']) {
    assert.ok(source.includes(`fetchPanel('${route}'`), `缺少面板取数 ${route}`);
  }
  assert.ok(source.includes("const PANEL_ROUTE = '/dsh-bilibili/api'"), '面板路由前缀必须同源');
  // 抽屉无障碍与交互。
  assert.ok(source.includes("role: 'dialog'"), '抽屉必须有 role="dialog"');
  assert.ok(source.includes("'aria-modal': 'true'"), '抽屉必须有 aria-modal="true"');
  assert.ok(source.includes("pointerEvents: 'auto'"), '容器必须 pointerEvents:auto');
  assert.ok(source.includes("event.key === 'Escape'"), 'Esc 必须关闭面板');
  assert.ok(source.includes('restoreRef'), '关闭后必须还原焦点');
  assert.ok(source.includes('document.activeElement'), '必须记录来源焦点');
  assert.ok(source.includes("addEventListener('keydown'"), '必须监听键盘事件');
  assert.ok(source.includes('bili-panel-loading') && source.includes('bili-panel-error') && source.includes('bili-panel-empty'), '面板必须有 loading/error/empty 三态');
  // 面板设置页：登录态 + 扫码说明 + 限制与版权。
  assert.ok(source.includes("fetchPanel('/status'"), '设置页必须读取 /status');
  assert.ok(source.includes('settings.scan.step1'), '设置页必须有扫码说明');
  assert.ok(source.includes('settings.limits.copyright'), '设置页必须有版权提示');
});

test('client.js：设置页 11 项配置与 lib/config.js 对齐', () => {
  const source = read('client.js');
  const match = /const CONFIG_ROWS = \[([\s\S]*?)\n    \];/.exec(source);
  assert.notEqual(match, null, '缺少 CONFIG_ROWS 配置表');
  const keys = [...match[1].matchAll(/\['([A-Za-z][A-Za-z0-9]*)',/g)].map((entry) => entry[1]);
  assert.deepEqual(keys, CONFIG_KEYS, 'CONFIG_ROWS 必须恰好是 11 项且与契约同名');
  const zh = readJson('locale/zh.json');
  const en = readJson('locale/en.json');
  for (const key of CONFIG_KEYS) {
    assert.equal(typeof zh.settings.config.keys[key], 'string', `zh 缺少配置说明 ${key}`);
    assert.equal(typeof en.settings.config.keys[key], 'string', `en 缺少配置说明 ${key}`);
  }
});

test('icon.svg：合法 XML、36×36、克制配色、无文字/脚本', () => {
  const source = read('icon.svg');
  const bytes = Buffer.byteLength(source, 'utf8');
  const rootTag = assertWellFormedXml(source);
  assert.equal(rootTag, 'svg');
  assert.match(source, /viewBox="0 0 36 36"/);
  assert.match(source, /width="36"/);
  assert.match(source, /height="36"/);
  assert.ok(bytes <= 8 * 1024, `icon.svg 应 ≤ 8 KiB（实际 ${bytes} 字节）`);
  assert.ok(bytes <= 256 * 1024, 'DSH 的图标上限是 256 KiB');
  assert.doesNotMatch(source, /<script|<style|<foreignObject|<image|<text[\s>]|on[a-z]+=/i);
  assert.doesNotMatch(source, /<text/i, '不能画文字（字体替换会变样）');
  const colors = new Set(source.match(/(?:fill|stroke)="(#[0-9a-fA-F]{3,8})"/g)?.map((entry) => entry.split('"')[1].toLowerCase()) ?? []);
  assert.ok(colors.size > 0, 'icon.svg 应使用具体色值');
  assert.ok(colors.size <= 3, `图标最多 3 种颜色（实际 ${colors.size} 种：${[...colors].join(', ')}）`);
  assert.ok([...colors].some((color) => color.startsWith('#00aeec')), '图标应带 #00AEEC 系品牌蓝');
});

test('docs/preview.svg：合法 XML、640×300、无文字与外部资源', () => {
  const source = read('docs/preview.svg');
  const bytes = Buffer.byteLength(source, 'utf8');
  const rootTag = assertWellFormedXml(source);
  assert.equal(rootTag, 'svg');
  assert.match(source, /width="640"/);
  assert.match(source, /height="300"/);
  assert.match(source, /viewBox="0 0 640 300"/);
  assert.ok(bytes <= 1024 * 1024, `preview.svg 应 ≤ 1 MiB（实际 ${bytes} 字节）`);
  assert.doesNotMatch(source, /<script|<style|<foreignObject|<image|<text[\s>]|on[a-z]+=/i);
  assert.doesNotMatch(source, /font-family|@font-face|href=|xlink:href/i, '预览图不能依赖字体或外部资源');
});

test('docs/DETAIL.md：只有一行图片引用且指向存在的文件', () => {
  const source = read('docs/DETAIL.md');
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  assert.equal(lines.length, 1, `DETAIL.md 只允许一行图片引用（实际 ${lines.length} 行）`);
  assert.match(lines[0], /^!\[[^\]]+\]\(preview\.svg\)$/, 'DETAIL.md 必须是 ![alt](preview.svg)');
  assert.ok(fs.existsSync(path.join(root, 'docs', 'preview.svg')), 'preview.svg 不存在');
  assert.ok(Buffer.byteLength(source, 'utf8') <= 1024, 'DETAIL.md 应只有一行图片');
});
