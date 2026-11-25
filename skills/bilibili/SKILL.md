description: B 站查询与下载：工具选择、风控排障、扫码登录、播放与下载边界。用 bili_* 工具搜索/看视频/读评论弹幕字幕/排行榜/番剧直播，或需要登录态与下载时加载。

# B 站（bilibili）查询与下载

本插件通过 Host 侧 HTTP + 签名访问 B 站，20 个 `bili_*` 工具覆盖公开数据、登录后的个人数据与下载。
面板与卡片只是展示层，所有能力都能从工具调用。

## 工具选择

| 要做的事 | 用 |
|---|---|
| 看登录态 / Cookie / ffmpeg / 路由状态 | `bili_status` |
| 搜索视频、UP 主、番剧、直播、专栏 | `bili_search`（type） |
| 看视频详情、分P、标签、统计 | `bili_video` |
| 看 UP 主资料与投稿 | `bili_user` |
| 看评论（热门/最新） | `bili_comments` |
| 看弹幕（密度 + 代表条目） | `bili_danmaku` |
| 分区排行榜 | `bili_ranking`（area） |
| 热门 / 每周必看 | `bili_popular`（kind） |
| 热搜词 | `bili_hotwords` |
| 番剧/影视季详情与剧集 | `bili_bangumi`（seasonId 或 epId） |
| 直播间状态 | `bili_live`（roomId） |
| 解析播放直链（DASH/durl） | `bili_playurl` |
| 取字幕（需登录，且稿件有字幕） | `bili_subtitle` |
| 扫码登录（开始/轮询/登出/状态） | `bili_login`（action） |
| 当前账号信息 | `bili_me` |
| 观看历史 | `bili_history` |
| 收藏夹列表/内容 | `bili_favorites`（action） |
| 关注列表 | `bili_follows` |
| 关注动态 | `bili_dynamic` |
| 下载视频或音频 | `bili_download` |

## 标准工作流

1. **先看状态**：涉及登录、字幕、个人数据或下载时先 `bili_status`，不要假设已登录。
2. **找内容**：`bili_search` 拿候选（`pageSize` 默认 25 上限），挑中后用 `bili_video` 看详情与分P。
3. **深挖**：评论 `bili_comments`、弹幕 `bili_danmaku`、字幕 `bili_subtitle`；注意输出是摘要 +
   代表条目，需要更多就翻页，不要把整页原文复制给用户。
4. **下载**：先 `bili_playurl` 看可用清晰度，再 `bili_download`；下完回报绝对路径、大小、清晰度。
5. **汇报**：用了哪些工具、关键数字、产出文件路径、哪些项没验证（例如未登录导致的缺失）。

## 目标格式

`target` 接受：`BV1GJ411x7h7`、`av80433022`、`https://www.bilibili.com/video/BV…`、`b23.tv` 短链。
需要分P 时传 `page`（从 1 开始）。

## 登录与 Cookie

- 优先扫码：`bili_login action=start` 会生成二维码图片，让用户用 B 站 App 扫码；
  再用 `bili_login action=poll qrcodeKey=…` 轮询（86101 等待 / 86090 已扫码待确认 / 86038 失效 / 0 成功）。
- 成功后 Cookie 写入凭据 `BILI_COOKIE`（凭据服务热加载，下一次调用即生效）。
- 也可以让用户把浏览器 Cookie 配置到 `BILI_COOKIE`（环境变量/`.env`/凭据 UI）。
- `BILI_AUTH_REQUIRED` / `BILI_COOKIE_EXPIRED` 表示没登录或登录失效：引导重新扫码，不要编造数据。

## 风控与错误码

| 码 | 含义 | 处理 |
|---|---|---|
| `BILI_RISK_CONTROL`（-352/-412） | 风控拦截 | 等 1 分钟、别连续刷；仍失败先登录再试；必要时提示关代理 |
| `-799` | 请求过于频繁 | 等 10–30 秒再重试 |
| `BILI_AUTH_REQUIRED`（-101） | 需要登录 | `bili_login action=start` |
| `BILI_NOT_FOUND`（-404） | 已删除/区域或版权限制 | 换目标，不要重试 |
| `BILI_FFMPEG_MISSING` | 没装 ffmpeg | 高清合并不可用；`bili_download` 会退单文件 MP4，或提示安装 ffmpeg |

**不要连续重试风控错误**：同一目标两次失败就停下来向用户说明。

## 下载边界

- 仅个人离线使用；不要帮用户批量搬运、二次上传或规避付费内容（大会员清晰度除外）。
- 默认目录 `%USERPROFILE%\Downloads\dsh-bilibili`；`dir` 只能落在该目录内。
- 有 ffmpeg 时下 DASH 视频+音频并合并；没有时退回单文件 MP4（清晰度受限）。
- 文件名由标题 + BV 号生成，默认不覆盖；体积上限 `maxDownloadMb`（默认 2048）。

## 界面入口

- 侧栏底部「B 站」按钮打开浏览面板（热搜/搜索/详情/内嵌播放）。
- 设置页「B 站」：登录状态、配置表、限制说明。
- 对话里的 `bili_*` 卡片：搜索/视频/UP/趋势/评论/弹幕/登录。
- 命令：`/bili-status`、`/bili-search <关键词>`、`/bili-download <BV号> [audio]`。
