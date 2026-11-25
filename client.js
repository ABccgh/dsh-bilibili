window.__ModuleLoader__.load({
  id: '@local/bilibili',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 客户端 locale 命名空间（与 locale/zh.json、locale/en.json 的 card/settings/panel 段一致）。 */
    const NS = 'bili';

    /** 面板取数路由前缀（lib/route.js 注册，§11）。 */
    const PANEL_ROUTE = '/dsh-bilibili/api';

    /** 封面/头像/二维码代理路径；不直连 hdslb，避免 CSP 与防盗链问题。 */
    const IMAGE_ROUTE = '/dsh-bilibili/api/image';

    /** 面板一次取多少条（与工具默认 maxListedItems 同量级）。 */
    const PANEL_LIMIT = 20;

    /** B 站视频播放器 iframe 的固定参数。 */
    const PLAYER_BASE = 'https://player.bilibili.com/player.html?bvid=';

    /** BV 号形状（BV + 10 位字母数字）。 */
    const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

    /**
     * 客户端内嵌字典。
     *
     * 为什么内嵌一份：动态浏览器 bundle 的 `require` 只能解析基座模块与已注册的包模块，
     * 读不到包内的 locale/*.json；Host 侧的 locale/*.json 只供 Plugin Manager / 详情页
     * 读取 meta，不进入浏览器。所以这里的字典与 locale/*.json 的 card、settings、panel
     * 三段保持一致（test/client.test.js 校验键集，改动时两边同步）。
     */
    const DICT = {
      zh: {
        card: {
          preparing: '准备中',
          running: '执行中',
          failed: '失败',
          empty: '没有可显示的内容',
          parseFallback: '结构化结果解析失败，下面是原始文本。',
          expand: '展开',
          collapse: '收起',
          more: '还有 {n} 项未显示',
          page: '第 {n} 页',
          unknown: '未知',
          play: '播放',
          status: {
            title: 'B 站状态',
            loggedIn: '已登录',
            loggedOut: '未登录',
            version: '插件版本',
            user: '账号',
            level: '等级',
            cookie: 'Cookie',
            cookieConfigured: '已配置',
            cookieMissing: '未配置',
            cookieSource: '来源',
            wbi: 'WBI 签名',
            wbiReady: '已缓存',
            wbiPending: '待获取',
            ffmpeg: 'ffmpeg',
            ffmpegReady: '可用',
            ffmpegMissing: '未找到',
            downloadDir: '下载目录',
            panel: '浏览面板',
            panelEnabled: '已启用',
            panelDisabled: '未启用',
            panelRoute: '取数路由',
            panelRouteOff: '未注册（publicRoute=false）',
            hint: '登录态来自 BILI_COOKIE 凭据或 bili_login 扫码；面板只读取公开数据。',
          },
          search: {
            title: 'B 站搜索',
            keyword: '关键词',
            total: '结果数',
            type: '类型',
            typeVideo: '视频',
            typeUser: 'UP 主',
            typeBangumi: '番剧',
            typeLive: '直播',
            typeArticle: '专栏',
            empty: '没有搜索到结果',
            more: '还有更多结果，用分页参数继续取。',
          },
          video: {
            title: '视频详情',
            open: '在 B 站打开',
            bvid: 'BV 号',
            owner: 'UP 主',
            published: '发布',
            duration: '时长',
            view: '播放',
            danmaku: '弹幕',
            like: '点赞',
            coin: '投币',
            favorite: '收藏',
            share: '分享',
            reply: '评论',
            desc: '简介',
            parts: '分P',
            part: 'P{n}',
            partTitle: '标题',
            tags: '标签',
            cover: '封面',
            playerNote: '内嵌播放器使用 B 站官方 iframe；登录态与清晰度以浏览器为准。',
          },
          user: {
            title: 'UP 主',
            mid: 'UID',
            level: '等级',
            fans: '粉丝',
            sign: '签名',
            videos: '投稿',
            noVideos: '没有取到投稿',
          },
          trend: {
            title: '排行榜',
            popularTitle: '热门',
            area: '分区',
            kind: '类型',
            weekly: '每周必看',
            rank: '排名',
            count: '条数',
            empty: '没有取到条目',
          },
          hotwords: {
            title: '热搜',
            count: '条数',
            empty: '没有取到热搜',
          },
          comments: {
            title: '评论',
            count: '评论总数',
            replyCount: '{n} 条回复',
            like: '赞',
            empty: '没有取到评论',
          },
          danmaku: {
            title: '弹幕',
            count: '弹幕总数',
            sampled: '抽样条数',
            distribution: '每分钟分布',
            minute: '第 {n} 分钟',
            empty: '没有取到弹幕',
          },
          login: {
            title: '扫码登录',
            stateWaiting: '等待扫码',
            stateScanned: '已扫码，等待确认',
            stateExpired: '二维码已过期',
            stateOk: '登录成功',
            message: '提示',
            qrcodeKey: '二维码 key',
            mid: 'UID',
            code: '状态码',
            expire: '{n} 秒内有效',
            qrHint: '二维码图片随工具结果返回；用 B 站手机客户端扫码。',
            pollHint: '在对话里让 Agent 用 bili_login action=poll 查询结果。',
            cleared: 'Cookie 已清除',
            loggedIn: '已登录',
            loggedOut: '未登录',
            user: '账号',
            tutorial: '扫码步骤：① 在对话里调用 bili_login action=start 生成二维码；② 打开 B 站手机客户端扫码并确认；③ 用 action=poll 查询，成功后 Cookie 写入凭据 BILI_COOKIE。',
            logoutHint: '用 bili_login action=logout 可清除已保存的 Cookie。',
          },
        },
        settings: {
          label: 'B 站',
          title: 'B 站接入',
          intro: '本插件把 B 站接到 DeepSeek Harness：20 个 bili_* 工具覆盖搜索、视频与分P、UP 主、评论、弹幕、排行、热门、番剧、直播、字幕、播放地址与视频/音频下载；登录后可读观看历史、收藏夹、关注与动态。含工具卡片、本设置页与侧栏「B 站」浏览面板。',
          login: {
            title: '登录与运行状态',
            loading: '正在读取 /status…',
            error: '读取状态失败',
            retry: '重试',
            loggedIn: '已登录',
            loggedOut: '未登录',
            user: '账号',
            level: '等级',
            version: '插件版本',
            cookie: 'Cookie',
            cookieConfigured: '已配置',
            cookieMissing: '未配置',
            ffmpeg: 'ffmpeg',
            ffmpegReady: '可用',
            ffmpegMissing: '未找到（下载只能拿到单路音/视频）',
            downloadDir: '下载目录',
            refreshHint: '本页只读：状态来自面板取数路由 /dsh-bilibili/api/status，刷新页面或点重试即可更新。',
          },
          scan: {
            title: '扫码登录（三步）',
            step1: '1. 在对话里调用 bili_login，action=start（默认 action=status）：生成二维码，图片随工具结果返回。',
            step2: '2. 打开 B 站手机客户端「扫一扫」，扫码并在手机上确认登录。',
            step3: '3. 让 Agent 用 bili_login action=poll 查询结果；state=ok 后 Cookie 写入凭据 BILI_COOKIE，历史/收藏/关注/动态即可读取。',
            note: '退出登录用 bili_login action=logout；也可以直接在 profile 里配置 BILI_COOKIE 凭据，跳过扫码。插件不保存账号密码。',
          },
          config: {
            title: '配置键',
            hint: '配置写在 profile 的 cordis.patch.yml（bilibili 行）里；改配置值后重载一次，改代码需要重启 DSH。',
            col: {
              key: '键',
              default: '默认',
              desc: '说明',
            },
            keys: {
              cookieEnv: 'Cookie 的凭据名（credentials ref / 环境变量名）；登录成功后按此名写入。',
              requestTimeoutMs: '单次 HTTP 请求超时毫秒数（1000–120000）。',
              maxListedItems: '列表类工具一次最多返回的条数（1–200）。',
              attachImages: '把封面、头像与登录二维码作为图片附件随工具结果返回；关闭后只返回链接与路径。',
              downloadDir: '下载根目录；留空时为 %USERPROFILE%/Downloads/dsh-bilibili。',
              ffmpegPath: 'ffmpeg 可执行文件路径；留空时自动探测 PATH。',
              maxDownloadMb: '单个下载任务的体积上限（MiB，1–51200）。',
              panelEnabled: '注册侧栏「B 站」按钮与浏览面板。',
              publicRoute: '注册面板取数路由 /dsh-bilibili/api（只暴露公开数据）；关闭后面板不可用。',
              cacheTtlMs: '面板路由与工具响应的内存缓存时长毫秒数（1000–3600000）。',
              wbiCacheTtlMs: 'WBI 签名密钥缓存时长毫秒数（60000–86400000）。',
            },
            default: {
              empty: '空',
              on: '开',
              off: '关',
            },
          },
          limits: {
            title: '已知限制与版权提示',
            risk: '风控（BILI_RISK_CONTROL / -352 / -412 / -799）无法绕过：失败后按提示降级或稍后重试，不要连续硬刷。',
            auth: '未登录时个人数据工具返回 BILI_AUTH_REQUIRED；需要 bili_login start 扫码或配置 BILI_COOKIE。',
            rate: '面板只读公开接口，可能被 B 站短暂限流；Host 侧有 30 秒内存缓存，失败后稍等再刷新。',
            download: '下载依赖 ffmpeg 合并音视频；缺少 ffmpeg 时只能拿到纯视频或纯音频，且不能用于绕过付费/权限内容。',
            copyright: '下载内容仅限个人离线学习与备份，不要二次分发或用于商业用途；数据来自 B 站公开接口，请遵守 B 站用户协议。',
            panel: '本页只读展示状态与说明，不能修改配置；所有动作都要通过 bili_* 工具触发。面板不读取登录后的个人数据。',
          },
          footer: '工具、参数与接口选择见仓库 docs/INTERNAL-CONTRACT.md；安装、排障与验证状态见 README。',
        },
        panel: {
          title: 'B 站面板',
          close: '关闭',
          refresh: '刷新',
          loading: '加载中…',
          empty: '没有数据',
          retry: '重试',
          error: '加载失败',
          login: {
            loggedIn: '已登录',
            loggedOut: '未登录',
            hint: '面板只读公开数据；登录请让 Agent 调用 bili_login action=start。',
          },
          tab: {
            hot: '热搜',
            search: '搜索',
            detail: '详情',
          },
          hot: {
            title: 'B 站热搜',
            hint: '点一条热搜直接搜索。',
            empty: '暂时没有热搜',
          },
          search: {
            title: '搜索视频',
            placeholder: '输入关键词，例如：黑神话 攻略',
            submit: '搜索',
            empty: '没有搜索结果',
          },
          detail: {
            title: '视频详情',
            placeholder: '输入 BV 号，例如 BV1xx411c7mD',
            submit: '查看',
            empty: '还没有选择视频：从搜索结果点一条，或粘贴 BV 号。',
            bvid: 'BV 号',
            play: '在 B 站打开',
            duration: '时长',
            published: '发布',
            owner: 'UP 主',
            parts: '分P',
            views: '播放',
            invalidBvid: 'BV 号格式不对（BV 开头加 10 位字符）',
          },
          footer: {
            copyright: '数据来自 B 站公开接口，仅作个人浏览与研究；请遵守 B 站用户协议。',
            routeOff: '面板取数路由未注册（publicRoute=false），此面板不可用。',
          },
        },
      },
      en: {
        card: {
          preparing: 'Preparing',
          running: 'Running',
          failed: 'Failed',
          empty: 'Nothing to show',
          parseFallback: 'The structured result could not be parsed; raw text follows.',
          expand: 'Expand',
          collapse: 'Collapse',
          more: '{n} more not shown',
          page: 'Page {n}',
          unknown: 'Unknown',
          play: 'Play',
          status: {
            title: 'Bilibili status',
            loggedIn: 'Signed in',
            loggedOut: 'Signed out',
            version: 'Plugin version',
            user: 'Account',
            level: 'Level',
            cookie: 'Cookie',
            cookieConfigured: 'Configured',
            cookieMissing: 'Not configured',
            cookieSource: 'Source',
            wbi: 'WBI signing',
            wbiReady: 'Cached',
            wbiPending: 'Not fetched yet',
            ffmpeg: 'ffmpeg',
            ffmpegReady: 'Available',
            ffmpegMissing: 'Missing',
            downloadDir: 'Download directory',
            panel: 'Browsing panel',
            panelEnabled: 'Enabled',
            panelDisabled: 'Disabled',
            panelRoute: 'Panel route',
            panelRouteOff: 'Not registered (publicRoute=false)',
            hint: 'Sign-in state comes from the BILI_COOKIE credential or bili_login QR sign-in; the panel only reads public data.',
          },
          search: {
            title: 'Bilibili search',
            keyword: 'Keyword',
            total: 'Results',
            type: 'Type',
            typeVideo: 'Videos',
            typeUser: 'Creators',
            typeBangumi: 'Bangumi',
            typeLive: 'Live',
            typeArticle: 'Articles',
            empty: 'No results found',
            more: 'More results exist; continue with the page parameter.',
          },
          video: {
            title: 'Video',
            open: 'Open on Bilibili',
            bvid: 'BV id',
            owner: 'Creator',
            published: 'Published',
            duration: 'Duration',
            view: 'Views',
            danmaku: 'Danmaku',
            like: 'Likes',
            coin: 'Coins',
            favorite: 'Favorites',
            share: 'Shares',
            reply: 'Comments',
            desc: 'Description',
            parts: 'Parts',
            part: 'P{n}',
            partTitle: 'Title',
            tags: 'Tags',
            cover: 'Cover',
            playerNote: 'The embedded player uses the official Bilibili iframe; sign-in state and quality follow your browser.',
          },
          user: {
            title: 'Creator',
            mid: 'UID',
            level: 'Level',
            fans: 'Followers',
            sign: 'Bio',
            videos: 'Videos',
            noVideos: 'No uploads returned',
          },
          trend: {
            title: 'Ranking',
            popularTitle: 'Popular',
            area: 'Area',
            kind: 'Kind',
            weekly: 'Weekly picks',
            rank: 'Rank',
            count: 'Count',
            empty: 'No entries returned',
          },
          hotwords: {
            title: 'Trending searches',
            count: 'Count',
            empty: 'No trending searches returned',
          },
          comments: {
            title: 'Comments',
            count: 'Total comments',
            replyCount: '{n} replies',
            like: 'Likes',
            empty: 'No comments returned',
          },
          danmaku: {
            title: 'Danmaku',
            count: 'Total danmaku',
            sampled: 'Sampled',
            distribution: 'Per-minute distribution',
            minute: 'Minute {n}',
            empty: 'No danmaku returned',
          },
          login: {
            title: 'QR sign-in',
            stateWaiting: 'Waiting for scan',
            stateScanned: 'Scanned, waiting for confirmation',
            stateExpired: 'QR code expired',
            stateOk: 'Signed in',
            message: 'Message',
            qrcodeKey: 'QR code key',
            mid: 'UID',
            code: 'Status code',
            expire: 'Valid for {n} seconds',
            qrHint: 'The QR image returns with the tool result; scan it in the Bilibili mobile app.',
            pollHint: 'Ask the agent to call bili_login with action=poll to check the result.',
            cleared: 'Cookies cleared',
            loggedIn: 'Signed in',
            loggedOut: 'Signed out',
            user: 'Account',
            tutorial: 'Scan steps: 1) call bili_login with action=start in the conversation to generate a QR code; 2) scan and confirm it in the Bilibili mobile app; 3) poll with action=poll — once successful the cookie is written to the BILI_COOKIE credential.',
            logoutHint: 'Call bili_login with action=logout to clear the saved cookie.',
          },
        },
        settings: {
          label: 'Bilibili',
          title: 'Bilibili integration',
          intro: 'This plugin connects Bilibili to DeepSeek Harness: 20 bili_* tools cover search, videos and parts, creators, comments, danmaku, ranking, popular, bangumi, live, subtitles, play URLs and video/audio download; after sign-in it reads watch history, favorites, follows and dynamics. It ships tool cards, this settings page and a Bilibili browsing panel at the sidebar foot.',
          login: {
            title: 'Sign-in and runtime status',
            loading: 'Reading /status…',
            error: 'Failed to read status',
            retry: 'Retry',
            loggedIn: 'Signed in',
            loggedOut: 'Signed out',
            user: 'Account',
            level: 'Level',
            version: 'Plugin version',
            cookie: 'Cookie',
            cookieConfigured: 'Configured',
            cookieMissing: 'Not configured',
            ffmpeg: 'ffmpeg',
            ffmpegReady: 'Available',
            ffmpegMissing: 'Missing (downloads fall back to one media stream)',
            downloadDir: 'Download directory',
            refreshHint: 'This page is read-only: status comes from the panel route /dsh-bilibili/api/status; reload the page or press Retry to refresh.',
          },
          scan: {
            title: 'QR sign-in in three steps',
            step1: '1. Call bili_login with action=start in the conversation (the default action is status): it generates a QR code and returns the image with the tool result.',
            step2: '2. Open Scan in the Bilibili mobile app, scan the code and confirm the sign-in on the phone.',
            step3: '3. Ask the agent to poll with bili_login action=poll; when state=ok the cookie is written to the BILI_COOKIE credential and history, favorites, follows and dynamics become readable.',
            note: 'Sign out with bili_login action=logout, or configure the BILI_COOKIE credential directly in the profile to skip the QR flow. The plugin never stores an account password.',
          },
          config: {
            title: 'Configuration keys',
            hint: "Configure the bilibili row in the profile's cordis.patch.yml. Configuration values apply after a reload; source code changes need a DSH restart.",
            col: {
              key: 'Key',
              default: 'Default',
              desc: 'Description',
            },
            keys: {
              cookieEnv: 'Credential name (credentials ref / environment variable name) for the cookie; a successful sign-in writes to this name.',
              requestTimeoutMs: 'Per-request HTTP timeout in milliseconds (1000-120000).',
              maxListedItems: 'Maximum items a list tool returns per call (1-200).',
              attachImages: 'Attach covers, avatars and the sign-in QR code to tool results as images; when off only links and paths return.',
              downloadDir: 'Root download directory; empty uses %USERPROFILE%/Downloads/dsh-bilibili.',
              ffmpegPath: 'Path to the ffmpeg executable; empty auto-detects from PATH.',
              maxDownloadMb: 'Size cap for one download in MiB (1-51200).',
              panelEnabled: 'Register the Bilibili button and browsing panel at the sidebar foot.',
              publicRoute: 'Register the panel route /dsh-bilibili/api (public data only); when off the panel is unavailable.',
              cacheTtlMs: 'In-memory cache lifetime for panel routes and tool responses in milliseconds (1000-3600000).',
              wbiCacheTtlMs: 'Cache lifetime for WBI signing keys in milliseconds (60000-86400000).',
            },
            default: {
              empty: 'empty',
              on: 'on',
              off: 'off',
            },
          },
          limits: {
            title: 'Known limits and copyright',
            risk: 'Risk control (BILI_RISK_CONTROL / -352 / -412 / -799) cannot be bypassed: degrade or retry later as the hint says, and never hammer the endpoint.',
            auth: 'Personal-data tools return BILI_AUTH_REQUIRED while signed out; run bili_login with action=start or configure BILI_COOKIE.',
            rate: 'The panel reads public endpoints only and may be briefly rate-limited; the Host keeps a 30-second memory cache, so wait before refreshing again.',
            download: 'Downloads merge audio and video with ffmpeg; without ffmpeg only one stream is available, and paid or restricted content cannot be unlocked.',
            copyright: 'Downloaded content is for personal offline study and backup only: do not redistribute it or use it commercially. Data comes from public Bilibili APIs; follow the Bilibili terms of service.',
            panel: 'This page is read-only and cannot change configuration; every action runs through the bili_* tools. The panel never reads personal data.',
          },
          footer: "Tool and parameter contracts live in the repository's docs/INTERNAL-CONTRACT.md; installation, troubleshooting and verification status live in README.",
        },
        panel: {
          title: 'Bilibili panel',
          close: 'Close',
          refresh: 'Refresh',
          loading: 'Loading…',
          empty: 'No data',
          retry: 'Retry',
          error: 'Failed to load',
          login: {
            loggedIn: 'Signed in',
            loggedOut: 'Signed out',
            hint: 'The panel reads public data only; ask the agent to call bili_login with action=start to sign in.',
          },
          tab: {
            hot: 'Trending',
            search: 'Search',
            detail: 'Details',
          },
          hot: {
            title: 'Bilibili trending',
            hint: 'Click a trending keyword to search it.',
            empty: 'No trending searches right now',
          },
          search: {
            title: 'Search videos',
            placeholder: 'Type a keyword, e.g. game guide',
            submit: 'Search',
            empty: 'No search results',
          },
          detail: {
            title: 'Video details',
            placeholder: 'Enter a BV id, e.g. BV1xx411c7mD',
            submit: 'Open',
            empty: 'No video selected yet: pick a search result or paste a BV id.',
            bvid: 'BV id',
            play: 'Open on Bilibili',
            duration: 'Duration',
            published: 'Published',
            owner: 'Creator',
            parts: 'Parts',
            views: 'Views',
            invalidBvid: 'Invalid BV id (BV followed by 10 characters)',
          },
          footer: {
            copyright: 'Data comes from public Bilibili APIs for personal browsing and research; follow the Bilibili terms of service.',
            routeOff: 'The panel route is not registered (publicRoute=false), so this panel is unavailable.',
          },
        },
      },
    };

    /** 10 个注册自定义卡片的工具名（其余 bili_* 工具沿用宿主通用卡片）。 */
    const CARD_TOOLS = [
      'bili_status', 'bili_search', 'bili_video', 'bili_user', 'bili_ranking',
      'bili_popular', 'bili_hotwords', 'bili_comments', 'bili_danmaku', 'bili_login',
    ];

    /** 设置页配置键与默认值（与 lib/config.js、cordis.patch.yml 的 bilibili 行一致，共 11 项）。 */
    const CONFIG_ROWS = [
      ['cookieEnv', 'BILI_COOKIE'],
      ['requestTimeoutMs', '15000'],
      ['maxListedItems', '25'],
      ['attachImages', 'true'],
      ['downloadDir', ''],
      ['ffmpegPath', ''],
      ['maxDownloadMb', '2048'],
      ['panelEnabled', 'true'],
      ['publicRoute', 'true'],
      ['cacheTtlMs', '60000'],
      ['wbiCacheTtlMs', '3600000'],
    ];

    // ---------------------------------------------------------------- 面板 store

    /**
     * 模块级面板开合 store：侧栏按钮与 shell.overlay 抽屉是两个独立 slot 的组件，
     * 只有共享同一个模块级状态才能同步开合（useSyncExternalStore 订阅）。
     */
    let panelOpen = false;
    /** @type {Set<() => void>} */
    const panelListeners = new Set();

    /** 通知所有订阅者。 */
    function emitPanel() {
      for (const listener of [...panelListeners]) {
        try {
          listener();
        } catch (error) {
          // 单个订阅者抛错不影响其它订阅者。
          if (typeof console !== 'undefined' && typeof console.warn === 'function') {
            console.warn('[bilibili] 面板订阅者执行失败：', error);
          }
        }
      }
    }

    /**
     * 设置面板开合（幂等）。
     * @param {boolean} next - 目标状态。
     * @returns {void}
     */
    function setPanelOpen(next) {
      const value = next === true;
      if (value === panelOpen) return;
      panelOpen = value;
      emitPanel();
    }

    /** 翻转面板开合。 */
    function togglePanel() {
      setPanelOpen(!panelOpen);
    }

    /**
     * 订阅面板状态（useSyncExternalStore 的 subscribe）。
     * @param {() => void} listener - 订阅回调。
     * @returns {() => void} 取消订阅。
     */
    function subscribePanel(listener) {
      panelListeners.add(listener);
      return () => {
        panelListeners.delete(listener);
      };
    }

    /** 面板状态快照（useSyncExternalStore 的 getSnapshot）。 */
    function getPanelSnapshot() {
      return panelOpen;
    }

    /** 组件外可用的 useSyncExternalStore；宿主 React 版本过旧时退化为 useState+useEffect。 */
    const useSyncExternalStore = typeof React.useSyncExternalStore === 'function'
      ? React.useSyncExternalStore
      : (subscribe, getSnapshot) => {
        const [value, setValue] = React.useState(getSnapshot);
        React.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot]);
        return value;
      };

    /** 订阅面板开合状态。 */
    function usePanelOpen() {
      return useSyncExternalStore(subscribePanel, getPanelSnapshot);
    }

    // ---------------------------------------------------------------- 纯工具函数

    /** 恒等文案函数：locale 座椅缺失时的兜底，保证组件不会抛错。 */
    function fallbackT(key) {
      return key;
    }

    /**
     * 取组件上的本地化函数。
     * @param {object} props - 组件 props。
     * @returns {(key: string, params?: object) => string} 翻译函数。
     */
    function translator(props) {
      return props !== null && typeof props === 'object' && typeof props.t === 'function' ? props.t : fallbackT;
    }

    /** 安全执行：任何模型推导抛错都退化成兜底视图，避免整个 slot entry 崩掉。 */
    function safe(fn, fallback) {
      try {
        return fn();
      } catch (error) {
        return typeof fallback === 'function' ? fallback(error) : fallback;
      }
    }

    /** 是否普通对象（排除数组与 null）。 */
    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    /** 字符串化一个可能为空的标量。 */
    function stringOf(value) {
      if (value === null || value === undefined) return null;
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return null;
    }

    /** 值是否有内容（null/undefined/空串都算没有）。 */
    function present(value) {
      return value !== null && value !== undefined && value !== '';
    }

    /** 数字文本（整数不带小数，小数最多两位）。 */
    function numberText(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return stringOf(value) ?? '—';
      if (Number.isInteger(number)) return String(number);
      return number.toFixed(2).replace(/\.?0+$/, '');
    }

    /** 紧凑计数文本（跟随浏览器语言：1.2万 / 1.2M）。 */
    let compactFormatter = null;
    function countText(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return stringOf(value) ?? '—';
      try {
        if (compactFormatter === null) {
          compactFormatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
        }
        return compactFormatter.format(number);
      } catch (error) {
        return numberText(number);
      }
    }

    /** 补零。 */
    function pad2(value) {
      return value < 10 ? `0${value}` : String(value);
    }

    /** 秒数 → m:ss / h:mm:ss。 */
    function clockText(seconds) {
      const number = Number(seconds);
      if (!Number.isFinite(number) || number < 0) return null;
      const total = Math.round(number);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const rest = total % 60;
      if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(rest)}`;
      return `${minutes}:${pad2(rest)}`;
    }

    /** 条目时长文本：优先 durationText，其次由 durationSec 计算。 */
    function itemDurationText(item) {
      if (!isRecord(item)) return null;
      const text = stringOf(item.durationText);
      if (text !== null && text !== '') return text;
      return clockText(item.durationSec);
    }

    /** 发布时间的本地文本：优先 pubdateText，其次按 pubdate 秒数格式化。 */
    function itemDateText(item) {
      if (!isRecord(item)) return null;
      const text = stringOf(item.pubdateText);
      if (text !== null && text !== '') return text;
      const seconds = Number(item.pubdate);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      try {
        return new Date(seconds * 1000).toLocaleDateString();
      } catch (error) {
        return null;
      }
    }

    /** 把一个值裁成单行摘要。 */
    function oneLine(value, limit) {
      const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
      const max = Number.isFinite(limit) ? limit : 120;
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    /** 结果文本里第一个非空行（错误/摘要用）。 */
    function firstLine(text) {
      const line = String(text === null || text === undefined ? '' : text)
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry !== '');
      return line === undefined ? null : line;
    }

    /**
     * 从工具结果块里取文本、图片数量与结构化 JSON（取最后一个 ```json 围栏块）。
     * @param {object | null | undefined} block - 工具结果块。
     * @returns {{ text: string, imageCount: number, isError: boolean, payload: any, data: any }} 解析结果。
     */
    function readResult(block) {
      const content = isRecord(block) && Array.isArray(block.content) ? block.content : [];
      const texts = [];
      let imageCount = 0;
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
        else if (part.type === 'image') imageCount += 1;
      }
      const text = texts.join('\n').trim();
      const payload = parseLastFence(text);
      const data = isRecord(payload) && payload.ok === true ? payload.data : null;
      return {
        text,
        imageCount,
        isError: isRecord(block) && block.isError === true,
        payload,
        data: data === undefined ? null : data,
      };
    }

    /**
     * 取文本里最后一个 ```json 围栏块并 JSON 解析；失败返回 null。
     * @param {string} text - 工具结果文本。
     * @returns {any | null} 解析结果。
     */
    function parseLastFence(text) {
      if (typeof text !== 'string' || text === '') return null;
      const pattern = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
      let match = null;
      let last = null;
      while ((match = pattern.exec(text)) !== null) last = match[1];
      if (last === null) return null;
      return safe(() => {
        const parsed = JSON.parse(last);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
      }, null);
    }

    /** 去掉文本末尾的 JSON 围栏块，得到人类可读摘要。 */
    function humanText(text) {
      if (typeof text !== 'string') return '';
      return text.replace(/(?:^|\n)[ \t]*```json[ \t]*\r?\n[\s\S]*?\r?\n```[ \t]*\s*$/, '').trim();
    }

    /** 读工具调用参数（preparing 阶段可能没有）。 */
    function callArgs(block) {
      if (!isRecord(block)) return null;
      const raw = typeof block.argsRaw === 'string'
        ? block.argsRaw
        : isRecord(block.call) && typeof block.call.argsRaw === 'string' ? block.call.argsRaw : null;
      if (raw === null || raw === '') return null;
      return safe(() => {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
      }, null);
    }

    /** 外部链接的规范化：只放行 http(s) 与协议相对地址。 */
    function externalUrl(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') return null;
      if (text.startsWith('//')) return `https:${text}`;
      if (/^https?:\/\//i.test(text)) return text;
      return null;
    }

    /**
     * 图片代理 URL：只接受 http(s)，统一走 `/dsh-bilibili/api/image?u=`。
     * @param {string} raw - 原始图片地址（可能是 // 开头的协议相对地址）。
     * @returns {string | null} 代理路径或 null。
     */
    function imageUrl(raw) {
      const text = typeof raw === 'string' ? raw.trim() : '';
      if (text === '') return null;
      let absolute = text;
      if (absolute.startsWith('//')) absolute = `https:${absolute}`;
      else if (/^http:\/\//i.test(absolute)) absolute = `https://${absolute.slice('http://'.length)}`;
      if (!/^https:\/\//i.test(absolute)) return null;
      return `${IMAGE_ROUTE}?u=${encodeURIComponent(absolute)}`;
    }

    /** 封面/头像加载失败就隐藏，避免破图标。 */
    function hideImage(event) {
      if (event !== null && event !== undefined && event.currentTarget !== null && event.currentTarget !== undefined) {
        event.currentTarget.style.display = 'none';
      }
    }

    /** BV 号归一化：容忍链接与多余文字，取第一段合法 BV 号。 */
    function normalizeBvid(value) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return null;
      const match = /BV[0-9A-Za-z]{10}/.exec(text);
      if (match === null) return null;
      return BVID_PATTERN.test(match[0]) ? match[0] : null;
    }

    /** 视频的 B 站地址。 */
    function videoWebUrl(video) {
      if (!isRecord(video)) return null;
      const url = externalUrl(video.url);
      if (url !== null) return url;
      const bvid = stringOf(video.bvid);
      return bvid === null ? null : `https://www.bilibili.com/video/${bvid}`;
    }

    /** 搜索/排行等条目要展示的 B 站地址。 */
    function itemWebUrl(item) {
      if (!isRecord(item)) return null;
      const url = externalUrl(item.url);
      if (url !== null) return url;
      const bvid = stringOf(item.bvid);
      if (bvid !== null) return `https://www.bilibili.com/video/${bvid}`;
      const mid = stringOf(item.mid);
      return mid === null ? null : `https://space.bilibili.com/${mid}`;
    }

    // ---------------------------------------------------------------- 视图原子

    /** 一个小标题目录。 */
    function sectionTitle(t, key) {
      return h('div', { className: 'bili-section-title', key: `section:${key}` }, t(key));
    }

    /** 定义列表：只渲染有值的行。 */
    function fields(t, rows) {
      const items = [];
      for (const row of rows) {
        const labelKey = row[0];
        const value = row[1];
        if (!present(value)) continue;
        items.push(h('dt', { key: `dt:${labelKey}` }, t(labelKey)));
        items.push(h('dd', { key: `dd:${labelKey}` }, String(value)));
      }
      if (items.length === 0) return null;
      return h('dl', { className: 'bili-dl' }, items);
    }

    /** 计数小标签。 */
    function chips(t, rows) {
      const items = [];
      for (const row of rows) {
        if (!present(row.value)) continue;
        items.push(h('span', { className: 'bili-chip', key: `chip:${row.key}` },
          h('span', null, t(row.labelKey)),
          h('b', null, String(row.value))));
      }
      if (items.length === 0) return null;
      return h('div', { className: 'bili-chips' }, items);
    }

    /** 简单表格：headerKeys 是 locale key 列表，rows 是二维数组。 */
    function simpleTable(headerKeys, rows, t) {
      if (rows.length === 0) return null;
      const head = h('tr', null, headerKeys.map((key) => h('th', { key, scope: 'col' }, t(key))));
      const body = rows.map((cells, index) => h('tr', { key: String(index) },
        cells.map((cell, cellIndex) => h('td', { key: String(cellIndex) },
          cell === null || cell === undefined || cell === '' ? '—' : String(cell)))));
      return h('div', { className: 'bili-table-wrap' },
        h('table', { className: 'bili-table' }, h('thead', null, head), h('tbody', null, body)));
    }

    /** 错误态视图体：错误首行 + 完整原始文本。 */
    function errorBody(t, result) {
      const human = humanText(result.text);
      const line = firstLine(human) ?? t('card.failed');
      const body = [h('div', { className: 'bili-error', key: 'bili-error' }, line)];
      if (human !== '' && human !== line) {
        body.push(h('pre', { className: 'bili-pre', key: 'bili-error-detail' }, human));
      }
      return body;
    }

    /** 原始文本兜底视图体。 */
    function rawBody(t, result) {
      const human = humanText(result.text);
      const body = [];
      if (result.payload !== null && result.payload !== undefined) {
        body.push(h('div', { className: 'bili-note', key: 'bili-parse-note' }, t('card.parseFallback')));
      }
      body.push(h('pre', { className: 'bili-pre', key: 'bili-raw' }, human === '' ? result.text : human));
      return body;
    }

    /** preparing / running 阶段视图。 */
    function pendingView(t, phase) {
      const label = phase === 'preparing' ? t('card.preparing') : t('card.running');
      return { summary: label, badge: label, tone: 'idle', body: null };
    }

    /** 错误视图。 */
    function errorView(t, result) {
      const line = result === null ? t('card.failed') : oneLine(firstLine(humanText(result.text)) ?? t('card.failed'), 120);
      return {
        summary: line,
        badge: t('card.failed'),
        tone: 'error',
        body: result === null ? [h('div', { className: 'bili-error' }, line)] : errorBody(t, result),
      };
    }

    /** 无数据/无围栏时退化到原始文本。 */
    function rawView(t, result) {
      const summary = oneLine(firstLine(humanText(result.text)) ?? t('card.empty'), 120);
      return { summary, badge: null, tone: 'idle', body: rawBody(t, result) };
    }

    /** 标题链接。 */
    function titleLink(text, url, className) {
      const label = String(text === null || text === undefined ? '' : text);
      if (url === null) return h('span', { className }, label);
      return h('a', {
        className,
        href: url,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: label,
      }, label);
    }

    /** 代理图片；没有可用地址或加载失败时返回 null / 隐藏。 */
    function coverImage(t, raw, className, alt) {
      const src = imageUrl(raw);
      if (src === null) return null;
      return h('img', {
        className,
        src,
        alt: alt === undefined ? '' : alt,
        loading: 'lazy',
        onError: hideImage,
      });
    }

    /** 条目行图标（按 item.type 区分）。 */
    function itemGlyph(item) {
      const type = isRecord(item) ? stringOf(item.type) : null;
      if (type === 'user') return glyph('user');
      if (type === 'bangumi') return glyph('danmaku');
      if (type === 'live') return glyph('popular');
      if (type === 'article') return glyph('comments');
      return glyph('video');
    }

    /**
     * 一行条目：缩略图 + 标题 + 元信息。
     * @param {object} item - §9 的 Item。
     * @param {object} options - { t, rank?, onSelect? }。
     * @returns {object | null} React 节点。
     */
    function itemRow(item, options) {
      if (!isRecord(item)) return null;
      const t = options.t;
      const title = stringOf(item.title) ?? stringOf(item.name) ?? t('card.unknown');
      const bits = [];
      const author = stringOf(item.author);
      if (author !== null && author !== '') bits.push(author);
      if (present(item.play)) bits.push(`${countText(item.play)} ${t('card.video.view')}`);
      else if (present(item.fans)) bits.push(`${countText(item.fans)} ${t('card.user.fans')}`);
      else if (present(item.mid)) bits.push(`${t('card.user.mid')} ${item.mid}`);
      const duration = itemDurationText(item);
      if (duration !== null) bits.push(duration);
      const meta = bits.join(' · ');
      const children = [];
      if (present(options.rank)) children.push(h('span', { className: 'bili-item-rank', key: 'bili-item-rank' }, String(options.rank)));
      else children.push(h('span', { className: 'bili-item-icon', key: 'bili-item-icon', 'aria-hidden': true }, itemGlyph(item)));
      const cover = coverImage(t, item.cover, 'bili-thumb', '');
      if (cover !== null) children.push(h('span', { className: 'bili-thumb-wrap', key: 'bili-thumb-wrap' }, cover));
      children.push(h('span', { className: 'bili-item-main', key: 'bili-item-main' },
        h('span', { className: 'bili-item-title', title }, title),
        meta === '' ? null : h('span', { className: 'bili-item-meta' }, meta)));
      if (typeof options.onSelect === 'function') {
        return h('button', {
          type: 'button',
          className: 'bili-item bili-item-button',
          key: String(item.bvid ?? item.mid ?? title),
          onClick: () => options.onSelect(item),
        }, children);
      }
      const url = itemWebUrl(item);
      return h('a', {
        className: 'bili-item',
        key: String(item.bvid ?? item.mid ?? title),
        href: url === null ? undefined : url,
        target: url === null ? undefined : '_blank',
        rel: 'noreferrer noopener',
      }, children);
    }

    /**
     * 条目列表 + 「还有 N 项」脚注。
     * @param {object[]} items - 条目数组。
     * @param {object} options - { t, max?, showRank?, onSelect? }。
     * @returns {object[]} React 节点数组。
     */
    function itemList(items, options) {
      const t = options.t;
      const max = Number.isFinite(options.max) ? options.max : 8;
      const rows = [];
      const shown = Math.min(items.length, max);
      for (let index = 0; index < shown; index += 1) {
        const node = itemRow(items[index], {
          t,
          rank: options.showRank === true ? index + 1 : undefined,
          onSelect: options.onSelect,
        });
        if (node !== null) rows.push(node);
      }
      const blocks = [];
      if (rows.length > 0) blocks.push(h('div', { className: 'bili-items', key: 'bili-items' }, rows));
      if (items.length > shown) {
        blocks.push(h('div', { className: 'bili-note', key: 'bili-items-more' }, t('card.more', { n: items.length - shown })));
      }
      return blocks;
    }

    /** 播放器 iframe 容器。 */
    function playerFrame(bvid, title) {
      if (typeof bvid !== 'string' || bvid === '') return null;
      return h('div', { className: 'bili-player' },
        h('iframe', {
          src: `${PLAYER_BASE}${bvid}&autoplay=0&danmaku=0`,
          title,
          loading: 'lazy',
          allowFullScreen: true,
          scrolling: 'no',
        }));
    }

    /** 「在 B 站打开」链接。 */
    function openLink(t, url, key, labelKey) {
      if (url === null) return null;
      return h('a', {
        className: 'bili-link',
        key: key === undefined ? 'bili-open' : key,
        href: url,
        target: '_blank',
        rel: 'noreferrer noopener',
      }, t(labelKey === undefined ? 'card.video.open' : labelKey));
    }

    // ---------------------------------------------------------------- 图标

    /** 内联 SVG 图标（卡片行首 14px，面板按钮 16px）。 */
    function glyph(name, size) {
      const edge = size === undefined ? 14 : size;
      const common = {
        viewBox: '0 0 16 16',
        width: edge,
        height: edge,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
      };
      if (name === 'status') {
        return h('svg', common, h('circle', { cx: 8, cy: 8, r: 5.9 }), h('path', { d: 'M8 4.8v3.4l2.1 1.3' }));
      }
      if (name === 'search') {
        return h('svg', common, h('circle', { cx: 7, cy: 7, r: 4.1 }), h('path', { d: 'M10.1 10.1 L13.8 13.8' }));
      }
      if (name === 'video') {
        return h('svg', common,
          h('rect', { x: 1.8, y: 3.1, width: 12.4, height: 9.8, rx: 1.3 }),
          h('path', { d: 'M6.5 6 L10.3 8 L6.5 10 Z', fill: 'currentColor', stroke: 'none' }));
      }
      if (name === 'user') {
        return h('svg', common, h('circle', { cx: 8, cy: 5.6, r: 2.6 }), h('path', { d: 'M2.9 13.4c0-2.6 2.3-4.3 5.1-4.3s5.1 1.7 5.1 4.3' }));
      }
      if (name === 'ranking') {
        return h('svg', common,
          h('rect', { x: 2.2, y: 8, width: 2.6, height: 5.8, rx: 0.8 }),
          h('rect', { x: 6.7, y: 4.4, width: 2.6, height: 9.4, rx: 0.8 }),
          h('rect', { x: 11.2, y: 6.6, width: 2.6, height: 7.2, rx: 0.8 }));
      }
      if (name === 'popular') {
        return h('svg', common, h('path', { d: 'M2.4 11.6 L6.2 7.7 L9 10 L13.6 4.4' }), h('path', { d: 'M10.4 4.4 H13.6 V7.6' }));
      }
      if (name === 'hotwords') {
        return h('svg', common,
          h('path', { d: 'M6.2 2.6 L4.8 13.4' }),
          h('path', { d: 'M11.2 2.6 L9.8 13.4' }),
          h('path', { d: 'M2.6 6.1 H13.4' }),
          h('path', { d: 'M2.2 10 H13' }));
      }
      if (name === 'comments') {
        return h('svg', common,
          h('rect', { x: 2, y: 2.8, width: 12, height: 8.8, rx: 2 }),
          h('path', { d: 'M5.4 11.6 L5.4 14 L8.6 11.6' }));
      }
      if (name === 'danmaku') {
        return h('svg', common,
          h('path', { d: 'M2.4 4.4 H10.2' }),
          h('path', { d: 'M5.4 8 H13.6' }),
          h('path', { d: 'M2.4 11.6 H8.6' }));
      }
      if (name === 'login') {
        return h('svg', common,
          h('rect', { x: 2.4, y: 2.4, width: 4.4, height: 4.4, rx: 0.9 }),
          h('rect', { x: 9.2, y: 2.4, width: 4.4, height: 4.4, rx: 0.9 }),
          h('rect', { x: 2.4, y: 9.2, width: 4.4, height: 4.4, rx: 0.9 }),
          h('path', { d: 'M9.6 9.6 H13.6 V13.6 H9.6 Z' }));
      }
      if (name === 'close') {
        return h('svg', common, h('path', { d: 'M3.6 3.6 L12.4 12.4' }), h('path', { d: 'M12.4 3.6 L3.6 12.4' }));
      }
      if (name === 'refresh') {
        return h('svg', common,
          h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.8' }),
          h('path', { d: 'M13.4 2.6 V5.2 H10.8' }));
      }
      if (name === 'play') {
        return h('svg', common, h('path', { d: 'M4.8 2.8 L13 8 L4.8 13.2 Z', fill: 'currentColor', stroke: 'none' }));
      }
      return h('svg', common, h('path', { d: 'M2.6 8.4 L6.4 12.2 L13.4 4.2' }));
    }

    // ---------------------------------------------------------------- 卡片外框

    /** 卡片外框：折叠行 + 展开体（外壳由宿主拥有，这里只补自己的块）。 */
    function CardFrame(props) {
      const expandable = props.expandable === true;
      const handleKeyDown = expandable
        ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          props.onToggle();
        }
        : undefined;
      const rowProps = {
        className: 'bili-row',
        title: expandable ? (props.expanded === true ? props.collapseLabel : props.expandLabel) : undefined,
        onClick: expandable ? props.onToggle : undefined,
        onKeyDown: handleKeyDown,
      };
      if (expandable) {
        rowProps.role = 'button';
        rowProps.tabIndex = 0;
        rowProps['aria-expanded'] = props.expanded === true;
      }
      const row = h('div', rowProps,
        h('span', { className: 'bili-leading', 'aria-hidden': true }, glyph(props.glyph)),
        h('span', { className: 'bili-title' }, props.title),
        h('span', { className: 'bili-sep', 'aria-hidden': true }),
        h('span', { className: 'bili-summary' }, props.summary),
        props.badge === null || props.badge === undefined
          ? null
          : h('span', { className: 'bili-badge', 'data-tone': props.tone === undefined ? 'idle' : props.tone }, props.badge));
      return h('div', { className: 'bili-root', 'data-tool': props.toolName },
        row,
        expandable && props.expanded === true
          ? h('div', { className: 'bili-body' }, props.body)
          : null);
    }

    /**
     * 生成一个卡片组件：模型推导包在 try/catch 里，失败退化成错误文本。
     * @param {{ titleKey: string, glyph: string, build: (state: object) => object }} spec - 卡片定义。
     * @returns {Function} React 组件。
     */
    function defineCard(spec) {
      return function BiliToolCard(props) {
        const t = translator(props);
        const disclosure = typeof props.useDisclosure === 'function' ? props.useDisclosure() : null;
        const expanded = disclosure !== null && disclosure.expanded === true
          ? true
          : disclosure === null && props.expanded === true;
        const onToggle = () => {
          if (disclosure !== null && typeof disclosure.toggle === 'function') {
            disclosure.toggle();
            return;
          }
          if (typeof props.onToggle === 'function') props.onToggle();
        };
        const block = props.block;
        const phase = typeof props.phase === 'string' ? props.phase : 'result';
        const result = phase === 'result' ? readResult(block) : null;
        const args = phase === 'preparing' ? null : callArgs(block);
        const view = safe(
          () => spec.build({ t, phase, block, result, args }),
          () => errorView(t, result),
        );
        const body = view !== null && typeof view === 'object' ? view.body : null;
        return h(CardFrame, {
          toolName: props.toolName,
          glyph: spec.glyph,
          title: t(spec.titleKey),
          summary: view !== null && typeof view === 'object' ? view.summary : t('card.empty'),
          badge: view !== null && typeof view === 'object' && view.badge !== undefined ? view.badge : null,
          tone: view !== null && typeof view === 'object' && view.tone !== undefined ? view.tone : 'idle',
          // 宿主可通过 expandable 关闭折叠；没有该 prop 时按 body 是否存在决定。
          expandable: body !== null && body !== undefined && props.expandable !== false,
          expanded,
          onToggle,
          expandLabel: t('card.expand'),
          collapseLabel: t('card.collapse'),
          body,
        });
      };
    }

    // ---------------------------------------------------------------- bili_status

    /** 状态卡片模型。 */
    function statusView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const user = isRecord(data.user) ? data.user : null;
      const cookie = isRecord(data.cookie) ? data.cookie : null;
      const wbi = isRecord(data.wbi) ? data.wbi : null;
      const ffmpeg = isRecord(data.ffmpeg) ? data.ffmpeg : null;
      const panel = isRecord(data.panel) ? data.panel : null;
      const download = isRecord(data.download) ? data.download : null;
      const loggedIn = data.loggedIn === true;
      const uname = user === null ? null : stringOf(user.uname) ?? stringOf(user.name);
      const badge = loggedIn ? t('card.status.loggedIn') : t('card.status.loggedOut');
      const tone = loggedIn ? 'success' : 'idle';
      const panelRoute = panel === null ? null : panel.route;
      let panelRouteText = null;
      if (panelRoute === false) panelRouteText = t('card.status.panelRouteOff');
      else if (typeof panelRoute === 'string' && panelRoute !== '') panelRouteText = panelRoute;
      const rows = fields(t, [
        ['card.status.version', stringOf(data.version)],
        ['card.status.user', uname],
        ['card.status.level', user !== null && present(user.level) ? `LV${numberText(user.level)}` : null],
        ['card.status.cookie', cookie === null ? null : cookie.configured === true ? t('card.status.cookieConfigured') : t('card.status.cookieMissing')],
        ['card.status.cookieSource', cookie === null ? null : stringOf(cookie.source)],
        ['card.status.wbi', wbi === null ? null : wbi.cached === true ? t('card.status.wbiReady') : t('card.status.wbiPending')],
        ['card.status.ffmpeg', ffmpeg === null ? null : ffmpeg.available === true
          ? `${t('card.status.ffmpegReady')}${present(ffmpeg.version) ? ` ${ffmpeg.version}` : ''}`
          : t('card.status.ffmpegMissing')],
        ['card.status.downloadDir', download === null ? null : stringOf(download.dir)],
        ['card.status.panel', panel === null ? null : panel.enabled === true ? t('card.status.panelEnabled') : t('card.status.panelDisabled')],
        ['card.status.panelRoute', panelRouteText],
      ]);
      const body = [];
      if (rows !== null) body.push(rows);
      body.push(h('div', { className: 'bili-note', key: 'bili-status-hint' }, t('card.status.hint')));
      const summaryBits = [badge];
      if (uname !== null && uname !== '') summaryBits.push(uname);
      if (present(data.version)) summaryBits.push(`v${data.version}`);
      return { summary: summaryBits.join(' · '), badge, tone, body };
    }

    const StatusCard = defineCard({
      titleKey: 'card.status.title',
      glyph: 'status',
      build: statusView,
    });

    // ---------------------------------------------------------------- bili_search

    /** 搜索类型 → locale key。 */
    function searchTypeKey(type) {
      const map = {
        video: 'card.search.typeVideo',
        user: 'card.search.typeUser',
        bangumi: 'card.search.typeBangumi',
        live: 'card.search.typeLive',
        article: 'card.search.typeArticle',
      };
      return map[typeof type === 'string' ? type : ''] ?? 'card.search.typeVideo';
    }

    /** 搜索卡片模型。 */
    function searchView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const items = Array.isArray(data.items) ? data.items : [];
      const keyword = stringOf(data.keyword) ?? '';
      const typeText = t(searchTypeKey(data.type));
      const body = [];
      const header = chips(t, [
        { key: 'keyword', labelKey: 'card.search.keyword', value: keyword },
        { key: 'type', labelKey: 'card.search.type', value: typeText },
        { key: 'total', labelKey: 'card.search.total', value: present(data.total) ? countText(data.total) : items.length },
        { key: 'page', labelKey: 'card.page', value: present(data.page) ? data.page : 1 },
      ]);
      if (header !== null) body.push(header);
      if (items.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-search-empty' }, t('card.search.empty')));
      } else {
        body.push(...itemList(items, { t, max: 8 }));
      }
      if (data.hasMore === true) body.push(h('div', { className: 'bili-note', key: 'bili-search-more' }, t('card.search.more')));
      const summary = [keyword, typeText, `${items.length}`].filter((entry) => entry !== '').join(' · ');
      return { summary, badge: null, tone: 'idle', body };
    }

    const SearchCard = defineCard({
      titleKey: 'card.search.title',
      glyph: 'search',
      build: searchView,
    });

    // ---------------------------------------------------------------- bili_video

    /** 视频统计字段（locale key 与 stat 字段）。 */
    const VIDEO_STAT_ROWS = [
      ['card.video.view', 'view'],
      ['card.video.danmaku', 'danmaku'],
      ['card.video.like', 'like'],
      ['card.video.coin', 'coin'],
      ['card.video.favorite', 'favorite'],
      ['card.video.share', 'share'],
      ['card.video.reply', 'reply'],
    ];

    /** 视频卡片模型。 */
    function videoView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const video = isRecord(data.video) ? data.video : null;
      if (video === null) return rawView(t, result);
      const owner = isRecord(video.owner) ? video.owner : null;
      const stat = isRecord(video.stat) ? video.stat : null;
      const parts = Array.isArray(data.parts) ? data.parts : [];
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const bvid = stringOf(video.bvid);
      const url = videoWebUrl(video);
      const title = stringOf(video.title) ?? t('card.video.title');
      const body = [];

      const cover = coverImage(t, video.cover, 'bili-cover', t('card.video.cover'));
      if (cover !== null) body.push(h('div', { className: 'bili-cover-wrap', key: 'bili-cover' }, cover));

      body.push(h('div', { className: 'bili-video-head', key: 'bili-video-head' },
        titleLink(title, url, 'bili-video-title'),
        openLink(t, url, 'bili-video-open')));

      const metaRows = [];
      if (bvid !== null) metaRows.push(['card.video.bvid', bvid]);
      if (owner !== null) metaRows.push(['card.video.owner', stringOf(owner.name)]);
      metaRows.push(['card.video.published', itemDateText(video)]);
      metaRows.push(['card.video.duration', itemDurationText(video)]);
      const meta = fields(t, metaRows);
      if (meta !== null) body.push(meta);

      if (stat !== null) {
        const statRows = [];
        for (const entry of VIDEO_STAT_ROWS) {
          if (!present(stat[entry[1]])) continue;
          statRows.push({ key: entry[1], labelKey: entry[0], value: countText(stat[entry[1]]) });
        }
        const statChips = chips(t, statRows);
        if (statChips !== null) body.push(statChips);
      }

      const desc = stringOf(video.desc);
      if (desc !== null && desc.trim() !== '') {
        body.push(h('p', { className: 'bili-desc', key: 'bili-video-desc' }, oneLine(desc, 240)));
      }

      const player = playerFrame(bvid, title);
      if (player !== null) {
        body.push(player);
        body.push(h('div', { className: 'bili-note', key: 'bili-player-note' }, t('card.video.playerNote')));
      }

      if (parts.length > 0) {
        body.push(sectionTitle(t, 'card.video.parts'));
        const rows = [];
        for (const part of parts) {
          if (!isRecord(part)) continue;
          rows.push([
            stringOf(part.page) ?? '',
            stringOf(part.part) ?? '',
            itemDurationText(part) ?? '',
          ]);
        }
        const partTable = simpleTable(['card.video.part', 'card.video.partTitle', 'card.video.duration'], rows, t);
        if (partTable !== null) body.push(partTable);
      }

      if (tags.length > 0) {
        const tagRows = [];
        for (const tag of tags) {
          const name = isRecord(tag) ? stringOf(tag.name) : stringOf(tag);
          if (name !== null && name !== '') tagRows.push({ key: name, labelKey: 'card.video.tags', value: name });
        }
        if (tagRows.length > 0) {
          body.push(sectionTitle(t, 'card.video.tags'));
          body.push(h('div', { className: 'bili-tags' }, tagRows.map((row) => h('span', { className: 'bili-tag', key: row.key }, row.value))));
        }
      }

      const summaryBits = [oneLine(title, 60)];
      if (owner !== null && present(owner.name)) summaryBits.push(String(owner.name));
      if (stat !== null && present(stat.view)) summaryBits.push(`${countText(stat.view)} ${t('card.video.view')}`);
      const duration = itemDurationText(video);
      if (duration !== null) summaryBits.push(duration);
      return { summary: summaryBits.filter((entry) => entry !== '').join(' · '), badge: null, tone: 'idle', body };
    }

    const VideoCard = defineCard({
      titleKey: 'card.video.title',
      glyph: 'video',
      build: videoView,
    });

    // ---------------------------------------------------------------- bili_user

    /** UP 主卡片模型。 */
    function userView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const user = isRecord(data.user) ? data.user : null;
      if (user === null) return rawView(t, result);
      const videos = Array.isArray(data.videos) ? data.videos : [];
      const name = stringOf(user.name) ?? t('card.unknown');
      const url = externalUrl(user.url) ?? (present(user.mid) ? `https://space.bilibili.com/${user.mid}` : null);
      const body = [];
      const head = [];
      const face = coverImage(t, user.face, 'bili-avatar', name);
      if (face !== null) head.push(face);
      head.push(h('span', { className: 'bili-user-main', key: 'bili-user-main' },
        titleLink(name, url, 'bili-user-name'),
        produceUserNameMeta(t, user)));
      body.push(h('div', { className: 'bili-user-head', key: 'bili-user-head' }, head));
      const rows = fields(t, [
        ['card.user.mid', stringOf(user.mid)],
        ['card.user.level', present(user.level) ? `LV${numberText(user.level)}` : null],
        ['card.user.fans', present(user.fans) ? countText(user.fans) : null],
        ['card.user.sign', stringOf(user.sign)],
      ]);
      if (rows !== null) body.push(rows);
      body.push(sectionTitle(t, 'card.user.videos'));
      if (videos.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-user-no-videos' }, t('card.user.noVideos')));
      } else {
        body.push(...itemList(videos, { t, max: 6 }));
      }
      const summaryBits = [name];
      if (present(user.fans)) summaryBits.push(`${countText(user.fans)} ${t('card.user.fans')}`);
      if (videos.length > 0) summaryBits.push(`${videos.length} ${t('card.user.videos')}`);
      return { summary: summaryBits.join(' · '), badge: null, tone: 'idle', body };
    }

    /** UP 主的等级/UID 一行小字。 */
    function produceUserNameMeta(t, user) {
      const bits = [];
      if (present(user.mid)) bits.push(`${t('card.user.mid')} ${user.mid}`);
      if (present(user.level)) bits.push(`LV${numberText(user.level)}`);
      if (bits.length === 0) return null;
      return h('span', { className: 'bili-item-meta', key: 'bili-user-meta' }, bits.join(' · '));
    }

    const UserCard = defineCard({
      titleKey: 'card.user.title',
      glyph: 'user',
      build: userView,
    });

    // ---------------------------------------------------------------- bili_ranking / bili_popular

    /** 排行/热门卡片模型（趋势类共用）。 */
    function trendView(state, kind) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const items = Array.isArray(data.items) ? data.items : [];
      const body = [];
      const headerRows = [];
      if (kind === 'ranking') {
        headerRows.push({ key: 'area', labelKey: 'card.trend.area', value: stringOf(data.name) ?? stringOf(data.area) });
      } else {
        const kindText = data.kind === 'weekly' ? t('card.trend.weekly') : t('card.trend.popularTitle');
        headerRows.push({ key: 'kind', labelKey: 'card.trend.kind', value: kindText });
      }
      headerRows.push({ key: 'count', labelKey: 'card.trend.count', value: items.length });
      const header = chips(t, headerRows);
      if (header !== null) body.push(header);
      if (items.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-trend-empty' }, t('card.trend.empty')));
      } else {
        body.push(...itemList(items, { t, max: 10, showRank: true }));
      }
      const headText = kind === 'ranking'
        ? stringOf(data.name) ?? stringOf(data.area) ?? t('card.trend.title')
        : data.kind === 'weekly' ? t('card.trend.weekly') : t('card.trend.popularTitle');
      return {
        summary: `${headText} · ${items.length}`,
        badge: null,
        tone: 'idle',
        body,
      };
    }

    const RankingCard = defineCard({
      titleKey: 'card.trend.title',
      glyph: 'ranking',
      build: (state) => trendView(state, 'ranking'),
    });

    const PopularCard = defineCard({
      titleKey: 'card.trend.popularTitle',
      glyph: 'popular',
      build: (state) => trendView(state, 'popular'),
    });

    // ---------------------------------------------------------------- bili_hotwords

    /** 热搜卡片模型。 */
    function hotwordsView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const items = Array.isArray(data.items) ? data.items : [];
      const body = [];
      const header = chips(t, [{ key: 'count', labelKey: 'card.hotwords.count', value: items.length }]);
      if (header !== null) body.push(header);
      if (items.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-hotwords-empty' }, t('card.hotwords.empty')));
      } else {
        const rows = [];
        const max = Math.min(items.length, 12);
        for (let index = 0; index < max; index += 1) {
          const item = items[index];
          if (!isRecord(item)) continue;
          const keyword = stringOf(item.keyword);
          if (keyword === null || keyword === '') continue;
          const showName = stringOf(item.showName);
          const icon = coverImage(t, item.icon, 'bili-hotword-icon', '');
          const url = `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`;
          rows.push(h('a', {
            className: 'bili-hotword',
            key: `hotword:${keyword}`,
            href: url,
            target: '_blank',
            rel: 'noreferrer noopener',
          },
          h('span', { className: 'bili-hotword-index' }, String(index + 1)),
          icon === null ? null : icon,
          h('span', { className: 'bili-hotword-name' }, showName !== null && showName !== '' ? showName : keyword)));
        }
        if (rows.length > 0) body.push(h('div', { className: 'bili-hotwords' }, rows));
        if (items.length > max) body.push(h('div', { className: 'bili-note' }, t('card.more', { n: items.length - max })));
      }
      return { summary: `${items.length}`, badge: null, tone: 'idle', body };
    }

    const HotwordsCard = defineCard({
      titleKey: 'card.hotwords.title',
      glyph: 'hotwords',
      build: hotwordsView,
    });

    // ---------------------------------------------------------------- bili_comments

    /** 单条评论节点。 */
    function commentNode(t, comment) {
      if (!isRecord(comment)) return null;
      const uname = stringOf(comment.uname) ?? t('card.unknown');
      const message = stringOf(comment.message) ?? '';
      const meta = [];
      if (present(comment.like)) meta.push(`${t('card.comments.like')} ${countText(comment.like)}`);
      if (present(comment.ctimeText)) meta.push(String(comment.ctimeText));
      if (present(comment.replyCount) && Number(comment.replyCount) > 0) meta.push(t('card.comments.replyCount', { n: comment.replyCount }));
      const children = [
        h('span', { className: 'bili-comment-head', key: 'bili-comment-head' },
          h('span', { className: 'bili-comment-user' }, uname),
          meta.length === 0 ? null : h('span', { className: 'bili-comment-meta' }, meta.join(' · '))),
        h('span', { className: 'bili-comment-text', key: 'bili-comment-text' }, oneLine(message, 220)),
      ];
      const replies = Array.isArray(comment.replies) ? comment.replies : [];
      if (replies.length > 0) {
        children.push(h('span', { className: 'bili-replies', key: 'bili-replies' },
          replies.slice(0, 3).map((reply, index) => h('span', {
            className: 'bili-reply',
            key: `reply:${isRecord(reply) ? reply.rpid ?? index : index}`,
          }, `${isRecord(reply) ? stringOf(reply.uname) ?? '' : ''}：${isRecord(reply) ? oneLine(stringOf(reply.message) ?? '', 120) : ''}`))));
      }
      return h('div', { className: 'bili-comment', key: String(comment.rpid ?? uname) }, children);
    }

    /** 评论卡片模型。 */
    function commentsView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const items = Array.isArray(data.items) ? data.items : [];
      const body = [];
      const header = chips(t, [
        { key: 'count', labelKey: 'card.comments.count', value: present(data.count) ? countText(data.count) : null },
        { key: 'page', labelKey: 'card.page', value: present(data.page) ? data.page : 1 },
      ]);
      if (header !== null) body.push(header);
      if (items.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-comments-empty' }, t('card.comments.empty')));
      } else {
        const max = Math.min(items.length, 8);
        const rows = [];
        for (let index = 0; index < max; index += 1) {
          const node = commentNode(t, items[index]);
          if (node !== null) rows.push(node);
        }
        if (rows.length > 0) body.push(h('div', { className: 'bili-comments' }, rows));
        if (items.length > max) body.push(h('div', { className: 'bili-note' }, t('card.more', { n: items.length - max })));
      }
      const countTextValue = present(data.count) ? countText(data.count) : String(items.length);
      return { summary: `${countTextValue}`, badge: null, tone: 'idle', body };
    }

    const CommentsCard = defineCard({
      titleKey: 'card.comments.title',
      glyph: 'comments',
      build: commentsView,
    });

    // ---------------------------------------------------------------- bili_danmaku

    /** 弹幕分布条形图。 */
    function distributionBars(t, distribution) {
      let max = 0;
      for (const row of distribution) {
        const count = isRecord(row) ? Number(row.count) : NaN;
        if (Number.isFinite(count) && count > max) max = count;
      }
      const rows = [];
      const maxRows = Math.min(distribution.length, 12);
      for (let index = 0; index < maxRows; index += 1) {
        const row = distribution[index];
        if (!isRecord(row)) continue;
        const count = Number(row.count);
        const width = max > 0 && Number.isFinite(count) ? Math.max(2, Math.round((count / max) * 100)) : 0;
        rows.push(h('div', { className: 'bili-bar-row', key: `bar:${row.minute}:${index}` },
          h('span', { className: 'bili-bar-label' }, t('card.danmaku.minute', { n: row.minute })),
          h('span', { className: 'bili-bar-track' }, h('span', { className: 'bili-bar-fill', style: { width: `${width}%` } })),
          h('span', { className: 'bili-bar-count' }, countText(row.count))));
      }
      if (rows.length === 0) return null;
      return h('div', { className: 'bili-bars' }, rows);
    }

    /** 弹幕卡片模型。 */
    function danmakuView(state) {
      const { t, phase, result } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const items = Array.isArray(data.items) ? data.items : [];
      const distribution = Array.isArray(data.distribution) ? data.distribution : [];
      const body = [];
      const header = chips(t, [
        { key: 'count', labelKey: 'card.danmaku.count', value: present(data.count) ? countText(data.count) : null },
        { key: 'sampled', labelKey: 'card.danmaku.sampled', value: present(data.sampled) ? countText(data.sampled) : null },
      ]);
      if (header !== null) body.push(header);
      if (distribution.length > 0) {
        body.push(sectionTitle(t, 'card.danmaku.distribution'));
        const bars = distributionBars(t, distribution);
        if (bars !== null) body.push(bars);
      }
      if (items.length === 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-danmaku-empty' }, t('card.danmaku.empty')));
      } else {
        const max = Math.min(items.length, 10);
        const rows = [];
        for (let index = 0; index < max; index += 1) {
          const item = items[index];
          if (!isRecord(item)) continue;
          const seconds = Number(item.timeMs);
          const time = Number.isFinite(seconds) ? clockText(seconds / 1000) : null;
          const text = stringOf(item.text);
          if (text === null || text === '') continue;
          rows.push(h('div', { className: 'bili-danmaku-row', key: `dm:${index}:${time ?? ''}` },
            h('span', { className: 'bili-danmaku-time' }, time === null ? '—' : time),
            h('span', { className: 'bili-danmaku-text' }, oneLine(text, 120))));
        }
        if (rows.length > 0) body.push(h('div', { className: 'bili-danmakus' }, rows));
        if (items.length > max) body.push(h('div', { className: 'bili-note' }, t('card.more', { n: items.length - max })));
      }
      const countTextValue = present(data.count) ? countText(data.count) : String(items.length);
      return { summary: countTextValue, badge: null, tone: 'idle', body };
    }

    const DanmakuCard = defineCard({
      titleKey: 'card.danmaku.title',
      glyph: 'danmaku',
      build: danmakuView,
    });

    // ---------------------------------------------------------------- bili_login

    /** 登录动作：从返回数据推断（结果块不保证带调用参数）。 */
    function loginActionOf(data, args) {
      if (isRecord(data)) {
        if (present(data.qrcodeKey)) return 'start';
        if (present(data.state) || present(data.code)) return 'poll';
        if (data.cleared === true) return 'logout';
      }
      if (isRecord(args) && typeof args.action === 'string') return args.action;
      return 'status';
    }

    /** 扫码状态 → locale key。 */
    function loginStateKey(stateName) {
      const map = {
        waiting: 'card.login.stateWaiting',
        scanned: 'card.login.stateScanned',
        expired: 'card.login.stateExpired',
        ok: 'card.login.stateOk',
      };
      return map[typeof stateName === 'string' ? stateName : ''] ?? 'card.login.stateWaiting';
    }

    /** 登录卡片模型。 */
    function loginView(state) {
      const { t, phase, result, args } = state;
      if (phase !== 'result' || result === null) return pendingView(t, phase);
      if (result.isError) return errorView(t, result);
      const data = result.data;
      if (!isRecord(data)) return rawView(t, result);
      const action = loginActionOf(data, args);
      const body = [];
      let badge = null;
      let tone = 'idle';
      if (action === 'start') {
        badge = t('card.login.stateWaiting');
        tone = 'info';
        const rows = fields(t, [
          ['card.login.expire', present(data.expiresInSec) ? t('card.login.expire', { n: data.expiresInSec }) : null],
          ['card.login.qrcodeKey', stringOf(data.qrcodeKey)],
        ]);
        if (rows !== null) body.push(rows);
        const qrUrl = externalUrl(data.url);
        const link = openLink(t, qrUrl, 'bili-login-url', 'card.video.open');
        if (link !== null) body.push(link);
        body.push(h('div', { className: 'bili-note', key: 'bili-login-qr' }, t('card.login.qrHint')));
        body.push(h('div', { className: 'bili-note', key: 'bili-login-poll' }, t('card.login.pollHint')));
      } else if (action === 'poll') {
        const stateName = stringOf(data.state) ?? 'waiting';
        badge = t(loginStateKey(stateName));
        tone = stateName === 'ok' ? 'success' : stateName === 'expired' ? 'error' : 'info';
        const user = isRecord(data.user) ? data.user : null;
        const rows = fields(t, [
          ['card.login.message', stringOf(data.message)],
          ['card.login.user', user === null ? null : stringOf(user.uname) ?? stringOf(user.name)],
          ['card.login.code', present(data.code) ? String(data.code) : null],
        ]);
        if (rows !== null) body.push(rows);
      } else if (action === 'logout') {
        badge = t('card.login.cleared');
        body.push(h('div', { className: 'bili-note', key: 'bili-login-logout' }, t('card.login.logoutHint')));
      } else {
        const loggedIn = data.loggedIn === true;
        badge = loggedIn ? t('card.login.loggedIn') : t('card.login.loggedOut');
        tone = loggedIn ? 'success' : 'idle';
        const user = isRecord(data.user) ? data.user : null;
        const rows = fields(t, [
          ['card.login.user', user === null ? null : stringOf(user.uname) ?? stringOf(user.name)],
          ['card.login.mid', user === null ? null : stringOf(user.mid)],
        ]);
        if (rows !== null) body.push(rows);
      }
      body.push(h('div', { className: 'bili-note', key: 'bili-login-tutorial' }, t('card.login.tutorial')));
      if (result.imageCount > 0) {
        body.push(h('div', { className: 'bili-note', key: 'bili-login-image' }, t('card.login.qrHint')));
      }
      return { summary: badge, badge, tone, body };
    }

    const LoginCard = defineCard({
      titleKey: 'card.login.title',
      glyph: 'login',
      build: loginView,
    });

    // ---------------------------------------------------------------- 设置页

    /** 配置默认值的展示文本。 */
    function configDefaultText(defaultValue, t) {
      if (defaultValue === '') return t('settings.config.default.empty');
      if (defaultValue === 'true') return t('settings.config.default.on');
      if (defaultValue === 'false') return t('settings.config.default.off');
      return defaultValue;
    }

    /** 状态数据里取字段的安全包装。 */
    function statusField(data, key) {
      return isRecord(data) ? data[key] : undefined;
    }

    /** 设置页 content：登录状态 + 扫码说明 + 配置表 + 限制与版权。 */
    function SettingsSection(props) {
      const t = translator(props);
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: '' });
      const [reloadToken, setReloadToken] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        setState({ phase: 'loading', data: null, error: '' });
        fetchPanel('/status', {}, controller.signal)
          .then((data) => setState({ phase: 'done', data, error: '' }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setState({ phase: 'error', data: null, error: errorText(error) });
          });
        return () => {
          controller.abort();
        };
      }, [reloadToken]);

      const statusNode = (() => {
        if (state.phase === 'loading') {
          return h('div', { className: 'bili-note', key: 'bili-settings-loading' }, t('settings.login.loading'));
        }
        if (state.phase === 'error') {
          return h('div', { className: 'bili-settings-error', key: 'bili-settings-error' },
            h('div', { className: 'bili-error' }, `${t('settings.login.error')}：${state.error}`),
            h('button', {
              type: 'button',
              className: 'bili-button',
              onClick: () => setReloadToken((value) => value + 1),
            }, t('settings.login.retry')));
        }
        const data = isRecord(state.data) ? state.data : {};
        const loggedIn = data.loggedIn === true;
        const ffmpeg = isRecord(data.ffmpeg) ? data.ffmpeg : null;
        const rows = fields(t, [
          ['settings.login.loggedIn', loggedIn ? t('settings.login.loggedIn') : t('settings.login.loggedOut')],
          ['settings.login.user', stringOf(data.uname)],
          ['settings.login.level', present(data.level) ? `LV${numberText(data.level)}` : null],
          ['settings.login.version', stringOf(data.version)],
          ['settings.login.ffmpeg', ffmpeg === null ? null : ffmpeg.available === true
            ? `${t('settings.login.ffmpegReady')}${present(ffmpeg.version) ? ` ${ffmpeg.version}` : ''}`
            : t('settings.login.ffmpegMissing')],
          ['settings.login.downloadDir', stringOf(data.downloadDir)],
        ]);
        return h('div', { className: 'bili-settings-status', key: 'bili-settings-status' },
          rows === null ? null : rows,
          h('div', { className: 'bili-note' }, t('settings.login.refreshHint')));
      })();

      const configRows = CONFIG_ROWS.map((row) => h('tr', { key: row[0] },
        h('td', { className: 'bili-config-key' }, h('code', null, row[0])),
        h('td', { className: 'bili-config-default' }, configDefaultText(row[1], t)),
        h('td', null, t(`settings.config.keys.${row[0]}`))));

      return h('div', { className: 'bili-settings' },
        h('p', { className: 'bili-settings-intro' }, t('settings.intro')),
        h('section', { className: 'bili-settings-block' },
          h('h2', null, t('settings.login.title')),
          statusNode),
        h('section', { className: 'bili-settings-block' },
          h('h2', null, t('settings.scan.title')),
          h('ol', { className: 'bili-steps' },
            h('li', null, t('settings.scan.step1')),
            h('li', null, t('settings.scan.step2')),
            h('li', null, t('settings.scan.step3'))),
          h('p', { className: 'bili-footnote' }, t('settings.scan.note'))),
        h('section', { className: 'bili-settings-block' },
          h('h2', null, t('settings.config.title')),
          h('p', { className: 'bili-footnote' }, t('settings.config.hint')),
          h('div', { className: 'bili-table-wrap bili-config-wrap' },
            h('table', { className: 'bili-table bili-config-table' },
              h('thead', null, h('tr', null,
                h('th', { scope: 'col' }, t('settings.config.col.key')),
                h('th', { scope: 'col' }, t('settings.config.col.default')),
                h('th', { scope: 'col' }, t('settings.config.col.desc')))),
              h('tbody', null, configRows)))),
        h('section', { className: 'bili-settings-block' },
          h('h2', null, t('settings.limits.title')),
          h('ul', { className: 'bili-limits' },
            h('li', null, t('settings.limits.risk')),
            h('li', null, t('settings.limits.auth')),
            h('li', null, t('settings.limits.rate')),
            h('li', null, t('settings.limits.download')),
            h('li', null, t('settings.limits.copyright')),
            h('li', null, t('settings.limits.panel')))),
        h('p', { className: 'bili-footnote' }, t('settings.footer')));
    }

    // ---------------------------------------------------------------- 侧栏按钮

    /** 侧栏底部的面板开关按钮（wide=false 只显示图标）。 */
    function PanelAction(props) {
      const t = translator(props);
      const wide = props.wide === true;
      const open = usePanelOpen();
      return h('button', {
        type: 'button',
        className: wide ? 'bili-footer-action' : 'bili-footer-action bili-footer-action-rail',
        'aria-label': t('panel.title'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: t('panel.title'),
        onClick: () => togglePanel(),
      },
      h('span', { className: 'bili-footer-icon', 'aria-hidden': true }, glyph('video', 16)),
      wide ? h('span', { className: 'bili-footer-label' }, t('panel.title')) : null);
    }

    // ---------------------------------------------------------------- 面板

    /** 查询串：跳过空值。 */
    function queryString(query) {
      const params = new URLSearchParams();
      if (isRecord(query)) {
        for (const key of Object.keys(query)) {
          const value = query[key];
          if (value === null || value === undefined || value === '') continue;
          params.set(key, String(value));
        }
      }
      const text = params.toString();
      return text === '' ? '' : `?${text}`;
    }

    /**
     * 同源面板取数：GET /dsh-bilibili/api/{path}，成功返回 data，失败抛错。
     * @param {string} path - 路由后缀，如 '/hot'。
     * @param {Record<string, unknown>} query - 查询参数。
     * @param {AbortSignal} signal - 取消信号。
     * @returns {Promise<any>} 响应里的 data。
     */
    async function fetchPanel(path, query, signal) {
      const response = await fetch(`${PANEL_ROUTE}${path}${queryString(query)}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (response.ok && isRecord(payload) && payload.ok === true) {
        return payload.data === undefined ? null : payload.data;
      }
      const detail = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      if (detail === null) throw new Error(`HTTP ${response.status}`);
      const code = stringOf(detail.code) ?? `HTTP ${response.status}`;
      const message = stringOf(detail.message) ?? `HTTP ${response.status}`;
      const hint = stringOf(detail.hint) ?? '';
      throw new Error(`${message}（${code}）${hint === '' ? '' : `\n${hint}`}`);
    }

    /** 错误文本（面板/设置页展示用）。 */
    function errorText(error) {
      const text = error instanceof Error ? error.message : String(error);
      const line = firstLine(text);
      return line === null ? text : line;
    }

    /** 焦点陷阱：Tab / Shift+Tab 在对话框内循环。 */
    function trapFocus(root, event) {
      if (root === null || root === undefined || typeof document === 'undefined') return;
      const selector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      let nodes = [];
      try {
        nodes = Array.from(root.querySelectorAll(selector));
      } catch (error) {
        nodes = [];
      }
      const items = nodes.filter((node) => node !== null && node !== undefined);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    /** 面板里的加载态提示。 */
    function panelLoading(t) {
      return h('div', { className: 'bili-panel-loading', key: 'bili-panel-loading' },
        h('span', { className: 'bili-spinner', 'aria-hidden': true }),
        h('span', null, t('panel.loading')));
    }

    /** 面板里的错误态提示（带重试）。 */
    function panelError(t, message, onRetry) {
      return h('div', { className: 'bili-panel-error', key: 'bili-panel-error' },
        h('div', { className: 'bili-error' }, `${t('panel.error')}：${message}`),
        h('button', { type: 'button', className: 'bili-button', onClick: onRetry }, t('panel.retry')));
    }

    /** 面板里的空态提示。 */
    function panelEmpty(t, key, label) {
      return h('div', { className: 'bili-panel-empty', key }, label);
    }

    /** 面板搜索/详情的结果行（点击后进入详情或外部打开）。 */
    function panelResultRow(t, item, onSelect) {
      if (!isRecord(item)) return null;
      const title = stringOf(item.title) ?? t('card.unknown');
      const bits = [];
      if (present(item.author)) bits.push(String(item.author));
      if (present(item.play)) bits.push(`${countText(item.play)} ${t('card.video.view')}`);
      const duration = itemDurationText(item);
      if (duration !== null) bits.push(duration);
      const children = [];
      const cover = coverImage(t, item.cover, 'bili-thumb', '');
      if (cover !== null) children.push(h('span', { className: 'bili-thumb-wrap', key: 'bili-thumb-wrap' }, cover));
      children.push(h('span', { className: 'bili-item-main', key: 'bili-item-main' },
        h('span', { className: 'bili-item-title', title }, title),
        bits.length === 0 ? null : h('span', { className: 'bili-item-meta' }, bits.join(' · '))));
      const bvid = normalizeBvid(stringOf(item.bvid) ?? '');
      if (bvid !== null) {
        return h('button', {
          type: 'button',
          className: 'bili-item bili-item-button',
          key: bvid,
          onClick: () => onSelect(bvid),
        }, children);
      }
      const url = itemWebUrl(item);
      return h('a', {
        className: 'bili-item',
        key: String(item.title ?? 'item'),
        href: url === null ? undefined : url,
        target: url === null ? undefined : '_blank',
        rel: 'noreferrer noopener',
      }, children);
    }

    /** 抽屉面板：tab 热搜 / 搜索 / 详情，数据走同源面板路由。 */
    function PanelDialog(props) {
      const t = props.t;
      const close = () => setPanelOpen(false);
      const [tab, setTab] = React.useState('hot');
      const [status, setStatus] = React.useState({ phase: 'loading', data: null, error: '' });
      const [refreshToken, setRefreshToken] = React.useState(0);
      const [hot, setHot] = React.useState({ phase: 'loading', items: [], error: '' });
      const [query, setQuery] = React.useState('');
      const [submitted, setSubmitted] = React.useState(null);
      const [search, setSearch] = React.useState({ phase: 'idle', data: null, error: '' });
      const [bvidInput, setBvidInput] = React.useState('');
      const [detailTarget, setDetailTarget] = React.useState(null);
      const [detail, setDetail] = React.useState({ phase: 'idle', data: null, error: '' });
      const [detailError, setDetailError] = React.useState('');
      const panelRef = React.useRef(null);
      const closeRef = React.useRef(null);
      const restoreRef = React.useRef(null);

      // 焦点：打开时记住来源并聚焦关闭按钮，关闭后还原；Esc 关闭；Tab 在面板内循环。
      React.useEffect(() => {
        if (typeof document !== 'undefined') restoreRef.current = document.activeElement;
        if (closeRef.current !== null && closeRef.current !== undefined && typeof closeRef.current.focus === 'function') {
          closeRef.current.focus();
        }
        const handleKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setPanelOpen(false);
            return;
          }
          if (event.key === 'Tab') trapFocus(panelRef.current, event);
        };
        if (typeof document !== 'undefined') document.addEventListener('keydown', handleKeyDown, true);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('keydown', handleKeyDown, true);
          const target = restoreRef.current;
          if (target !== null && target !== undefined && typeof target.focus === 'function') {
            try {
              target.focus();
            } catch (error) {
              // 来源元素可能已被卸载，忽略。
            }
          }
        };
      }, []);

      // 登录态：面板打开即读一次，刷新时重读。
      React.useEffect(() => {
        const controller = new AbortController();
        setStatus({ phase: 'loading', data: null, error: '' });
        fetchPanel('/status', {}, controller.signal)
          .then((data) => setStatus({ phase: 'done', data, error: '' }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setStatus({ phase: 'error', data: null, error: errorText(error) });
          });
        return () => {
          controller.abort();
        };
      }, [refreshToken]);

      // 热搜：切到热搜 tab 或刷新时拉取。
      React.useEffect(() => {
        if (tab !== 'hot') return undefined;
        const controller = new AbortController();
        setHot({ phase: 'loading', items: [], error: '' });
        fetchPanel('/hot', { limit: PANEL_LIMIT }, controller.signal)
          .then((data) => {
            const items = isRecord(data) && Array.isArray(data.items) ? data.items : [];
            setHot({ phase: 'done', items, error: '' });
          })
          .catch((error) => {
            if (controller.signal.aborted) return;
            setHot({ phase: 'error', items: [], error: errorText(error) });
          });
        return () => {
          controller.abort();
        };
      }, [tab, refreshToken]);

      // 搜索：提交后拉取。
      React.useEffect(() => {
        if (submitted === null) return undefined;
        const controller = new AbortController();
        setSearch({ phase: 'loading', data: null, error: '' });
        fetchPanel('/search', { keyword: submitted.keyword, type: 'video', page: 1 }, controller.signal)
          .then((data) => setSearch({ phase: 'done', data, error: '' }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setSearch({ phase: 'error', data: null, error: errorText(error) });
          });
        return () => {
          controller.abort();
        };
      }, [submitted]);

      // 详情：选定 BV 号后拉取。
      React.useEffect(() => {
        if (detailTarget === null) return undefined;
        const controller = new AbortController();
        setDetail({ phase: 'loading', data: null, error: '' });
        fetchPanel('/video', { bvid: detailTarget.bvid }, controller.signal)
          .then((data) => setDetail({ phase: 'done', data, error: '' }))
          .catch((error) => {
            if (controller.signal.aborted) return;
            setDetail({ phase: 'error', data: null, error: errorText(error) });
          });
        return () => {
          controller.abort();
        };
      }, [detailTarget]);

      /** 提交搜索词。 */
      const submitSearch = (keyword) => {
        const text = typeof keyword === 'string' ? keyword.trim() : '';
        if (text === '') return;
        setSubmitted({ keyword: text, seq: Date.now() });
        setTab('search');
      };

      /** 从热搜/搜索结果进入详情。 */
      const openDetail = (bvid) => {
        const normalized = normalizeBvid(bvid);
        if (normalized === null) {
          setDetailError(t('panel.detail.invalidBvid'));
          return;
        }
        setDetailError('');
        setBvidInput(normalized);
        setDetailTarget({ bvid: normalized, seq: Date.now() });
        setTab('detail');
      };

      /** 刷新当前面板数据。 */
      const refresh = () => {
        setRefreshToken((value) => value + 1);
        setSubmitted((current) => (current === null ? null : { keyword: current.keyword, seq: Date.now() }));
        setDetailTarget((current) => (current === null ? null : { bvid: current.bvid, seq: Date.now() }));
      };

      const statusNode = (() => {
        if (status.phase === 'loading') {
          return h('span', { className: 'bili-panel-chip', key: 'bili-panel-status' }, t('panel.loading'));
        }
        if (status.phase === 'error') {
          return h('span', { className: 'bili-panel-chip', 'data-tone': 'error', key: 'bili-panel-status' }, t('panel.error'));
        }
        const data = isRecord(status.data) ? status.data : {};
        const loggedIn = data.loggedIn === true;
        const label = loggedIn
          ? `${t('panel.login.loggedIn')}${present(data.uname) ? ` · ${data.uname}` : ''}`
          : t('panel.login.loggedOut');
        return h('span', { className: 'bili-panel-chip', 'data-tone': loggedIn ? 'success' : 'idle', key: 'bili-panel-status' }, label);
      })();

      const tabButton = (id, labelKey) => h('button', {
        type: 'button',
        role: 'tab',
        key: `tab:${id}`,
        className: 'bili-tab',
        'aria-selected': tab === id,
        'data-active': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, t(labelKey));

      const content = (() => {
        if (tab === 'hot') {
          if (hot.phase === 'loading') return panelLoading(t);
          if (hot.phase === 'error') return panelError(t, hot.error, refresh);
          if (hot.items.length === 0) return panelEmpty(t, 'bili-hot-empty', t('panel.hot.empty'));
          const rows = [];
          const max = Math.min(hot.items.length, 20);
          for (let index = 0; index < max; index += 1) {
            const item = hot.items[index];
            if (!isRecord(item)) continue;
            const keyword = stringOf(item.keyword);
            if (keyword === null || keyword === '') continue;
            const showName = stringOf(item.showName);
            rows.push(h('button', {
              type: 'button',
              className: 'bili-hotword bili-hotword-button',
              key: `panel-hot:${keyword}`,
              onClick: () => submitSearch(keyword),
            },
            h('span', { className: 'bili-hotword-index' }, String(index + 1)),
            h('span', { className: 'bili-hotword-name' }, showName !== null && showName !== '' ? showName : keyword)));
          }
          return h('div', { className: 'bili-panel-section', key: 'bili-panel-hot' },
            h('div', { className: 'bili-note' }, t('panel.hot.hint')),
            h('div', { className: 'bili-hotwords' }, rows));
        }
        if (tab === 'search') {
          const form = h('form', {
            className: 'bili-panel-form',
            key: 'bili-panel-search-form',
            onSubmit: (event) => {
              event.preventDefault();
              submitSearch(query);
            },
          },
          h('input', {
            className: 'bili-input',
            type: 'search',
            value: query,
            placeholder: t('panel.search.placeholder'),
            'aria-label': t('panel.search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { type: 'submit', className: 'bili-button' }, t('panel.search.submit')));
          if (submitted === null) {
            return h('div', { className: 'bili-panel-section', key: 'bili-panel-search' }, form);
          }
          if (search.phase === 'loading') return h('div', { className: 'bili-panel-section', key: 'bili-panel-search' }, form, panelLoading(t));
          if (search.phase === 'error') return h('div', { className: 'bili-panel-section', key: 'bili-panel-search' }, form, panelError(t, search.error, refresh));
          const items = isRecord(search.data) && Array.isArray(search.data.items) ? search.data.items : [];
          if (items.length === 0) return h('div', { className: 'bili-panel-section', key: 'bili-panel-search' }, form, panelEmpty(t, 'bili-search-empty', t('panel.search.empty')));
          const rows = [];
          const max = Math.min(items.length, 20);
          for (let index = 0; index < max; index += 1) {
            const node = panelResultRow(t, items[index], openDetail);
            if (node !== null) rows.push(node);
          }
          return h('div', { className: 'bili-panel-section', key: 'bili-panel-search' },
            form,
            h('div', { className: 'bili-items' }, rows),
            isRecord(search.data) && search.data.hasMore === true
              ? h('div', { className: 'bili-note' }, t('card.search.more'))
              : null);
        }
        const form = h('form', {
          className: 'bili-panel-form',
          key: 'bili-panel-detail-form',
          onSubmit: (event) => {
            event.preventDefault();
            openDetail(bvidInput);
          },
        },
        h('input', {
          className: 'bili-input',
          type: 'text',
          value: bvidInput,
          placeholder: t('panel.detail.placeholder'),
          'aria-label': t('panel.detail.placeholder'),
          onChange: (event) => setBvidInput(event.target.value),
        }),
        h('button', { type: 'submit', className: 'bili-button' }, t('panel.detail.submit')));
        const errorNote = detailError === ''
          ? null
          : h('div', { className: 'bili-error' }, detailError);
        if (detailTarget === null) {
          return h('div', { className: 'bili-panel-section', key: 'bili-panel-detail' },
            form, errorNote, panelEmpty(t, 'bili-detail-empty', t('panel.detail.empty')));
        }
        if (detail.phase === 'loading') return h('div', { className: 'bili-panel-section', key: 'bili-panel-detail' }, form, errorNote, panelLoading(t));
        if (detail.phase === 'error') return h('div', { className: 'bili-panel-section', key: 'bili-panel-detail' }, form, errorNote, panelError(t, detail.error, refresh));
        const data = isRecord(detail.data) ? detail.data : {};
        const video = isRecord(data.video) ? data.video : null;
        if (video === null) return h('div', { className: 'bili-panel-section', key: 'bili-panel-detail' }, form, errorNote, panelEmpty(t, 'bili-detail-none', t('panel.detail.empty')));
        const owner = isRecord(video.owner) ? video.owner : null;
        const stat = isRecord(video.stat) ? video.stat : null;
        const bvid = normalizeBvid(stringOf(video.bvid) ?? detailTarget.bvid) ?? detailTarget.bvid;
        const url = videoWebUrl(video);
        const title = stringOf(video.title) ?? t('panel.detail.title');
        const rows = fields(t, [
          ['panel.detail.bvid', bvid],
          ['panel.detail.owner', owner === null ? null : stringOf(owner.name)],
          ['panel.detail.published', itemDateText(video)],
          ['panel.detail.duration', itemDurationText(video)],
          ['panel.detail.views', stat === null || !present(stat.view) ? null : countText(stat.view)],
        ]);
        const cover = coverImage(t, video.cover, 'bili-cover', title);
        const parts = Array.isArray(data.parts) ? data.parts : [];
        const player = playerFrame(bvid, title);
        return h('div', { className: 'bili-panel-section', key: 'bili-panel-detail' },
          form,
          errorNote,
          cover === null ? null : h('div', { className: 'bili-cover-wrap' }, cover),
          h('div', { className: 'bili-video-head' },
            titleLink(title, url, 'bili-video-title'),
            openLink(t, url, 'bili-panel-detail-open', 'panel.detail.play')),
          rows === null ? null : rows,
          player,
          parts.length === 0 ? null : h('div', { className: 'bili-note' }, `${t('panel.detail.parts')} ${parts.length}`));
      })();

      return h('div', { className: 'bili-panel-layer', style: { pointerEvents: 'auto' } },
        h('div', {
          className: 'bili-panel-backdrop',
          'aria-hidden': true,
          onClick: close,
        }),
        h('div', {
          className: 'bili-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('panel.title'),
          ref: panelRef,
          tabIndex: -1,
        },
        h('div', { className: 'bili-panel-header' },
          h('div', { className: 'bili-panel-title-row' },
            h('span', { className: 'bili-panel-title' }, t('panel.title')),
            statusNode),
          h('div', { className: 'bili-panel-actions' },
            h('button', {
              type: 'button',
              className: 'bili-icon-button',
              'aria-label': t('panel.refresh'),
              title: t('panel.refresh'),
              onClick: refresh,
            }, glyph('refresh', 16)),
            h('button', {
              type: 'button',
              className: 'bili-icon-button',
              ref: closeRef,
              'aria-label': t('panel.close'),
              title: t('panel.close'),
              onClick: close,
            }, glyph('close', 16)))),
        h('div', { className: 'bili-tabs', role: 'tablist', 'aria-label': t('panel.title') },
          tabButton('hot', 'panel.tab.hot'),
          tabButton('search', 'panel.tab.search'),
          tabButton('detail', 'panel.tab.detail')),
        h('div', { className: 'bili-panel-body', role: 'tabpanel' }, content),
        h('div', { className: 'bili-panel-footer' },
          h('div', { className: 'bili-note' }, t('panel.login.hint')),
          h('div', { className: 'bili-note' }, t('panel.footer.copyright')))));
    }

    /** shell.overlay 入口：面板关闭时不渲染任何东西。 */
    function PanelOverlay(props) {
      const t = translator(props);
      const open = usePanelOpen();
      if (!open) return null;
      return h(PanelDialog, { t });
    }

    // ---------------------------------------------------------------- 样式

    /** 卡片、设置页与面板样式。只用宿主主题 token，深浅色自动跟随。 */
    const CSS = `
.bili-root { display: flex; flex-direction: column; border-radius: var(--dsw-radius-sm, 8px); min-width: 0; }
.bili-row { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 0 2px; border-radius: var(--dsw-radius-sm, 8px); color: var(--dsw-alias-label-primary); }
.bili-row[role='button'] { cursor: pointer; }
.bili-row[role='button']:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l1)); }
.bili-row:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.bili-leading { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.bili-title { flex: none; white-space: nowrap; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); font-weight: 400; }
.bili-sep { flex: none; width: 2px; height: 2px; border-radius: 1px; margin: 0 8px; background: var(--dsw-alias-label-caption); }
.bili-summary { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: var(--dsw-alias-label-secondary); }
.bili-badge { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; white-space: nowrap; color: var(--dsw-alias-label-caption); }
.bili-badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.bili-badge[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.bili-badge[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.bili-badge[data-tone='warning'] { color: var(--dsw-alias-state-warn-primary); }
.bili-badge[data-tone='info'] { color: var(--dsw-alias-state-business-primary); }
.bili-body { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 4px 4px; padding: 10px 14px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-fill-l1)); color: var(--dsw-alias-label-secondary); font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.bili-section-title { color: var(--dsw-alias-label-caption); font-size: 12px; }
.bili-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.bili-chip { display: inline-flex; align-items: baseline; gap: 4px; padding: 1px 8px; border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-fill-l1); font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bili-chip b { color: var(--dsw-alias-label-primary); font-weight: 500; font-variant-numeric: tabular-nums; }
.bili-table-wrap { max-width: 100%; overflow-x: auto; }
.bili-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.bili-table th { padding: 4px 8px; text-align: left; white-space: nowrap; font-weight: 400; color: var(--dsw-alias-label-caption); border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.bili-table td { padding: 4px 8px; color: var(--dsw-alias-label-secondary); border-bottom: 0.5px solid var(--dsw-alias-border-l2); overflow-wrap: anywhere; }
.bili-table tr:last-child td { border-bottom: none; }
.bili-dl { display: grid; grid-template-columns: 6.5em minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.bili-dl dt { color: var(--dsw-alias-label-caption); }
.bili-dl dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.bili-note { color: var(--dsw-alias-label-caption); font-size: 12px; overflow-wrap: anywhere; }
.bili-pre { margin: 0; max-height: 260px; overflow: auto; padding: 0; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); }
.bili-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; overflow-wrap: anywhere; }
.bili-link { color: var(--dsw-alias-state-business-primary); text-decoration: none; font-size: 12px; }
.bili-link:hover { text-decoration: underline; }
.bili-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 26px; padding: 2px 12px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.bili-button:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l2)); }
.bili-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.bili-items { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.bili-item { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 6px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary); text-decoration: none; font: inherit; text-align: left; }
a.bili-item:hover, .bili-item-button:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l1)); }
.bili-item-button { cursor: pointer; }
.bili-item:focus-visible, .bili-hotword-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.bili-item-icon { flex: none; display: inline-flex; color: var(--dsw-alias-label-caption); }
.bili-item-rank { flex: none; width: 18px; text-align: right; color: var(--dsw-alias-label-caption); font-size: 12px; font-variant-numeric: tabular-nums; }
.bili-thumb-wrap { flex: none; display: inline-flex; }
.bili-thumb { width: 64px; height: 40px; border-radius: var(--dsw-radius-xs, 4px); object-fit: cover; background: var(--dsw-alias-fill-l1); }
.bili-item-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.bili-item-title { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.bili-item-meta { font-size: 12px; color: var(--dsw-alias-label-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bili-cover-wrap { min-width: 0; max-width: 100%; }
.bili-cover { display: block; width: 100%; max-width: 360px; max-height: 220px; object-fit: cover; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-fill-l1); }
.bili-video-head { display: flex; align-items: baseline; gap: 12px; min-width: 0; flex-wrap: wrap; }
.bili-video-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
.bili-video-title:hover { text-decoration: underline; }
.bili-desc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.bili-player { position: relative; width: 100%; max-width: 560px; aspect-ratio: 16 / 9; border-radius: var(--dsw-radius-md, 12px); overflow: hidden; background: var(--dsw-alias-fill-l1); }
.bili-player iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.bili-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.bili-tag { padding: 1px 8px; border-radius: 999px; background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-secondary); font-size: 12px; overflow-wrap: anywhere; }
.bili-user-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.bili-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: var(--dsw-alias-fill-l1); }
.bili-user-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bili-user-name { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
.bili-user-name:hover { text-decoration: underline; }
.bili-hotwords { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bili-hotword { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 3px 6px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary); text-decoration: none; font: inherit; text-align: left; }
a.bili-hotword:hover, .bili-hotword-button:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l1)); }
.bili-hotword-button { cursor: pointer; }
.bili-hotword-index { flex: none; width: 18px; text-align: right; color: var(--dsw-alias-label-caption); font-size: 12px; font-variant-numeric: tabular-nums; }
.bili-hotword-icon { width: 16px; height: 16px; border-radius: 3px; object-fit: cover; }
.bili-hotword-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bili-comments { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.bili-comment { display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-fill-l1); min-width: 0; }
.bili-comment-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.bili-comment-user { color: var(--dsw-alias-label-primary); font-size: 12px; }
.bili-comment-meta { color: var(--dsw-alias-label-caption); font-size: 12px; }
.bili-comment-text { color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bili-replies { display: flex; flex-direction: column; gap: 1px; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l1); }
.bili-reply { color: var(--dsw-alias-label-caption); font-size: 12px; overflow-wrap: anywhere; }
.bili-bars { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bili-bar-row { display: grid; grid-template-columns: 7em minmax(0, 1fr) 3.5em; gap: 8px; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bili-bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bili-bar-track { display: block; height: 8px; border-radius: 4px; background: var(--dsw-alias-fill-l1); overflow: hidden; }
.bili-bar-fill { display: block; height: 100%; border-radius: 4px; background: var(--dsw-alias-state-business-primary); opacity: 0.75; }
.bili-bar-count { text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-caption); }
.bili-danmakus { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bili-danmaku-row { display: flex; gap: 8px; min-width: 0; font-size: 12px; }
.bili-danmaku-time { flex: none; width: 4em; text-align: right; color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.bili-danmaku-text { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.bili-footer-action { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; text-align: left; box-sizing: border-box; }
.bili-footer-action:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l1)); color: var(--dsw-alias-label-primary); }
.bili-footer-action:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.bili-footer-action-rail { width: 36px; height: 36px; min-height: 36px; justify-content: center; padding: 0; }
.bili-footer-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px; color: inherit; }
.bili-footer-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bili-settings { display: flex; flex-direction: column; gap: 18px; max-width: 720px; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); min-width: 0; }
.bili-settings-intro { margin: 0; color: var(--dsw-alias-label-secondary); }
.bili-settings-block h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.bili-settings-status { display: flex; flex-direction: column; gap: 6px; }
.bili-settings-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.bili-steps { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; padding: 0; list-style: none; }
.bili-steps li { color: var(--dsw-alias-label-secondary); }
.bili-limits { display: flex; flex-direction: column; gap: 6px; margin: 0; padding-inline-start: 18px; }
.bili-limits li { color: var(--dsw-alias-label-secondary); }
.bili-footnote { margin: 0; color: var(--dsw-alias-label-caption); font-size: 12px; }
.bili-config-wrap { margin-top: 8px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 12px); }
.bili-config-table th { background: var(--dsw-alias-fill-l1); }
.bili-config-key code { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.bili-config-default { white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.bili-panel-layer { position: absolute; inset: 0; z-index: 30; display: flex; justify-content: flex-end; pointer-events: auto; min-width: 0; }
.bili-panel-backdrop { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24)); }
.bili-panel { position: relative; display: flex; flex-direction: column; width: min(420px, 100vw); max-width: 100%; height: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, var(--dsw-specific-menu, var(--dsw-alias-fill-l1))); border-left: 0.5px solid var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-panel, var(--dsw-shadow-lv2)); color: var(--dsw-alias-label-primary); font-size: 13px; overflow: hidden; }
.bili-panel > * { box-sizing: border-box; }
.bili-panel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 6px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.bili-panel-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.bili-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.bili-panel-chip { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; min-height: 18px; border-radius: 999px; background: var(--dsw-alias-fill-l1); color: var(--dsw-alias-label-caption); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; }
.bili-panel-chip[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.bili-panel-chip[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.bili-panel-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.bili-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.bili-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-fill-l1)); color: var(--dsw-alias-label-primary); }
.bili-icon-button:focus-visible, .bili-tab:focus-visible, .bili-input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.bili-tabs { display: flex; gap: 2px; padding: 6px 12px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1); flex: none; }
.bili-tab { padding: 4px 10px 6px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.bili-tab[data-active='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary); }
.bili-panel-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 10px 12px 14px; }
.bili-panel-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bili-panel-form { display: flex; gap: 6px; min-width: 0; }
.bili-input { flex: 1 1 auto; min-width: 0; min-height: 28px; padding: 3px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-specific-input-major, var(--dsw-alias-fill-l1)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; box-sizing: border-box; }
.bili-input::placeholder { color: var(--dsw-alias-label-caption); }
.bili-panel-loading { display: flex; align-items: center; gap: 8px; padding: 16px 4px; color: var(--dsw-alias-label-caption); font-size: 12px; }
.bili-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-state-business-primary); border-radius: 50%; animation: bili-spin 0.9s linear infinite; }
@keyframes bili-spin { to { transform: rotate(360deg); } }
.bili-panel-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 4px; }
.bili-panel-empty { padding: 20px 4px; color: var(--dsw-alias-label-caption); font-size: 12px; text-align: center; overflow-wrap: anywhere; }
.bili-panel-footer { flex: none; display: flex; flex-direction: column; gap: 3px; padding: 8px 12px 10px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
@media (prefers-reduced-motion: reduce) { .bili-spinner { animation: none; } }
@media (max-width: 560px) {
  .bili-settings { max-width: 100%; }
  .bili-config-table td, .bili-config-table th { padding: 4px 6px; }
  .bili-config-table td:last-child { min-width: 200px; }
  .bili-panel { width: 100vw; }
  .bili-cover { max-width: 100%; }
}
`;

    /** 把样式挂到 document.head，返回卸载函数（由 ctx.effect 持有）。 */
    function insertStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) {
        return () => {};
      }
      const element = document.createElement('style');
      element.setAttribute('data-dsh-bilibili', 'bili-styles');
      element.textContent = CSS;
      document.head.appendChild(element);
      return () => {
        if (element.parentNode !== null) element.parentNode.removeChild(element);
      };
    }

    // ---------------------------------------------------------------- 插件装配

    /** 工具名 → 卡片组件。 */
    function cardFor(tool) {
      if (tool === 'bili_status') return StatusCard;
      if (tool === 'bili_search') return SearchCard;
      if (tool === 'bili_video') return VideoCard;
      if (tool === 'bili_user') return UserCard;
      if (tool === 'bili_ranking') return RankingCard;
      if (tool === 'bili_popular') return PopularCard;
      if (tool === 'bili_hotwords') return HotwordsCard;
      if (tool === 'bili_comments') return CommentsCard;
      if (tool === 'bili_danmaku') return DanmakuCard;
      return LoginCard;
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * 注册 10 个工具卡片、1 个设置页、1 个侧栏按钮与 1 个抽屉浮层；样式、词典都走 ctx.effect 以便卸载时清理。
       * @param {object} ctx - 客户端 Cordis 上下文。
       */
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
          } catch (error) {
            // 重复注册（例如 HMR 后旧 fiber 尚未卸载完）不应让整个插件激活失败。
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('[bilibili] locale 词典注册失败，沿用已注册词典：', error);
            }
            return () => {};
          }
        }, 'bilibili: locale dictionaries');

        ctx.effect(insertStyles, 'bilibili: card styles');

        // 模块卸载时收起面板，避免下次挂载残留打开状态。
        ctx.effect(() => () => setPanelOpen(false), 'bilibili: close panel on unload');

        const t = ctx.locale.bind(NS);

        for (const tool of CARD_TOOLS) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key: tool,
            locale: NS,
          }, cardFor(tool)));
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'bilibili',
          order: 60,
          locale: NS,
          // 导航标签由宿主按渲染时机解析 thunk，语言切换不需要重注册。
          label: () => t('settings.label'),
        }, SettingsSection));

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'bilibili-panel',
          order: 60,
          locale: NS,
          label: () => t('panel.title'),
        }, PanelAction));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'bilibili-panel.overlay',
          order: 60,
          locale: NS,
        }, PanelOverlay));
      },
    };
  },
});
