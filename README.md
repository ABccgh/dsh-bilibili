# dsh-bilibili

DeepSeek Harness 的 B 站（bilibili）全面接入插件：20 个 `bili_*` 工具 + 富卡片 + 设置页 + 侧栏「B 站」浏览面板 + `bilibili` 技能 + 「B 站内容研究」预设。

> 状态：0.1.1。公开数据走 Host 侧 HTTP（Cookie 引导 + WBI/App 双签名），登录态通过扫码写入凭据 `BILI_COOKIE`；
> 下载支持 DASH（ffmpeg 无损合并，主地址失败自动换 backupUrls）与 durl 单文件兜底。

## 能力

| 层 | 内容 |
| --- | --- |
| 公开查询（13） | `bili_status` `bili_search` `bili_video` `bili_user` `bili_ranking` `bili_popular` `bili_hotwords` `bili_comments` `bili_danmaku` `bili_bangumi` `bili_live` `bili_playurl` `bili_subtitle` |
| 登录与个人（6） | `bili_login`（start/poll/logout/status）`bili_me` `bili_history` `bili_favorites` `bili_follows` `bili_dynamic` |
| 下载（1） | `bili_download`（视频/纯音频、DASH 或 durl、ffmpeg 合并） |
| 界面 | 10 个工具卡片；设置页「B 站」；侧栏「B 站」按钮 + 浮层浏览面板（热搜/搜索/详情/内嵌播放） |
| 智能体 | `bilibili` 技能；预设「B 站内容研究」；命令 `/bili-status` `/bili-search` `/bili-download` |

## 安装

仓库在 `D:\DSH workspace\dsh-bilibili`。本机已通过 `plugin_manager` 的 `install_bundle` 安装：
DSH 把 profile 依赖写成 `link:D:/DSH workspace/dsh-bilibili`，**工作区目录就是安装目录**
（没有 `%USERPROFILE%\dsh-bundles\bilibili` 副本）。

```powershell
# 1) 首次安装（在 DSH 里让 agent 调用 plugin_manager）
#    action: install_bundle, target: D:\DSH workspace\dsh-bilibili
# 2) 之后改了 lib/ 代码：重启 DSH（Host 进程会缓存已加载的 ESM 模块）
# 3) 只改 cordis.patch.yml 的配置值：在插件页把 bilibili 关开一次即可
# 4) 改了 client.js / locale：刷新页面（浏览器 bundle 每次刷新重取）
# 5) 需要把同一份包复制到别处时：node tools/sync-install.mjs --to <目录>
```

客户端 `client.js` 是手写 bundle（无构建步骤）；首次安装或改动后刷新页面即可看到卡片/设置页/面板。

## 配置（`cordis.patch.yml`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cookieEnv` | `BILI_COOKIE` | Cookie 的凭据名（凭据服务 / 环境变量 / `.env`） |
| `requestTimeoutMs` | `15000` | 单次 HTTP 超时 |
| `maxListedItems` | `25` | 列表类工具一次默认最多返回条数 |
| `attachImages` | `true` | 是否把封面/头像/二维码作为图片附件返回 |
| `downloadDir` | `''` | 下载根目录；空 = `%USERPROFILE%\Downloads\dsh-bilibili` |
| `ffmpegPath` | `''` | ffmpeg 路径；空 = 自动探测 PATH |
| `maxDownloadMb` | `2048` | 单任务体积上限（MiB） |
| `panelEnabled` | `true` | 侧栏按钮与浮层面板 |
| `publicRoute` | `true` | 面板取数路由 `/dsh-bilibili/api`（只读公开数据） |
| `cacheTtlMs` | `60000` | 面板路由内存缓存 |
| `wbiCacheTtlMs` | `3600000` | WBI 密钥缓存 |

## 登录

1. 让 agent 调 `bili_login action=start`：生成二维码 PNG（附件）+ `qrcodeKey`。
2. 用 B 站手机 App 扫码，再调 `bili_login action=poll qrcodeKey=…`：
   86101 等待 / 86090 已扫码待确认 / 86038 失效 / 0 成功。
