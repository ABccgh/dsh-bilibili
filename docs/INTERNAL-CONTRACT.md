# dsh-bilibili 内部契约（施工单）

本文件是 `@local/bilibili` 0.1.0 的模块级契约。**动手前先读完整份**；任何与本文件不符的实现都视为缺陷。

## 0. 硬规则

1. **零外部依赖**：只 import `node:*` 与仓库内相对模块。**绝不 import `@deepseek-ai/*`**（插件以 `link:` 安装，这类 import 会让插件 `ERR_MODULE_NOT_FOUND`）。客户端 `client.js` 例外：它通过 `require('react')` 取基座 React。
2. ESM（`"type": "module"`）、`.js` 扩展名写全、对象字面量用单引号、行尾无分号风格保持与其他 `lib/*.js` 一致即可；每个导出写 JSDoc（含 `@param`/`@returns`）。
3. 注释与用户可见文案用中文；工具 `name`/参数名/输出字段用英文 snake_case / camelCase（见下）。
4. **离线测试不联网**：所有 `test/*.test.js` 只用 fixture 或注入的假 fetch/假 api；联网检查只放在 `tools/live-check.mjs`。
5. 测试运行器（本机没有 PATH node）：
   `C:\Users\11210\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --test "test/*.test.js"`
6. 不写仓库外文件；下载/临时文件只写 `%TEMP%` 或下载根目录。
7. 只改自己写作用域内的文件（见 §11），不要动别人正在写的文件。

## 1. 目录与归属

| 路径 | 归属 | 说明 |
| --- | --- | --- |
| `package.json` `cordis.patch.yml` `LICENSE` `.gitignore` `.gitattributes` `README.md` `icon.svg` `client.js` `locale/*` `docs/*` | Lead / T4 | T4 只写 `client.js`、`icon.svg`、`locale/*`、`docs/*` |
| `lib/index.js` `lib/config.js` `lib/tool-kit.js` `lib/paths.js` `lib/route.js` `lib/skill.js` `lib/tools/index.js` | Lead | 集成层 |
| `lib/http.js` `lib/cookies.js` `lib/wbi.js` `lib/appapi.js` `lib/api.js` `lib/errors.js` `lib/cache.js` `lib/format.js` `lib/images.js` | T1 | Host 核心 |
| `lib/tools/{status,search,video,user,community,media,hotwords}.js` | T2 | 公开工具 |
| `lib/qr.js` `lib/png.js` `lib/auth.js` `lib/download.js` `lib/tools/{login,personal,download}.js` | T3 | 登录/个人/下载 |
| `test/helpers.js` + `test/{config,tool-kit,paths,plugin}.test.js` | Lead | 共享测试 |
| `test/{http,wbi,format,cookies,appapi}.test.js` | T1 | 各自模块 |
| `test/{tools-public}.test.js` | T2 | |
| `test/{qr,download,tools-auth}.test.js` | T3 | |
| `test/client.test.js` | T4 | |
| `test/fixtures/**` | 各自 | 只加不改；文件名带来源 |

## 2. 插件装配（Lead 已写好 `lib/index.js`，各模块按此实现）

```js
// lib/index.js（摘要）
export const name = 'bilibili';
export const inject = ['tools'];
export async function apply(ctx, config) {
  const { config: effective, warnings } = normalizeConfigWithWarnings(config);
  const http = createHttpClient({ timeoutMs, userAgent, logger });
  const credentials = ctx.get('credentials');            // 可选服务
  const cookies = createCookieJar({ http, config, logger, resolveUserCookie });
  const wbi = createWbi({ http, config, logger });
  const appApi = createAppApi({ http });
  const api = createBiliApi({ http, cookies, wbi, appApi, config, logger, now });
  const images = createImages({ ctx, config, logger, http });
  const downloader = createDownloader({ ctx, config, api, http, logger });
  const deps = { ctx, config: effective, logger, http, cookies, wbi, appApi, api, images, downloader };
  for (const definition of createToolDefinitions(deps)) effect(() => ctx.tools.register(definition));
  // + skill / commands / panel route
}
```

## 3. 配置（`lib/config.js` 已完成）

`cookieEnv='BILI_COOKIE'`、`requestTimeoutMs=15000`、`maxListedItems=25`、`attachImages=true`、`downloadDir=''`、`ffmpegPath=''`、`maxDownloadMb=2048`、`panelEnabled=true`、`publicRoute=true`、`cacheTtlMs=60000`、`wbiCacheTtlMs=3600000`。