3. 成功后 Cookie 写入凭据 `BILI_COOKIE`（热加载，下一次调用生效）；`bili_login action=logout` 清除。

也可以直接配置 Cookie（三选一，优先级从高到低）：

```yaml
# %DSH_HOME%\.credentials.yaml
version: 1
refs:
  BILI_COOKIE: "SESSDATA=…; bili_jct=…; DedeUserID=…; DedeUserID__ckMd5=…; sid=…"
```

或环境变量 `BILI_COOKIE`（需重启 DSH），或项目 `.env`。

## 下载

- 有 ffmpeg（`ffmpegPath` 或 PATH）：`playurl`（`fnval=4048`）取 DASH 视频+音频，分别下载后
  `ffmpeg -c copy -movflags +faststart` 合并成 MP4；`audioOnly: true` 直接存音频 `.m4a`。
- 无 ffmpeg：自动带 `durlOnly` 再请求一次播放地址，退回 `fnval=1` 的整段 MP4（清晰度上限随登录态；
  默认 360P/480P）。ffmpeg 探测失败只缓存 60 秒，装好后不必重启，过一分钟再下载即可。
- 落盘：默认 `%USERPROFILE%\Downloads\dsh-bilibili`，`dir` 必须在该目录内；文件名
  `<标题> [<BV号>][ P<n>].mp4`，默认不覆盖、超出 `maxDownloadMb` 拒绝、中断清理 `.part`。
- **仅限个人离线使用**，不要二次上传或用于规避平台限制。

## 界面

- **工具卡片**：`bili_status`（登录/ffmpeg/配置）、`bili_search`（封面+标题+UP+播放量）、
  `bili_video`（封面、统计、分P、简介、内嵌播放器、跳转 B 站）、`bili_user`、`bili_ranking` /
  `bili_popular` / `bili_hotwords`（趋势卡）、`bili_comments`、`bili_danmaku`（密度+代表弹幕）、
  `bili_login`（二维码）。
- **设置页「B 站」**：登录状态、扫码说明、配置表、限制与版权提示。
- **侧栏「B 站」浮层**：热搜 / 搜索 / 详情三个 tab，详情内嵌 `player.bilibili.com` 播放器。
  数据来自同源只读路由 `/dsh-bilibili/api`（不暴露 Cookie 与个人数据）。
- 封面走 `/dsh-bilibili/api/image?u=…` 代理（只允许 `*.hdslb.com/bfs/*`，≤5 MiB，1 h 缓存）。

## 限制

- 只读：不点赞、不投币、不评论、不转发、不发布、不关注/取关。
- B 站风控（`-352/-412/-799`）与接口变更会影响部分端点；错误会带 `BILI_*` 码与可执行提示。
- 弹幕/字幕/评论可能很长：工具做截断与分页，只给摘要与代表条目。
- 清晰度受账号与视频本身限制；大会员清晰度需要对应账号。
- 面板路由无鉴权（DSH 的 HTTP 层不做全站鉴权），因此只暴露公开数据；个人数据只能通过工具读取。

## 开发

```powershell
# 离线测试（本机无 PATH node，用 DSH 自带 node）
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test "test/*.test.js"

# 线上冒烟（公开接口；需登录/ffmpeg 的项标 SKIP）
& <同上 node> tools/live-check.mjs --public
```

目录：

```
lib/            Host 实现（http/cookies/wbi/appapi/api/format/images/qr/png/auth/download/route/skill/tools）
client.js       Web 客户端（卡片/设置页/面板）
locale/         meta 与 UI 词典（zh/en）
docs/           详情图与内部契约
skills/         bilibili 技能
test/           离线单测 + fixtures
tools/          live-check.mjs / sync-install.mjs
```

内部接口与数据形状见 [docs/INTERNAL-CONTRACT.md](docs/INTERNAL-CONTRACT.md)。

## 许可

MIT。仅用于个人访问公开内容与个人离线观看；请遵守 B 站用户协议与相关法律。