## 4. 错误（`lib/errors.js`，T1）

```js
export class BiliError extends Error {
  constructor(message, { code = 'BILI_ERROR', hint = '', retryable = false, cause } = {})
  // 字段：code(string) hint(string) retryable(boolean)
}
export function toErrorText(error) // -> '消息（code）\n提示：hint'
export function isBiliError(value)
export const CODES = { NETWORK:'BILI_NETWORK', TIMEOUT:'BILI_TIMEOUT', HTTP:'BILI_HTTP', API:'BILI_API',
  RISK:'BILI_RISK_CONTROL', AUTH:'BILI_AUTH_REQUIRED', COOKIE_EXPIRED:'BILI_COOKIE_EXPIRED',
  NOT_FOUND:'BILI_NOT_FOUND', INVALID:'BILI_INVALID_ARGUMENT', DOWNLOAD:'BILI_DOWNLOAD', FFMPEG:'BILI_FFMPEG_MISSING' }
```

工具失败时 **throw BiliError**（消息里带 hint），注册表会把结果标成 `isError`；不要返回 `{ok:false}` 文本。

## 5. HTTP（`lib/http.js`，T1）

```js
export function createHttpClient({ timeoutMs = 15000, userAgent, fetchImpl = fetch, logger, sleep, now } = {}) -> {
  async getJson(url, { headers, signal, retries = 2 } = {}) -> any,     // 2xx + JSON 解析；网络错误/5xx 重试
  async getText(url, { headers, signal, retries = 1 } = {}) -> string,
  async getBytes(url, { headers, signal } = {}) -> Uint8Array,
  async open(url, { headers, signal } = {}) -> { status, headers, body: ReadableStream<Uint8Array>|null, contentLength }
  get userAgent(): string
}
```
- 统一加 `User-Agent`（默认一枚桌面 Chrome UA）、`Referer: https://www.bilibili.com/`、`Accept-Language: zh-CN,zh;q=0.9`；调用方可覆盖。
- Node 自带 fetch 已解 gzip/deflate，不要再手工解压；弹幕请求由 api 层显式加 `accept-encoding: identity`。
- 超时用 `AbortSignal.timeout`；`signal` 与超时任一触发都算取消（抛 `BILI_TIMEOUT`/原错）。
- 非 2xx → `BiliError(CODES.HTTP)`；JSON 解析失败 → `BiliError(CODES.API)`。

## 6. Cookie 罐（`lib/cookies.js`，T1）

```js
export function createCookieJar({ http, config, logger, resolveUserCookie, now } = {}) -> {
  async header(): Promise<string>,          // 引导后的完整 Cookie 头（含用户 Cookie）
  async refresh(): Promise<void>,           // 丢弃缓存重新引导
  async userCookie(): Promise<string|undefined>,  // 直接问凭据服务
  invalidate(): void,
  async status(): Promise<{ configured: boolean, source?: string, names: string[] }>,
  name: 'cookies'
}
```
- 引导：`GET https://www.bilibili.com/` 取 `buvid3`/`b_nut`，再 `GET https://api.bilibili.com/x/frontend/finger/spi` 取 `b_3/b_4`（→ `buvid3`/`buvid4`）；本模块生成 `_uuid`、`b_lsid`。
- 用户 Cookie 字符串（`SESSDATA=…; bili_jct=…`）原样拼在后面前者优先；解析失败只告警。
- 缓存 12 小时；`refresh()` 后立刻可用。

## 7. WBI（`lib/wbi.js`，T1）

```js
export const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,
  28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
export function mixinKeyFrom(imgKey, subKey) -> string             // 纯函数，64 项置换
export function signQuery(params, mixinKey, wts) -> string         // 纯函数：排序 + 过滤 !'()* + encode + md5(q+mixinKey)
export function createWbi({ http, config, logger, now } = {}) -> {
  async sign(params, { forceRefresh } = {}) -> string,   // 返回 `a=1&b=2&wts=…&w_rid=…`
  invalidate(): void,
  async status(): Promise<{ cached: boolean, fetchedAt?: number, imgKey?: string }>
}
```
密钥来自 `GET https://api.bilibili.com/x/web-interface/nav` 的 `data.wbi_img.img_url/sub_url`（未登录也有）。缓存 `wbiCacheTtlMs`。

## 8. App 签名（`lib/appapi.js`，T1）

```js
export const APP_KEYS = {
  android: { appkey: '1d8b6e7d45233436', appsec: '560c52ccd288fed045859ed18b8e951f', mobi_app: 'android', platform: 'android', build: '7420300' },
  ios:     { appkey: '27eb53fc9058f8c3', appsec: 'c2ed53a74eeefe3cf99fbd01d8c9c375', mobi_app: 'iphone',  platform: 'ios',     build: '7420300' },
}
export function signAppQuery(params, appKey, ts) -> string   // 纯函数：sorted k=encodeURIComponent(v) + &sign=md5(q+appsec)
export function createAppApi({ http, now } = {}) -> {
  async search(params, { app = 'android', cookie } = {}) -> Promise<any>,  // 原样返回 data
  async spaceArchive(params, { cookie } = {}) -> Promise<any>,             // iOS key，UP 主投稿
}
```
搜索 URL：`https://app.bilibili.com/x/v2/search?<query>`；投稿：`https://app.bilibili.com/x/v2/space/archive?<query>`（参数 `vmid, pn, ps`）。

## 9. API 层（`lib/api.js`，T1）—— **所有端点唯一入口**

```js
export function createBiliApi({ http, cookies, wbi, appApi, config, logger, now, credentials } = {}) -> BiliApi
```

方法（全部 `async`，失败 throw `BiliError`；`target` 接受 `BV…`/`av…`/`https://www.bilibili.com/video/BV…`/`b23.tv` 短链）：

```ts
nav(): { loggedIn, mid?, uname?, face?, level?, coins?, vip?: { status, label }, following?, follower? }
status(): { loggedIn, user?, cookie: { configured, source? }, wbi: { cached, fetchedAt? }, ffmpeg?: { available, version?, path? } }
resolveTarget(target): { bvid, aid, page, cid?, title?, durationSec? }
search({ keyword, type, order, page, pageSize }): { keyword, type, page, pageSize, hasMore, total?, source, items: Item[] }
video({ target, page }): { video: Video, parts: Part[], tags: Tag[] }
user({ mid, includeVideos, limit }): { user: User, videos: Item[] }
ranking({ area, type, limit }): { area, name, items: Item[] }
popular({ kind, limit }): { kind, items: Item[] }
hotwords({ limit }): { items: [{ keyword, showName?, icon? }] }
comments({ target, page, sort, includeReplies, limit }): { count, page, hasMore, items: Comment[] }
danmaku({ target, page, limit }): { count, sampled, distribution: [{ minute, count }], items: Danmaku[] }
bangumi({ seasonId, epId }): { season: Bangumi }
live({ roomId }): { room: Room, anchor?: User }
playurl({ target, page, quality, audioOnly }): { media: { bvid, cid, page, durationSec }, quality, accept: [{ id, label }], video: Stream[], audio: Stream[], durl: [{ order, bytes, url }], expiresAt }
subtitle({ target, page, lang }): { languages: [{ lan, lanDoc, url }], lang, lines: [{ fromSec, toSec, text }] }
loginStart(): { qrcodeKey, url, expiresInSec }
loginPoll(qrcodeKey): { state: 'waiting'|'scanned'|'expired'|'ok', code, message, cookieString?, user? }
logout(): { cleared: true }
history({ limit, cursor }): { items: HistoryItem[], cursor, hasMore }
favorites({ action, mediaId, page, limit }): { folders?: Folder[] } | { items: Item[], page, hasMore }
follows({ vmid, page, limit }): { items: User[], page, hasMore }
dynamic({ page, limit }): { items: DynamicItem[], offset, hasMore }
```

### 归一化形状（T2/T3/T4 共用，**字段名不得改**）

```ts
type Item = {
  type: 'video'|'user'|'bangumi'|'live'|'article',
  bvid?: string, aid?: number, mid?: number, title: string, author?: string,
  cover?: string, play?: number, danmaku?: number, durationSec?: number, durationText?: string,
  pubdate?: number, pubdateText?: string, fans?: number, level?: number, sign?: string,
  url: string
}
type Video = {
  bvid, aid, title, cover, durationSec, durationText, pubdate, pubdateText, desc,
  owner: { mid, name, face? },
  stat: { view, danmaku, like, coin, favorite, share, reply },
  pages: Part[], tags: Tag[], url
}
type Part = { cid, page, part, durationSec, durationText }
type Tag = { id, name, count? }
type Comment = { rpid, mid?, uname, avatar?, message, like, ctime, ctimeText, replyCount, replies?: Reply[] }
type Reply = { rpid, uname, message, like, ctimeText }
type Danmaku = { timeMs, mode, color, text, ctime }
type Bangumi = { seasonId, title, cover, evaluate, rating, totalEpisodes, episodes: [{ epId, title, bvid?, cover?, durationSec }], url }
type Room = { roomId, shortId?, title, cover?, liveStatus: 0|1|2, online, attention, url }
type User = { mid, name, face?, fans?, level?, sign?, official?, vip?, archiveCount?, url }
type HistoryItem = { title, cover?, author?, bvid?, progressSec, durationSec, viewedAtText, url }
type Folder = { id, title, count, cover? }
type DynamicItem = { id, type, pubTimeText, text, author: { mid, name, face? }, video?: { bvid, title, cover }, url }
type Stream = { id, label, codec?, width?, height?, bytes?, url, backupUrls?: string[] }
```

**端点选择（已验证，实现时按此顺序）**

- 搜索：App `x/v2/search`（`search_type` 映射：video→`video`、user→`bili_user`、bangumi→`media_bangumi`、live→`live`、article→`article`；`order`→`totalrank|click|pubdate|dm|stow`；返回 `data.item` 是分组数组，`flat()` 后按 `goto` 归一：`av`→video、`author_new`→user、`live`→live、`media_bangumi`→bangumi、`article`→article；`param` 是 aid 字符串，用 `format.bvFromAid` 转 BV）。
- 视频：`x/web-interface/view?bvid=`；标签 `x/tag/archive/tags?bvid=`；分P 来自 `pages`。
- UP：`x/web-interface/card?mid=`（稳）；投稿列表用 App iOS `x/v2/space/archive`（`-3` 时退 `-799` 重试一次，再失败返回空列表并 `warning`）。
- 排行：`x/web-interface/ranking/v2?rid=&type=all`；热门：`x/web-interface/popular?ps=&pn=` / `kind=weekly` 用 `x/web-interface/popular/series/one?number=`（失败退 popular）。
- 热搜：`x/web-interface/search/square?limit=`。
- 评论：`x/v2/reply?type=1&oid=<aid>&pn=&ps=&sort=2|0`。
- 弹幕：先 `x/v2/dm/web/seg.so?type=1&oid=<cid>&pid=<aid>&segment_index=`（带 `accept-encoding: identity` + cookie），protobuf 解析见 T3 提供的 `lib/danmaku.js`？**不**：解析放 `lib/format.js` 的 `parseDanmakuSegments(bytes)`（T1 实现，纯函数）。
- 番剧：`pgc/view/web/season?season_id=`；ep 入参先 `pgc/view/web/season?ep_id=`。
- 直播：`api.live.bilibili.com/room/v1/Room/get_info?room_id=` + `getInfoByRoom?room_id=`（可选）。
- 播放：`x/player/wbi/playurl?` + WBI 签名，`fnval=4048&fourqn=1&qn=` 取 DASH，`fnval=1` 取 durl；`audioOnly` 时只要 `dash.audio`。
- 字幕：`x/player/wbi/v2?bvid=&cid=`，`data.subtitle.subtitles[]` 每项 `subtitle_url` 是 `//` 开头，补 `https:` 后 `getJson`；空列表 → `{ languages: [], lines: [] }`（未登录正常现象，不算错误）。
- 登录：`passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header` / `.../qrcode/poll?qrcode_key=`；成功时 `data.url` 形如 `https://passport.biligame.com/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…`，从中取 5 个键拼 Cookie。
- 个人：nav；历史 `x/web-interface/history/cursor?ps=&type=archive&max=`；收藏 `x/v3/fav/folder/created/list-all?up_mid=` + `x/v3/fav/resource/list?media_id=&pn=&ps=`；关注 `x/relation/followings?vmid=&pn=&ps=`；动态 `x/polymer/web-dynamic/v1/feed/all?type=all&page=`（`-352` 时提示登录/稍后重试）。

## 10. 工具层契约（T2/T3）

- 文件导出：`export function createXxxTools(deps) -> ToolDefinition[]`，用 `defineTool` 定义，`parameters` 用简写 spec（`required: true` 标必填）。
- `execute(args, exec)` 支持 `exec.signal`；长任务（下载）必须响应取消。
- 成功 `return { ok: true, data: <上面 §9 形状> }`；`render(args, value)` 用 `renderResult(text, value)` 输出「人类文本 + ```json 围栏」。
- 图片：`deps.images.attachUrls(urls, { max })`（T1 实现）返回 `{ blocks, attached }`；只在 `config.attachImages` 时调用，失败静默降级。
- 列表截断：最多 `min(args.pageSize ?? config.maxListedItems, config.maxListedItems)`；删除字段一律不返回。
- 工具名与参数（**固定，不得增删参数名**）：

| 工具 | 参数（必填*） | 返回 data |
| --- | --- | --- |
| `bili_status` | — | `{ version, loggedIn, user?, cookie, wbi, ffmpeg, download: { dir }, panel: { enabled, route } }` |
| `bili_search` | `keyword*`, `type`(video\|user\|bangumi\|live\|article，默认 video), `order`(totalrank\|click\|pubdate\|dm\|stow), `page`, `pageSize` | `{ keyword, type, page, hasMore, items }` |
| `bili_video` | `target*`, `page`, `includeParts`(默认 true), `includeTags`(默认 true) | `{ video, parts, tags }` |
| `bili_user` | `mid*`, `includeVideos`(默认 true), `limit` | `{ user, videos }` |
| `bili_ranking` | `area`(all\|douga\|game\|kichiku\|music\|dance\|cinephile\|ent\|knowledge\|tech\|food\|animal\|fashion\|information\|auto\|sports\|movie\|teleplay\|variety\|documentary)，`limit` | `{ area, name, items }` |
| `bili_popular` | `kind`(popular\|weekly)，`limit` | `{ kind, items }` |
| `bili_hotwords` | `limit` | `{ items }` |
| `bili_comments` | `target*`, `page`, `sort`(hot\|time), `includeReplies`(默认 true) | `{ count, page, hasMore, items }` |
| `bili_danmaku` | `target*`, `page`, `limit` | `{ count, sampled, distribution, items }` |
| `bili_bangumi` | `seasonId` 或 `epId`（至少一个） | `{ season }` |
| `bili_live` | `roomId*` | `{ room, anchor }` |
| `bili_playurl` | `target*`, `page`, `quality`(best\|1080\|720\|480\|360), `audioOnly` | `{ media, quality, accept, video, audio, durl, expiresAt }` |
| `bili_subtitle` | `target*`, `page`, `lang` | `{ languages, lang, lines }` |
| `bili_login` | `action`(start\|poll\|logout\|status，默认 status), `qrcodeKey`(poll 必填) | start → `{ qrcodeKey, url, expiresInSec, qr: { file?, attached } }`；poll → `{ state, code, message, user? }`；logout → `{ cleared }`；status → `{ loggedIn, user? }` |
| `bili_me` | — | `{ user }` |
| `bili_history` | `limit`, `cursor` | `{ items, cursor, hasMore }` |
| `bili_favorites` | `action`(list\|items，默认 list), `mediaId`, `page` | `{ folders }` / `{ items, page, hasMore }` |
| `bili_follows` | `vmid`, `page`, `limit` | `{ items, page, hasMore }` |
| `bili_dynamic` | `page`, `limit` | `{ items, offset, hasMore }` |
| `bili_download` | `target*`, `page`, `quality`, `audioOnly`, `dir`, `overwrite` | `{ file, bytes, sizeText, quality, durationSec, merged, audioOnly, elapsedMs }` |

- `bili_login action=start` 的二维码：`deps.qr.renderPng(url)` → `%TEMP%` 写入 `bili-login-<key>.png`，`images.attachFile(path)` 挂附件并删临时文件；`attachImages=false` 时只返回 URL 文本。
- `bili_download` 用 `deps.downloader.run(args, exec)`；`timeoutMs: 1800000`，`isConcurrencySafe: () => false`。

## 11. 面板路由（Lead 实现 `lib/route.js`，T4 按此消费）

前缀路由 `/dsh-bilibili/api`（`config.publicRoute` 为假时不注册），只 GET/HEAD，响应 `application/json; charset=utf-8`，`cache-control: no-store`：

| 路径 | 查询 | 响应 `data` |
| --- | --- | --- |
| `/status` | — | `{ version, loggedIn, uname?, level?, ffmpeg: { available, version? }, downloadDir }` |
| `/hot` | `limit` | `{ items: [{ keyword, showName?, icon? }] }` |
| `/search` | `keyword*`, `type`, `page` | `{ keyword, type, page, hasMore, items }` |
| `/video` | `bvid*` | `{ video, parts }` |
| `/image` | `u*` | 图片字节（`image/jpeg`/`png`/`webp`，≤5 MB，1 h 缓存） |

- 失败：HTTP 502 + `{ ok:false, error:{ code, message, hint } }`；参数非法 400。
- `/image` 只允许 `https://` 且主机名以 `.hdslb.com` 结尾、路径以 `/bfs/` 开头。
- 30 s 内存缓存（`cacheTtlMs`）。

## 12. 客户端契约（T4）

- 格式：`window.__ModuleLoader__.load({ id: '@local/bilibili', factory(require) { const React = require('react'); … return { inject: ['slots','locale'], apply(ctx) {…} } } })`。
- 注册：`tool.call.toolview`（key 见下）、`settings.section`（id `bilibili`）、`sidebar.footer.action`（id `bilibili-panel`）、`shell.overlay`（id `bilibili-panel.overlay`）。
- 卡片 key（9 个）：`bili_status` `bili_search` `bili_video` `bili_user` `bili_ranking` `bili_popular` `bili_hotwords` `bili_comments` `bili_danmaku` `bili_login`（趋势卡可复用、但 10 个 key 都要注册）。
- 卡片从 `props.block` 取 `content`：拼接 text 块 → 取**最后一个 ```json 围栏块** → `JSON.parse` 得 `{ ok, data }`；`block.isError === true` 时渲染错误态；`props.t` 是本地化函数；`props.expandable/expanded/onToggle` 控制展开。
- 封面：`<img src={'/dsh-bilibili/api/image?u=' + encodeURIComponent(url)}>`（不直连 hdslb，避免 CSP/防盗链问题）；失败时隐藏。
- 播放：`<iframe src={'https://player.bilibili.com/player.html?bvid=' + bvid + '&autoplay=0&danmaku=0'} loading="lazy" allowfullscreen />`，外加“在 B 站打开”链接。
- 设置页：登录状态（`/status`）、扫码说明（对话里 `bili_login start`）、11 项配置表、限制与版权提示。
- 面板：`sidebar.footer.action` 按钮（图标 + `wide` 时显示文字）+ `shell.overlay` 抽屉；模块级 store（`let open=false; const listeners=new Set()`）同步开合，`useSyncExternalStore` 订阅；Esc 关闭、焦点还原、`role="dialog" aria-modal="true"`；容器 `pointerEvents:'auto'`。
- 文案：`ctx.locale.register('bili', { zh, en })` + `ctx.locale.bind('bili')`；字典与 `locale/zh.json`/`en.json` 的 `card`、`settings`、`panel` 段一致（`test/client.test.js` 校验键集）。
- 样式：`<style data-dsh-bilibili>` 插到 `document.head`，只在 `ctx.effect` 内注册；只用主题 token（`var(--dsw-alias-*)`），无自定义色板；不写 `document.body` 之外的东西、不读其他插件 DOM。

## 13. 测试约定

- 每个模块一个 `test/<module>.test.js`；用 `node:test` + `node:assert/strict`。
- 假 ctx：`test/helpers.js` 的 `createFakeCtx()`（含 `tools.register` 记录、`logger` 捕获、`effect` 立即执行并返回 disposer、可选 `credentials/attachments/webServer/skills/commands` 替身）。
- 假 HTTP：`test/helpers.js` 的 `createFakeHttp(routes)`（按 URL 片段返回 JSON/字节/抛错）。
- fixtures 命名 `test/fixtures/<source>.<what>.json`，只保存脱敏裁剪后的真实响应；二进制用 `.bin`（弹幕 ≤64 KB）。
- 断言口径：纯函数（wbi/app 签名、BV 转换、protobuf、文件名、配置）必须逐值断言；工具层断言注册数量、schema required、render 围栏可解析、错误码映射。

## 14. 验收命令

```
NODE="C:\Users\11210\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $NODE --test "test/*.test.js"
& $NODE tools/live-check.mjs --public
```

全部离线测试必须 PASS；live-check 允许 `SKIP`（需登录/需 ffmpeg/风控），但必须在输出里标原因。
