# 锦章一期设计：总体架构与 core

状态：已评审，2026-09-10 定稿（issue #4 快照 1 至 4）；渲染路径已随网页版实现并于 2026-09-18 上线，2026-09-30 按已实现的代码（main `4d312c0`）同步；同日投递适配器、配置目录读写与 Obsidian 插件实现合入（issue #12）。未实现部分仍为设计，见第 1 节末的实现状态。2026-09-08 起草。上游：[需求文档](../../requirements/product-v1/requirements.md)；过程记录在 [issue #4](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/4)，同类项目源码调研结论摘要见该 issue。三个壳各有一份设计：[网页版](web.md)、[skill](skill.md)、[Obsidian 插件](obsidian-plugin.md)。本文回答「系统怎么做到」：架构、技术选型、渲染管线、数据模型、投递适配器、配置与状态、错误模型，以及与需求的映射。

## 1. 结论

沿用技术基线「一个 core 三个壳」，落到具体选型：

| 项目 | 选型 | 一句话理由 |
|---|---|---|
| 语言与运行时 | TypeScript；Node 22 以上（24 为首测基线，20 已于 2026-04 结束维护）；pnpm workspaces 单仓 | 三个壳都是 JS 环境；同类项目与 agent 最熟的栈 |
| core 的运行环境 | 不依赖 DOM、不依赖 Node API，浏览器、Node、Electron 渲染进程三处同一份构建 | 「同一原文同一配置三端渲染一致」由构造保证，不靠三套 DOM 对齐 |
| Markdown 解析 | unified：remark-parse、remark-gfm、remark-directive、remark-rehype | 得到真正的语法树，平台方言与主题内联都是树变换；生态成熟 |
| 中间表示 | hast（HTML 语法树），最后用 hast-util-to-html 序列化 | 平台方言在树上改，序列化一次；无 DOM 也能跑 |
| 主题与内联 | 主题是作用域 CSS 文件；css-tree 解析规则，hast-util-select 匹配，按优先级合并成 `style` 属性；伪元素转真实节点 | 借 wenyan-core 的思路，去掉它对真实 DOM 的依赖和「含冒号选择器直接跳过」的缺陷；不用 juice（doocs 做了三级降级仍崩溃） |
| 代码高亮 | lowlight（highlight.js 的 hast 版），配色随主题内联 | 直接产出 hast |
| 公众号方言规则 | 自研，规则并集来自 my-toolbox `wechatCompat`、wenyan `wechatPostRender`、doocs 复制前处理 | 都是踩坑结晶，许可证允许 |
| 知乎方言规则 | 自研，标签与属性照 Zhihu on Obsidian、zhihu-cli、Wechatsync 生成端 | 没有现成 Node 实现 |
| 图片处理 | core 定义 `ImageCodec` 接口；命令行用 sharp，放在命令行包里；浏览器与 Obsidian 用 Canvas | sharp 是原生模块，进不了插件与网页 |
| 公众号投递 | 自研，蓝本是 my-toolbox `wechatDraftPublisher`（幂等、40007 恢复、结果不确定处理、回读校验），补稳定版 token 落盘缓存与代理 | 同类项目在幂等与错误处理上都更弱 |
| 知乎投递 | 自研，接口序列照 Zhihu on Obsidian（只建草稿与更新，不发布） | 一年可用的网页端接口路线 |
| 配置与状态 | 用户目录 `~/.config/jinzhang/`，JSON 文件，凭证 0600 | skill 与插件共用一份；复制目录即迁移 |
| 网页版框架 | Next.js（App Router，服务端模式），服务端只有图片中转的两个接口（签直传、完成校验并发放预签名读取地址）与运维用的健康检查 | 知乎复制路径的图片必须先上传对象存储，签名要在服务端做；后续服务端能力在同一代码库里加，不用迁移 |

否决：整包依赖 `@wenyan-md/core`（ESM-only、依赖锁版、无浏览器入口、单人维护、伪类选择器被静默跳过，见 issue #4 调研摘要）；基于 DOM 的管线（Node 侧要 jsdom，三端 DOM 行为有差异）；juice 内联；把渲染放在 Obsidian 自带的 MarkdownRenderer（与「一个 core」冲突，CLI 无法复用）。

实现状态（2026-09-30，Obsidian 插件合入后）：

| 部分 | 状态 | 位置 |
|---|---|---|
| 渲染管线（`prepare`、`render`、`placeImages`）、两平台方言、三套主题、固定内容模板与变量、`:::divider`、`:::recent` | 已实现，随网页版上线 | `packages/core/src/index.ts`、`theme.ts`、`themes/` |
| 预览壳 `./preview` | 已实现 | `packages/core/src/preview.ts` |
| 浏览器宿主 `./browser`：IndexedDB 资源解析、Canvas 编解码 | 已实现 | `packages/core/src/browser.ts` |
| 网页版 | 已实现，2026-09-18 上线 | `apps/web`，见 [web.md](web.md) |
| 投递适配器 `./publish`：错误模型、体检、公众号与知乎（第 8、10、11 节） | 已实现，随插件合入；与本文的出入记在 issue #12 的批次快照，本文未回改 | `packages/core/src/publish/` |
| 共享文件读写 `./node`：配置、凭证、状态、模板、写锁（第 9 节） | 已实现，随插件合入 | `packages/core/src/node.ts`、`local.ts` |
| `./browser` 里网页与插件共用的 data URL 归位（第 5 节） | 已实现，网页 `CopyImageStore` 的公众号分支已改为调用它 | `packages/core/src/browser.ts` 的 `DataUrlImageStore` |
| Obsidian 插件 | 已实现，2026-09-30 合入；真实账号验收与首个 BRAT 发布待做 | `apps/obsidian`，见 [obsidian-plugin.md](obsidian-plugin.md) |
| `:::card` 名片、`:::recent` 按平台的样式（第 6 节） | 未实现，等固定内容的调整结论 | 无 |
| 命令行、skill | 未实现，复用 `./publish` 与 `./node` | 无 |

其余各节按已实现的代码写实际接口；未实现的部分保持设计，在对应小节标出。

## 2. 仓库结构

```
jinzhang-md-publisher/
├── packages/
│   ├── core/            # @jinzhang/core：解析、方言、主题、固定内容、图片归位、投递适配器、配置目录读写
│   └── cli/             # （未建）jinzhang 命令行（bin: jinzhang），skill 的底座
├── apps/
│   ├── web/             # 门户 + 在线排版（Next.js，已上线）
│   └── obsidian/        # Obsidian 插件（esbuild）
├── skills/
│   └── jinzhang/        # （未建）SKILL.md 与 references/，通过 skills CLI 安装
├── fixtures/            # article.md（快照基线）、acceptance.md（真实平台验收稿）与测试图片
├── scripts/             # 主题生成、浏览器依赖边界、core 双格式一致性检查
├── deploy/、Dockerfile  # 网页版生产部署，见 docs/deployment.md
├── prototypes/web-v1/   # 网页版首版视觉提案
└── docs/                # 常青文档与阶段结论
```

- core 用 tsup 产出 ESM 与 CJS 两种格式，附类型声明。已有入口：`.`（渲染，纯函数）、`./preview`（预览壳：把 `RenderResult` 包成公众号或知乎的预览页面 HTML，三个壳共用）、`./browser`（Canvas 编解码、IndexedDB 资源解析等浏览器宿主实现）；随插件加入了 `./publish`（投递适配器，只经注入的宿主联网与读写，不直接调用 Node API）与 `./node`（配置、凭证、状态、模板与写锁的文件读写，只依赖 Node 内置模块，命令行与插件共用，构建时把 Node 内置模块标为外部）。sharp 编解码与带代理的传输不进 core，由各壳的宿主实现提供：命令行包用 sharp 与 undici，插件用 `CanvasImageCodec`、`requestUrl` 与 Node `https` 代理 agent（第 3 节宿主表）；插件打包不能带原生模块
- core 构建把依赖全部打进产物（`noExternal`），按浏览器平台与 `worker` 条件解析依赖，选用不依赖 DOM 的实现；包标记为 `private`，不发布到 npm，壳经 pnpm workspace 引用。发布命令行时再决定是否对外发布
- 主题源文件是 CSS，`pnpm themes` 把它们生成到 `themes/generated.ts` 供运行时读取；`pnpm build` 先跑这一步
- 测试统一用 Vitest；core 的快照以三套主题的任务列表与代码样例、以及 `fixtures/article.md` 在两平台与三主题下的输出为回归基线；`scripts/check-core-build.mjs` 核对 ESM 与 CJS 两份产物对标准文章的输出一致。这些都在 `pnpm check` 里，CI 每次推送执行
- 版本：core 与三个壳各自独立的版本号；一期不引入 changesets

## 3. core 的边界与宿主接口

core 不直接碰网络、文件、图片编解码和持久化，全部由壳注入。这是三端共用一份 core 的前提。

渲染路径不需要宿主对象，这一点在网页版实现后确认：`prepare` 只接收一个 `AssetResolver`，日期、作者等模板变量由 `config` 传入；图片规范化发生在壳构造的 `ImageStore` 里，壳给它一个 `ImageCodec`。原设计的 `RenderHost` 因此不再需要。投递路径才需要网络、凭证和状态，由 `PublishHost` 注入，网页版不实现它。

```ts
interface AssetResolver {        // 把图片引用变成可读的字节来源；可以是异步的
  resolve(ref: string): Promise<ResolvedAsset>;
}
type ResolvedAsset =             // 已实现
  | { kind: 'remote' | 'hosted'; url: string }
  | { kind: 'blob' | 'data'; bytes: Uint8Array; mime: string; assetId?: string }
  | { kind: 'missing'; reason: string };

interface PublishHost {          // 只有命令行与插件实现；插件已实现
  http: HttpClient;              // fetch 风格；要能发 multipart、自定义头（含 Cookie）、走代理
  codec: ImageCodec;             // 第 5 节
  readFile(absPath: string): Promise<Uint8Array>;
  store: StateStore;             // 读写 state.json（原子替换、跨进程写锁）
  secrets: SecretStore;          // 读写 credentials.json、wechat-token.json、zhihu-session.json
  now(): Date;
}
```

- 本地形态的解析器直接读出字节，返回 `blob` 类，`assetId` 填文件路径（插件用 `vault.readBinary`，命令行用 `fs`）。原设计里只给路径的 `local` 类没有落地，不再保留
- 解析与平台无关，`hosted` 只表示「已是公网地址」。能否直通不上传（公众号 `mmbiz.qpic.cn`、知乎 `*.zhimg.com`）由各平台的 `ImageStore` 按地址判断
- `jz-local://` 是 core 清理时放行的内部协议：网页版用 `jz-local://<assetId>` 指 IndexedDB 里的图片，插件用 `jz-local://vault/…` 与 `jz-local://file/…` 指 vault 内与磁盘上的文件。`file://` 与 Windows 盘符路径会被当成未放行的协议清掉，本地形态要先改写成这种形式

宿主实现一览：

| 接口 | 命令行（未实现） | Obsidian 插件（已实现） | 网页版（已实现） |
|---|---|---|---|
| `http` | Node 内置 fetch（undici）；代理用 undici 的 `ProxyAgent`（http、https）与 `fetch-socks`（socks5）显式接入，不依赖 `NODE_USE_ENV_PROXY` 这类运行时开关，让优先级与出口可预测；可带 `Cookie` 等任意头 | 默认 Obsidian `requestUrl`（走主进程，无 CORS 限制，可带任意头；multipart 手工拼装）；配置了公众号代理时公众号请求改走 Node `https` 加代理 agent，因为 `requestUrl` 没有代理参数；它也没有超时参数，宿主自包一层超时，创建草稿超时按结果不确定处理 | 不实现 `PublishHost`；浏览器 fetch 只在网页自己的 `ImageStore` 里用于签名、直传与远程图片 |
| `readFile` | `node:fs` | `vault.readBinary`；vault 外的路径用 `node:fs`（桌面端可用） | 无 |
| `codec` | sharp，放在命令行包里 | 直接复用 `./browser` 的 `CanvasImageCodec`（Electron 渲染进程有 Canvas 与 `createImageBitmap`） | `./browser` 的 `CanvasImageCodec` |
| `store` / `secrets` | `./node` 的文件实现，目录 `~/.config/jinzhang/` | 同一份 `./node` 实现，Node 内置模块由 Obsidian 桌面端提供 | 无；文档与设置存 `localStorage` |
| `AssetResolver` | 相对源文件目录解析路径 | 按引用形式分支：嵌入图预处理成 `jz-local://vault/…`，`file://` 与盘符路径预处理成 `jz-local://file/…`，其余相对引用交给 `getFirstLinkpathDest`，找不到再按笔记所在目录解析磁盘路径（[obsidian-plugin.md](obsidian-plugin.md) 第 3、4 节） | `./browser` 的 `BrowserAssetResolver`（IndexedDB `jinzhang-assets`） |

依赖边界：core 的根入口只导出渲染与预览需要的东西，不重新导出 `./node`、`./publish` 里的实现；网页版只依赖 `.`、`./preview`、`./browser`。`pnpm check` 里的 `scripts/check-browser-boundary.mjs` 把 core 产物与网页的剪贴板模块按浏览器打包，出现 Node 内置模块、sharp、ali-oss 或投递代码即失败，并扫描 Next 客户端产物里没有服务端密钥的变量名；CI 每次推送执行。插件的构建产物同样检查不含 sharp 与 ali-oss。

## 4. 渲染管线

渲染分两步：`prepare` 是异步编排，负责解析、清理和资源解析；`render` 是同步纯函数，负责方言、主题与序列化。这样资源解析可以走 IndexedDB 这类异步来源，树变换又能独立测试、可缓存。

```ts
prepare(input: ArticleInput, opts: PrepareOptions): Promise<PreparedArticle>
render(prepared: PreparedArticle, opts?: { theme?: ThemeId; sourceLocations?: boolean }): RenderResult
placeImages(result: RenderResult, store: ImageStore): Promise<{ html: string; bytes: number; text: string }>

interface ArticleInput { markdown: string; title: string; templates?: { header?: string; footer?: string } }
interface PrepareOptions {
  platform: 'wechat' | 'zhihu';
  fixed: { header: boolean; footer: boolean };
  cover?: string;                      // 单独设置的封面引用；不给则取正文首图
  resolver: AssetResolver;
  config?: Record<string, string>;     // 模板变量，如 date、author；title 取自 input
  version?: string;                    // 壳的任务版本，原样带回，壳用它丢弃过期结果
}
interface PreparedArticle {
  platform; title; tree: HastRoot;     // 已清理、已拼固定内容、图片已占位
  images: ImageRef[]; cover: ImageRef | null;
  warnings: Warning[]; version: string;
}

interface RenderResult {
  platform: 'wechat' | 'zhihu';
  title: string;
  version: string;
  html: string;                 // 图片 src 为 jz-img:<id> 占位，等待归位
  text: string;                 // 成品可见文本，供剪贴板 text/plain
  images: ImageRef[];
  cover: ImageRef | null;
  warnings: Warning[];
  degraded: Warning[];          // 知乎侧被降级或丢弃的内容，供预览标注
  placeholders: Warning[];      // 平台组件占位（名片等），实现 :::card 后才会产生
  stats: { visibleTextChars: number; htmlChars: number; imageCount: number };
}

interface Warning { code: string; message: string; ref?: string }
```

根入口另外导出：`extractMarkdownTitle(markdown)`（取正文顶层一级标题的可见文本，忽略代码、引用与 frontmatter）、`replaceImageReference(markdown, original, replacement)`（按语法节点精确改写某一处图片引用，用于补图）、`template(source, values)`（第 6 节的变量替换）、`escapeHtml`、主题列表 `themes`、`NORMALIZE_PROFILES`、`HTML_LIMIT`（20000）与 `HTML_WARNING`（18000）。

`sourceLocations: true` 给段落、标题、代码块、表格、列表项、引用与图片加 `data-source-line`（原文行号），只供预览做同步滚动与点击定位，复制与推送不开。

三种长度口径分开：`visibleTextChars` 是读者看到的字数；`htmlChars` 是图片仍为 `jz-img:<n>` 占位时的 HTML 字符数，`CONTENT_NEAR_LIMIT` 按它判断；公众号 2 万字符约束的是替换成接口地址后的长度，体检要在 `htmlChars` 上按图片数加地址预算（沿用 my-toolbox 每张 512 字符）来预估，归位后再按实际长度复检（第 11 节）；剪贴板载荷的字节数由 `placeImages` 返回的 `bytes` 给出，data URL 内嵌会把它撑大，不套 2 万阈值。

一期定义的警告码：core 产生 `FRONTMATTER_IGNORED`、`UNSUPPORTED_SYNTAX`（编辑器私有写法、未知样式块按文本处理）、`HTML_STRIPPED`（原始 HTML 里被清理掉的标签或属性）、`TITLE_TOO_LONG`（超 32 字）、`IMAGE_MISSING`（引用无法解析，`ref` 为原始引用）、`CONTENT_NEAR_LIMIT`（`htmlChars` 超过 18000），以及放在 `degraded` 里的 `ZHIHU_DEGRADED`（每一处降级一条）；`ImageStore` 实现产生 `GIF_FIRST_FRAME` 与 `IMAGE_REMOTE_KEPT`（远程图片保留原地址）；投递适配器产生 `CARD_FILTERED`（回读发现名片被过滤；`:::card` 实现后才会出现）。

阶段与规则来源。1 到 6 属于 `prepare`，7 到 10 属于 `render`：

| 阶段 | 做什么 | 规则来源 |
|---|---|---|
| 1 规范化 | 去掉开头的 YAML frontmatter 并警告，只在内容能解析为映射（或全是注释）时才去掉，分隔线之间的正文与损坏的 YAML 保留；标题由壳传入（本地形态取文件名，网页取标题框），正文首个 H1 与标题相同（去首尾空白后）则删除；识别 `[[双链]]`、`![[嵌入]]`、`> [!note]` 这类编辑器私有写法，按普通文本处理并警告 | 需求 6.1、6.2；my-toolbox `articleDocument`；2026-09-11 评审第 5 项 |
| 2 解析 | 正文与启用的开头、结尾模板各自用 remark-parse + gfm（表格、任务列表、删除线、脚注、自动链接）+ directive（内置样式块）解析；模板先做变量替换，缺变量的行整行删除。解析时另做四件事：按源位置记下每张图片的原始引用（含引用式定义），归位与补图都用它，不用解析后被百分号编码的地址；中文之间的软换行直接拼接，不留空格；裸网址末尾的中文句读不算进链接；样式块只认 `:::divider` 与 `:::recent`，其余按原文输出并警告。脚注标题为「注释」 | 需求功能 1；第 6 节；2026-09-11 评审第 4 项 |
| 3 转 hast 并还原原始 HTML | remark-rehype 带 `allowDangerousHtml`，再用 `rehype-raw` 把原始 HTML 解析成普通节点，后续阶段才能处理其中的 `<img>` 与内层标签 | Codex 评审 A1 |
| 4 允许列表清理 | 先过滤 `style` 属性：只留颜色、字号字重字形、行高、对齐、文字装饰、字距、内外边距、边框与圆角、宽高、换行这些 CSS 属性，值里出现 `url(`、`expression`、`javascript`、`var(`、`@`、反斜杠或尖括号的整条丢弃。再用 rehype-sanitize 的默认规则，额外允许图片的 `src`、`alt`、`title`，代码的 `language-*` 类，任意元素的 `title` 与 `style`；`src` 只允许 http、https、data、`jz-local` 协议。事件属性、`script`、`iframe`、`javascript:` 一律删除；清理前后不同则记 `HTML_STRIPPED`，脚注 id 前缀这类正常变化不算。受控组件（名片 `mp-common-profile` 及其外层 `section`）按字段白名单保留，随 `:::card` 实现 | Codex 评审 A1 |
| 5 固定内容拼装 | 开头树、正文树、结尾树拼成一棵，开头与结尾分别包进 `section.jz-header`、`section.jz-footer`，主题据此着色；知乎侧模板里文字、图片、链接以外的元素由方言阶段的标签白名单统一剔除 | 第 6 节 |
| 6 图片收集 | 在拼好的树上遍历所有 `<img>`（含原始 HTML 写的），经 `AssetResolver` 解析来源，`src` 换成 `jz-img:<n>` 占位，解析不到的记 `IMAGE_MISSING`；封面取 `cover` 指定的引用（不在正文里时单独解析），否则取正文首图，固定内容里的图不算候选 | 第 5 节 |
| 7 平台方言 | 结构变换：公众号见 4.1，知乎见 4.2。这一步不删 class、id，后面还要用 | |
| 8 高亮与主题 | 从 `language-*` 提取语言；公众号用 lowlight（常用语言集）高亮，整棵树包进 `section.jz` 后做主题内联（第 7 节），`hljs-*` 配色写在主题里；随后给 `pre`、`table` 套横向滚动容器（4.1 第 4、5 条）。知乎只提取语言写进 `<pre lang>`，不高亮 | 第 7 节 |
| 9 属性清理、压缩与统计 | 删除剩余的 `class`、`id`、`data-*`（知乎方言要求的 `data-draft-node`、`data-draft-type`、`data-size`、`data-numero`、`data-text`、`data-url` 例外；名片的属性随 `:::card` 定）；知乎再删全部 `style`。公众号只做语法层面的压缩：`0px` 写 `0`、能缩写的六位颜色缩写、纯黑改近黑，保留全部显式声明，不按继承删除（删了会被平台编辑器的默认样式覆盖，2026-09-11 评审第 7 项）；统计三种长度。`htmlChars` 超过 18000 给 `CONTENT_NEAR_LIMIT` 警告并附建议（换主题、拆分、减少图片），推送时达到 20000 由体检阻止；阈值定义在 core，壳决定是否展示 | my-toolbox `compactInlineStyles`；需求 8；Codex 评审 A2 |
| 10 序列化 | hast-util-to-html；公众号输出根节点是一个 `<section>`；知乎删除标签间换行。`sourceLocations` 打开时先给元素加原文行号 | |

预览与推送使用同一份 `RenderResult`，差别只在第 5 节图片归位时 `ImageStore` 的实现。`placeImages(result, store)` 负责把占位符换成 `ImageStore` 返回的地址与附加属性（只接受 `data-*`），返回归位后的 HTML、它的 UTF-8 字节数与可见文本，是复制、预览、推送三条路共用的最后一步。壳在调用 `prepare` 时记下 `version`，回调时版本已过期的结果丢弃。

### 4.1 公众号方言

在 hast 上执行，顺序固定：

1. 根节点：整篇包进一个 `section.jz`，容器样式由主题给，类名在阶段 9 删除；不出现 `<div>`，所有 `div` 改 `section`
2. 标题：`h1` 到 `h6` 保留，样式内联；不做目录
3. 列表：删除 `ul/ol` 直接子节点里的空白文本（微信保存时会把它们变成空 `li`）；`li` 里的 `p` 改 `span`；一级列表保留原生 `ul/ol`，二级及更深的列表扁平化为 `<section style="margin-left:1em">` 加文本符号。嵌套列表是真机验收项：微信会给嵌套列表额外加符号，手写符号在手机上出现过空圆点，两种现象都要用标准测试文章在草稿箱里核对后定版
4. 代码块：`<pre>` 保留，外包一个可横向滚动的 `<section>`（滚动容器自成格式化上下文，主题给 `pre`、`table` 的外边距移到容器上，才能与前后段落正常合并）；行间换成 `<br>`，围栏末尾的换行不输出，行首空格换成 `&nbsp;`；等宽字体、不折行；高亮 class 换成内联颜色。微信保存后仍可能吞空格，这是平台侧问题，文案说明
5. 表格：外包可横向滚动的 `<section>`（外边距同代码块，移到容器上）；`table` 写属性 `border=1`、`cellpadding=8`、`bgcolor=#ffffff`，最小宽度按列数 × 100px、不少于 280px；`table-layout: fixed` 与表头底色由主题内联
6. 引用：`<blockquote>` 保留，样式内联
7. 链接：公众号文章链接保留 `<a>`；其他链接也保留 `<a>` 不做处理，微信会去掉地址只留文字，文档说明。脚注引用输出单层 `<sup>[n]</sup>` 纯文本，不带锚点；文末脚注列表保留，标题为「注释」，去掉回到正文的回链
8. 任务列表：`<input type="checkbox">` 会被过滤，换成 ☐ 与 ☑ 文本，后面只留一个空格；任务条目自身的列表圆点由主题去掉，同一列表里的普通条目不受影响
9. 图片：`max-width: 100%`，块级居中；`src` 是占位符
10. 中文标点：行内强调（`strong`、`em`、`span`）后紧跟的中文标点移进强调元素里，避免微信在标点前折行；链接与行内代码自带下划线、底色，标点留在元素外，不随之被装饰。中文之间的软换行直接拼接，不留空格（两个平台一致）
11. 颜色：纯黑 `#000` 改近黑；根节点显式写 `color`，避免深色模式下整篇变色
12. 属性清理在阶段 9 统一做，方言阶段不删 `class`；名片 `mp-common-profile` 及其外层 `section` 的属性原样保留（`:::card` 未实现，目前不会输出名片）
13. 内联样式限制：主题 CSS 不得使用 `position`、`float`、`grid`、`flex`、`var()`、`calc()`、`url()` 与任何 `@` 规则；主题内联遇到即抛错，`pnpm check` 里的快照测试每次构建都会跑到，等同构建期检查

### 4.2 知乎方言

知乎剥掉样式、只认结构，所以这一支不套主题，输出是「干净的语义 HTML」，同时把每一处降级记进 `degraded`：

1. 只保留白名单标签，`style`、`class`、`id` 在阶段 9 统一删除（代码语言在阶段 8 已经提取）：`h2`、`h3`、`p`、`strong`、`em`、`del`、`a`、`blockquote`、`ul`、`ol`、`li`、`pre`、`code`、`table`、`thead`、`tbody`、`tr`、`th`、`td`、`img`、`hr`、`br`、`sup`
2. 标题层级：`h1` 升为 `h2`；`h4` 及更深的标题改为 `<p><strong>` 并记降级（预览标注与警告统一用「h4 及更深」这个口径）
3. 代码块：`<pre lang="python">` 直接包代码文本，不带 `<code>`，`lang` 取自 `language-*` class，代码内容不高亮（Zhihu on Obsidian 与 Wechatsync 的写法一致）
4. 表格：`<table data-draft-node="block" data-draft-type="table" data-size="normal"><tbody>`，表头行并入 `tbody`
5. 图片：推送路径由知乎的 `ImageStore` 在归位时返回 `data-caption`、`data-size="normal"`、`data-rawwidth`、`data-rawheight`、`data-watermark`、`data-original-src`、`data-watermark-src` 这些属性（值来自知乎图片上传结果，见第 5 节与 8.2）；复制路径的 `ImageStore` 只给 `src`，`alt` 保留
6. 脚注：`<sup data-draft-node="inline" data-draft-type="reference" data-numero="n" data-text="<脚注纯文本>" data-url="<脚注里第一个链接，没有则留空>">[n]</sup>`，文末不再输出脚注列表，知乎按这两个属性生成参考列表
7. 任务列表同公众号处理；嵌套列表保留原生结构
8. 公众号名片、合集卡片等平台组件整块移除并记降级；固定内容模板里知乎只允许文字、图片、链接，其余元素在拼装时剔除并警告
9. 序列化时删除标签之间的换行符：知乎编辑器会把标签间的换行渲染成空行（Zhihu on Obsidian 与 Wechatsync 都为此做过修补）
10. 相邻的 `pre` 之间插入一个 `<p><br></p>`：知乎保存草稿时会把相邻的代码块合并成一个（2026-09-10 真实草稿发现，修复后复验通过）

粘贴路径已在 2026-09-10 的真实知乎草稿上核对：保存重开后表格、脚注的 `data-text` 与图片都保留（issue #5）。接口路径（`PATCH` 写入草稿）对标签与属性的取舍尚未实测，第 12 节负责核对；发现差异只改这一支。

## 5. 图片归位

图片归位独立于渲染：渲染只产出占位符与 `ImageRef` 列表，归位时按平台把字节放到目标存储再替换占位符。

```ts
interface ImageRef { id: string; original: string; source: ResolvedAsset; inFixedContent: boolean }
interface ImageCodec {
  probe(bytes): Promise<{ mime; width; height; animated: boolean }>;
  normalize(bytes, profile: NormalizeProfile): Promise<NormalizedImage>;   // 规则见下，三端只此一份
}
interface ImageStore {
  // 收到的是引用与已解析的来源；是否规范化、用哪一档由实现决定，实现持有壳注入的 ImageCodec
  put(image: ImageRef, ctx: { platform; role: 'body' | 'cover' }): Promise<{
    src: string;
    attrs?: Record<string, string>;      // 目标交付方式需要的附加属性，如知乎的 data-rawwidth
  }>;
}
```

`NORMALIZE_PROFILES` 只在 core 里定义，一期两档：`platform`（目标平台要求：长边 2000px、单张 1MB）与 `clipboard`（复制路径：长边 1600px、单张 1MB，是产品参数）。带透明通道输出 PNG，否则 JPEG；壳不得另写一套规则。已实现的 `CanvasImageCodec`（`./browser`）：原文件 12MB、4000 万像素以内；SVG 先检查不含脚本、`foreignObject` 与外部资源再栅格化；按尺寸阶梯（1、0.8、0.6、0.4、0.25、0.15）× JPEG 质量阶梯（0.9、0.8、0.65、0.5）逐档压缩直到达标；动图取首帧并在结果里标 `animated`，由调用方给 `GIF_FIRST_FRAME` 警告。sharp 版编解码放在命令行包里，随命令行实现。

规则（读取、跨次去重、封面与状态缓存是投递路径的设计，随投递适配器实现）：

- 读取：本地文件由 `readFile` 读；远程地址由 `http` 下载，Node 侧拒绝回环、私网、链路本地地址，限制 12MB 与 20 秒；`data:` 直接解码；已在目标平台存储上的地址（公众号 `mmbiz.qpic.cn`、知乎 `*.zhimg.com`）直通不上传
- 规范化：按 `NormalizeProfile` 用「宽度阶梯 × 质量阶梯」逐档压缩直到达标；动图取首帧并警告；SVG 先尝试栅格化（Node 用 sharp，浏览器用 Canvas），失败才阻止并指出是哪一张；知乎沿用同一份规范化结果
- 两张映射表：「原始引用 → 资源」决定文章里哪一处引用对应哪个文件，缺图时按引用逐条绑定；「内容 SHA-256 → 字节」只做去重。哈希不能替代引用绑定：用户补上一张 `a.png`，要由用户指明它对应原文的哪个引用（Codex 评审 W4）
- 去重：同一次推送按内容 SHA-256 去重；跨次推送查 `state.images[hash][platform]`，命中则不再上传
- 封面：优先单独指定的图；否则正文第一张图，固定开头里的图不算候选；两者都没有时公众号阻止（封面必填），知乎警告后继续。公众号封面走永久素材 `add_material`，`media_id` 按内容哈希缓存在 `state.covers`；同一张图既做封面又在正文里时，正文走 `uploadimg`，封面走永久素材，两次上传、两个结果
- 与平台无关的 data URL 归位（按 `clipboard` 档规范化后内嵌）放在 `./browser`，网页版与插件共用。网页版的 `CopyImageStore(platform)` 已改为调用它（`DataUrlImageStore`），知乎中转那一支留在网页版，见 [web.md](web.md) 第 4 节
- 失败信息必须带上原始引用：`IMAGE_DOWNLOAD_FAILED: ./images/a.png`

## 6. 固定内容

实现状态：模板变量替换（`template()`）、固定内容拼装、`:::divider` 与 `:::recent` 已实现，模板内容由壳经 `ArticleInput.templates` 传入；从配置目录读模板文件已随 `./node` 与插件实现；`:::card` 名片与按平台给 `:::recent` 套的样式未实现。网页版的固定内容是表单，不走本节的模板文件，见 [web.md](web.md) 第 7 节。

- 配置目录 `templates/<platform>/header.md` 与 `footer.md`，内容是 Markdown，允许内嵌 HTML
- 变量语法 `{{title}}`、`{{date}}`（渲染当天，格式 `YYYY-MM-DD`）、`{{author}}`（来自 `config.author`）；行内任一变量缺值则整行不渲染；只读取 `config` 自有的字符串属性，值做 HTML 转义
- 内置样式块用 remark-directive 的容器指令语法（`:::name` 起、`:::` 止，冒号与名称之间没有空格），core 内置渲染：
  - `:::card` 公众号名片，字段来自 `config.wechat.card`（`mpId`、`nickname`、`headImg`、`signature`、`serviceType`、`verifyStatus`），输出 doocs 与 my-toolbox 共用的 `mp-common-profile` 结构（公众号编辑器识别名片的原生标签，见 4.1 第 12 条）；知乎侧整块移除
  - `:::recent` 「往期文章」样式块，块内是一个链接列表（公众号放合集链接，知乎放专栏或汇总篇链接），core 按平台套样式；这是需求 15 在本地形态的落点。目前只输出为普通 `section`，按平台套样式待实现
  - `:::divider` 分隔线样式
- 开关：`config.fixed.<platform>.header` 与 `.footer` 为布尔；单次推送可用参数临时关闭
- 名片是否出现完全由模板决定，不做去重；接口提交后回读发现名片被过滤只给警告

## 7. 主题与内联

用户裁定保留 CSS 文件方案（便于移植主题、承接二期自定义 CSS），但一期把引擎范围收窄到三套内置主题实际用到的语法，不做通用级联。以下为已实现的规则（`packages/core/src/theme.ts`）。

- 主题文件 `packages/core/src/themes/<id>/theme.css`，选择器以 `.jz` 为根作用域（如 `.jz h2`、`.jz .task-list-item`）；代码高亮的 `hljs-*` 配色写在同一个文件里；主题的 id、名称、强调色与一句说明在 `theme.ts` 的 `themes` 列表里。一期三套：少数派（`sspai`，强调色 #ac493a）、公众号原生（`native`，#526d64）、Mac（`mac`，#51667d）
- `pnpm themes` 把三份 CSS 生成为 `themes/generated.ts`，运行时从这里读，不在运行时读文件
- 支持的语法：选择器支持类型、类、后代、子代、`:first-child`、`:last-child`、`:nth-child()` 及其组合，`::before`、`::after` 只能放在末尾；伪元素的 `content` 只能是字符串字面量，生成真实的 `<span>` 插到元素首或尾，其余声明作为它的内联样式
- 不支持，遇到即抛错：属性选择器、兄弟选择器（`+`、`~`）、任何 `@` 规则，以及 `position`、`float` 和值里含 `var(`、`calc(`、`url(`、`grid`、`flex` 的声明。原设计允许的 `:root` 变量与 `url(data:image/svg+xml…)` 伪元素内容，三套主题都没用到，一期不支持
- 内联算法：css-tree 解析规则，hast-util-select 在树上匹配（伪元素规则先匹配宿主元素再生成节点）；优先级按（`!important`，特异度，源顺序）排序，特异度 = 类与伪类个数 × 100 + 类型个数；元素原有的内联 `style`（来自清理后的原始 HTML）高于非 `!important` 的主题规则。纯黑在内联时改为近黑 `#292c29`
- 三套主题的结构保持一致，只在强调色、行内代码配色与 Mac 的深色代码块上不同；改一套要同步另外两套，再跑 `pnpm themes`
- 主题回归靠 core 的快照测试：三套主题的样例，以及标准文章在两平台下的输出
- 二期的自定义 CSS 主题（需求 9）走同一条路并按需扩语法：用户在配置目录 `themes/<id>/theme.css` 放文件即可，一期只预留目录，不做加载

## 8. 投递适配器

已实现（`packages/core/src/publish/`，issue #12）；与本节的出入记在 issue #12 批次 2 快照，本节未回改。

```ts
interface Publisher {
  platform: 'wechat' | 'zhihu';
  preflight(article: RenderedArticle, ctx: PublishContext): Promise<PreflightReport>;
  push(article: RenderedArticle, ctx: PublishContext): Promise<PushResult>;
}
type PushResult =
  | { outcome: 'created' | 'updated'; draftRef: string; entryUrl: string; warnings: Warning[] }
  | { outcome: 'uncertain'; message: string }      // 超时或中断，不知道平台是否已写入
  | { outcome: 'failed'; error: JinzhangError };    // 第 10 节
```

### 8.1 公众号

- 凭证：`credentials.json` 的 `wechat.appId`、`appSecret`
- token：`stable_token` 普通模式，缓存到 `wechat-token.json`（经 `SecretStore`，0600）并提前 5 分钟过期，多次 CLI 调用之间复用；不使用强制刷新。token 是账号凭证，不进 `state.json`
- 出站：全部请求经 `http`，可配置 `config.wechat.proxy`（http 或 socks 地址）；未配置时遵循 `HTTPS_PROXY`
- 序列：体检 → 正文图逐张 `uploadimg`（按哈希去重与缓存）→ 替换占位符 → 最终检查正文里只剩 `mmbiz` 地址、字符数少于 2 万 → 封面 `add_material`（缓存命中则跳过）→ 已有映射走 `draft/update`（`index: 0`），否则 `draft/add`，返回 `media_id` 后立刻写 `state.drafts`（状态 `unverified`）→ `draft/get` 回读校验（标题一致、名片数量）→ 更新状态为 `confirmed`。先落盘再校验，中途崩溃也不会下次重复建草稿
- 幂等：键是源文件绝对路径（第 9 节）；用户确认重推就更新原草稿，不做内容变化检测；`draft/update` 报 40007 时先 `draft/get` 确认，草稿确实不在则新建并提示「原草稿已删除或已发布，已新建」
- 结果不确定：`draft/add` 遇超时或连接中断时把映射标为 `uncertain`，返回「请先到草稿箱确认」，下次推送必须带确认参数才允许再次创建；图片上传与 `draft/update` 可安全重试
- 提交字段：`title`、`content`、`thumb_media_id`、`article_type: news`；不填 `author`、`digest`、`content_source_url`（需求 6.1）
- 40164 处理：从 errmsg 里解析出被拒绝的出口 IP，与体检时探测到的出口 IP（经同一代理请求 `https://api.ipify.org?format=json`）一起展示，附后台路径「设置与开发 → 基本配置 → IP 白名单」
- 出口 IP 变化提示：每次成功取到 token 后把当时的出口 IP 记进 `state.wechatEgressIp`；体检探测到的 IP 与它不同时给警告「出口 IP 已从 A 变为 B，白名单可能需要更新」，不等 40164 才发现（需求 27）

### 8.2 知乎

接口序列全部来自 Zhihu on Obsidian、zhihu-cli 与 Wechatsync 三份源码的交叉印证（详见 issue #4 调研摘要），三者都不计算 `x-zse-96`（知乎网页端部分接口要求的请求签名头），说明草稿链路不需要逆向签名算法。

- 登录态：`zhihu-session.json` 存 cookie 集合与用户信息。草稿链路的最小集是 `z_c0`、`_xsrf`、`d_c0`；`BEC`、`_zap`、`q_c1`、`captcha_session_v2` 有则带上；`__zse_ck` 只在抓取网页时需要，草稿链路不用，因此不实现它的刷新
- 请求头：桌面 Chrome 的 `User-Agent`、`x-requested-with: fetch`、`x-xsrftoken`（取自 `_xsrf`）、`origin` 与 `referer` 指向 `https://zhuanlan.zhihu.com`、`Cookie`。三个壳里只有 CLI 与插件发这些请求，宿主的 `http` 必须允许自定义 `Cookie`、`Origin`、`Referer`（Node 的 fetch 可以，Obsidian 的 `requestUrl` 可以，浏览器不行，所以网页版没有知乎推送）
- 登录方式：CLI 用扫码（`GET /signin` 取 `_xsrf` → `POST /udid` 取 `d_c0` → `POST /api/v3/account/api/login/qrcode` 取二维码 → 终端展示 → 轮询 `scan_info` 直到拿到 `z_c0`）或粘贴 Cookie；插件内嵌登录页扫码后读取会话 Cookie；两处写同一个文件，任一处登录另一处即可用。细节在 [skill.md](skill.md) 与 [obsidian-plugin.md](obsidian-plugin.md)
- 登录态校验：`GET https://www.zhihu.com/api/v4/me` 返回 `id`、`name`、`avatar_url`；401、403 或 `name` 为「知乎用户」视为未登录
- 图片：对规范化后的字节算 MD5 → `POST https://api.zhihu.com/images`，体 `{ image_hash, source: "article" }` → 响应 `upload_file.state` 为 1 表示知乎已有此图，为 2 则用响应里的 `upload_token`（`access_id`、`access_key`、`access_token`）自行计算阿里云 OSS V1 签名，`PUT https://zhihu-pics-upload.zhimg.com/v2-<md5>`（bucket 名 `zhihu-pics`，头 `x-oss-date`、`x-oss-security-token`、`x-oss-user-agent`、`Content-Type`）→ 轮询 `GET https://api.zhihu.com/images/<image_id>` 直到 `status` 为 `success`，取 `src`、`original_src`、`watermark`、`watermark_src` → 正文 `img` 的 `src` 与 `data-original-src` 写 `<original_src>.<ext>`，宽高由本地解码得到。一期不做动图：GIF 需要分片上传，先取首帧按静态图处理并警告
- 草稿：首次 `POST https://zhuanlan.zhihu.com/api/articles/drafts`，体 `{ title, delta_time: 0, can_reward: false }`，拿到 `id` 后立刻写入 `state.drafts`；每次推送 `PATCH https://zhuanlan.zhihu.com/api/articles/<id>/draft`，体 `{ title, content, table_of_contents: false, delta_time: 30, can_reward: false }`；有封面时再 `PATCH` 一次 `{ titleImage: <封面上传结果的 original_src>, isTitleImageFullScreen: false, delta_time: 30 }`
- 只建草稿与更新，不调用 `content/publish`，不设置话题
- 入口：`https://zhuanlan.zhihu.com/p/<id>/edit`，同时提示草稿在创作中心的草稿箱
- 草稿是否还在：没有找到读取草稿的接口证据，一期不做存在性预检；`PATCH` 返回 404 视为草稿已不可用，新建并提示（403 不走这条分支，见失败识别）。用户在知乎侧已把这篇发布后再重推，`PATCH` 会写进已发布文章的草稿而不改线上内容，这一点在结果里提示
- 失败识别：HTTP 401 归为 `ZHIHU_LOGIN_REQUIRED`；403 与响应 `code` 为 10001、10003 归为 `ZHIHU_RISK_CONTROL`，提示先在浏览器里正常访问知乎完成验证再重试，绝不因此新建草稿；返回 HTML 验证页同样归为需重新登录
- 结果不确定：`POST /api/articles/drafts` 超时或中断时与公众号同样处理，映射标为 `uncertain`，下次推送必须带确认参数
- 限速：单篇串行，图片逐张上传、请求间隔不少于 300 毫秒；不做自动重试创建

### 8.3 多平台与结果

- 默认推送平台来自 `config.targets`，单次可临时改；按平台串行执行，每个平台独立报告，一个失败不影响也不重发已成功的
- 推送前确认信息由壳展示，core 提供 `describe(article)`：目标平台与账号、标题、封面缩略来源、图片数、字符数、开头结尾是否启用
- 成功给草稿入口与警告列表；失败给 `JinzhangError`（第 10 节）

## 9. 配置与状态

已实现（`packages/core/src/node.ts`、`local.ts`，issue #12）；网页版的本地存储见 [web.md](web.md) 第 2.3 节。

目录 `~/.config/jinzhang/`，环境变量 `JINZHANG_HOME` 覆盖；三个操作系统同一路径，便于文档与迁移。目录 0700，凭证文件 0600。

```
~/.config/jinzhang/
├── config.json           # 公共配置，可提交到任何地方都不泄密
├── credentials.json      # 公众号 AppID 与 AppSecret（0600）
├── wechat-token.json     # 公众号 access_token 缓存（0600）
├── zhihu-session.json    # 知乎 cookie 与用户信息（0600）
├── state.json            # 文章级选择、草稿映射、图片与封面缓存、出口 IP
├── templates/
│   ├── wechat/header.md
│   ├── wechat/footer.md
│   ├── zhihu/header.md
│   └── zhihu/footer.md
├── themes/               # 二期自定义主题，一期只预留
└── cache/                # 预览 HTML、登录二维码等可再生文件，迁移时不带
```

`config.json`：

```json
{
  "version": 1,
  "author": "AFreeCoder",
  "theme": "sspai",
  "targets": ["wechat", "zhihu"],
  "fixed": { "wechat": { "header": true, "footer": true }, "zhihu": { "header": false, "footer": true } },
  "wechat": {
    "card": { "mpId": "", "nickname": "", "headImg": "", "signature": "", "serviceType": 1, "verifyStatus": 1 },
    "proxy": ""
  }
}
```

`state.json`：

```json
{
  "version": 1,
  "articles": {
    "/Users/me/notes/文章.md": { "cover": "/Users/me/notes/assets/cover.png" }
  },
  "drafts": {
    "/Users/me/notes/文章.md": {
      "wechat": { "account": "<appId>", "mediaId": "…", "status": "confirmed", "title": "…", "updatedAt": "…" },
      "zhihu": { "account": "<知乎用户 id>", "draftId": "…", "status": "confirmed", "updatedAt": "…" }
    }
  },
  "images": { "<sha256>": { "wechat": { "<appId>": "https://mmbiz.qpic.cn/…" }, "zhihu": { "<知乎用户 id>": { "md5": "…", "src": "…", "originalSrc": "…", "watermarkSrc": "…", "width": 0, "height": 0 } } } },
  "covers": { "<sha256>": { "wechat": { "<appId>": "<mediaId>" } } },
  "wechatEgressIp": "1.2.3.4"
}
```

- `articles` 记录按文章保存的选择，一期只有单独设置的封面；插件的封面选择与命令行共享
- 草稿映射的键是源文件的绝对路径（规范化后）。skill 直接用路径；插件用 vault 根目录加文件相对路径得到同一个绝对路径，两处推同一篇文章命中同一条映射。文件改名或移动等于新文章，文档说明；`--new-draft` 参数可强制新建
- `status` 取值 `confirmed`、`unverified`（写入成功但回读校验没通过）、`uncertain`（创建结果未知）
- 草稿映射、图片与封面缓存都带账号标识：公众号的 `media_id` 与图片地址、知乎的草稿 id 都是账号作用域的。当前配置的账号与映射里的账号不一致时，视为没有映射并给出诊断，不沿用另一个账号的 id
- 一期不做跨进程投递互斥：同一篇文章向同一平台投递时一次用一个入口，命令行与插件先后使用同一文件正常共享映射；同一入口内重复触发由进程内标志防护
- 写入用「临时文件 + rename」原子替换。插件与命令行是两个进程，可能同时改 `state.json`：写入前先取目录下的锁文件（`state.lock`，带进程号与时间戳，超过 30 秒视为陈旧），再重读磁盘内容合并本次修改后写回，避免互相覆盖草稿映射；同一进程内按源文件加互斥锁
- 迁移：把目录复制到另一台机器直接可用（`cache/` 可以不带）；知乎登录态可能因设备变化失效，届时按提示重新登录
- 凭证不进日志、错误信息与任何输出；`--json` 输出的配置状态只含布尔与缺失字段名
- Obsidian 插件自己的 `data.json` 只放界面偏好，不放凭证，避免随 vault 同步

## 10. 错误模型

已实现（`packages/core/src/publish/errors.ts`）；表外新增的错误码见 issue #12 批次 2 快照。

```ts
interface JinzhangError {
  code: string;                       // 见下表
  stage: 'config' | 'render' | 'image' | 'preflight' | 'push' | 'auth';
  platform?: 'wechat' | 'zhihu';
  message: string;                    // 给人看的中文
  action?: string;                    // 下一步动作
  ref?: string;                       // 关联对象：图片引用、草稿 id、出口 IP
}
```

一期内置翻译的错误码是 my-toolbox 已经验证过的集合加知乎的登录与风控两类；其余平台错误码原样透出为 `WECHAT_API_<errcode>` 或 `ZHIHU_API_<code>`，逐条翻译按需求 6.5 留到后续：

| code | 触发 | action |
|---|---|---|
| `CONFIG_MISSING` | 缺 AppID、AppSecret 或知乎登录态 | 指向 `jinzhang config` 或插件设置页 |
| `WECHAT_IP_NOT_WHITELISTED` | 40164 | 显示被拒 IP 与当前出口 IP，给后台路径与代理配置提示 |
| `WECHAT_BAD_CREDENTIALS` | 40013、40125、40243 | 检查 AppID 与 AppSecret |
| `WECHAT_NO_PERMISSION` | 48001 | 账号类型不支持草稿接口 |
| `WECHAT_RATE_LIMITED` | 45009、45011 | 稍后重试 |
| `WECHAT_CONTENT_TOO_LONG` | 本地预检或 45002 | 报实际字符数，建议换主题、拆分或减少图片 |
| `WECHAT_CONTENT_INVALID` | 45166 | 提示可能是名片或非标准属性，建议关闭固定内容后重试以定位 |
| `WECHAT_DRAFT_GONE` | 40007 | 已自动新建草稿，提示核对 |
| `OUTCOME_UNCERTAIN` | 创建草稿时超时或中断（`platform` 字段区分平台） | 先到草稿箱确认，再带确认参数重试 |
| `ZHIHU_LOGIN_REQUIRED` | 401、验证页 | 重新登录 |
| `ZHIHU_RISK_CONTROL` | 403、10001、10003 | 在浏览器里正常访问知乎完成验证后重试；反复出现则重新登录 |
| `ZHIHU_DRAFT_GONE` | PATCH 返回 404 | 已自动新建草稿 |
| `IMAGE_MISSING` | 引用无法解析 | 指出引用与查找过的路径 |
| `IMAGE_DOWNLOAD_FAILED` | 远程图片下载失败 | 指出地址与 HTTP 状态 |
| `IMAGE_UNCONVERTIBLE` | 无法转成 jpg/png 或压缩后仍超 1MB | 指出是哪一张 |
| `COVER_MISSING` | 公众号没有封面 | 指定封面或在正文加一张图 |

## 11. 体检（推送前只读检查）

已实现（各平台 `Publisher.preflight`）。`preflight` 按所选平台分别执行，无副作用（获取公众号 token 除外，它不产生内容但会验证白名单）：

| 检查项 | 公众号 | 知乎 |
|---|---|---|
| 凭证或登录态 | AppID、AppSecret 存在；能取到 token（顺带验证白名单） | 登录态存在；`GET /api/v4/me` 返回用户 |
| 出口 IP | 探测并展示；与上次成功时记录的 IP 不同则警告 | 不检查 |
| 标题 | 超 32 字警告 | 不检查 |
| 封面 | 必须有，且能解码 | 可无，有则能解码 |
| 正文长度 | 在 `htmlChars` 上按每张图 512 字符的地址预算预估替换后的长度，少于 20000 才放行，否则阻止；超过 18000 转发 core 的 `CONTENT_NEAR_LIMIT` 警告；归位后按实际长度复检；可见字数只展示不约束 | 不检查 |
| 图片 | 每张能读取、能转成 jpg/png 且 1MB 以内（本地解码，不上传） | 每张能读取、能解码 |
| 固定内容 | 模板变量能解析 | 模板只含文字、图片、链接 |

输出 `PreflightReport { platform, ok, blockers: JinzhangError[], warnings: Warning[], summary: {...} }`，可直接序列化给 agent。体检通过不保证推送成功。

## 12. 待实测门控

issue #1 快照 9 的八项实测，按它们各自影响的设计决策归位；实测需要真实账号，结论记录在 issue #4：

| 实测项 | 影响的决策 | 通过时 | 不通过时 |
|---|---|---|---|
| 1 公众号编辑器粘贴 data URL 图片是否保留 | 网页版公众号复制路径 | 维持 data URL（my-toolbox 日常使用已证实）。网页版上线后粘贴后可见已证实，保存后重开待用户核对 | 公众号路径也改走中转桶 |
| 3 接口提交的 `mp-common-profile` 是否保留 | 名片是否只在复制路径可用 | 维持 `:::card` | 回读警告改为「接口路径不支持名片」并在文档写明 |
| 4 合集链接经接口提交是否可点 | `:::recent` 块的链接写法 | 维持 `<a>` | 改为文字加提示「在编辑器里手动插入合集」 |
| 5 知乎 PATCH 后草稿是否进创作中心、二次 PATCH 不重复、登录态时效、限速阈值 | 知乎适配器的幂等与限速参数 | 维持 8.2 | 调整键与间隔；极端情况退回剪贴板 |
| 6 标题 33 到 64 字的展示 | 标题规则 | 保持只警告 | 不改需求，文档补展示效果 |
| 7 接口路径保留 `class`、`data-*` 是否触发 45166 | 4.1 第 12 条属性清理的例外范围 | 名片保留属性 | 名片属性也清理，转为纯样式名片 |
| 8 未认证订阅号是否被拒 | 体检的账号前提提示 | 无变化 | 体检增加账号类型说明 |

已关闭：第 2 项「知乎编辑器粘贴公网地址图片能否转存」由作者用 my-toolbox 的知乎复制路径多次实际使用证实可以转存（2026-09-09）；原问题里的 `mmbiz` 地址变体不再与本设计相关，网页版知乎路径用的是中转桶地址。

另外两项由本设计新增：知乎服务端对 4.2 输出标签与属性的实际取舍，粘贴路径已在 2026-09-10 真实草稿上核对，`PATCH` 路径待投递实现后读回比对；剪贴板 `text/html` 体积上限，Chrome 已在端到端里验证约 5.4MB 可以写入并读回，Safari 待测。

## 13. 与技术基线的差异

需求阶段留下的六项差异，本设计按需求文档执行：标题上限只警告不阻止；文章信息不用 frontmatter；主题只作用于公众号；知乎只建草稿与更新；正式发布记为硬约束；白名单增加代理配置。本设计另有四处与基线不同（裁定记录在 issue #4，基线回改随之进行）：

1. 渲染管线从 DOM 改为 hast，Node 侧不再需要 jsdom
2. 不采用 `@wenyan-md/core`，改为照结构自研并移植规则
3. 配置目录从各系统的应用支持目录改为统一的 `~/.config/jinzhang/`
4. 图片处理在浏览器与插件里用 Canvas，sharp 只在 CLI

## 14. 与需求的映射

| 需求 | 本文对应 |
|---|---|
| 1 原生 Markdown 输入 | 4 阶段 1 至 4 |
| 2 封面图设置 | 5 封面规则 |
| 3 本地图片与网络图片 | 3 `AssetResolver`、5 读取 |
| 4 内置排版样式 | 7 |
| 5、6 预览 | 4 `placeholders`、`degraded`；预览壳由 core 的 `./preview` 提供，壳只负责嵌入与图片地址 |
| 7 公众号排版不走样 | 4.1 |
| 8 超长提前提示 | 4 阶段 9 的 `CONTENT_NEAR_LIMIT`、11 |
| 12、13、15 固定内容 | 6 |
| 16 推送时图片自动上传 | 5 |
| 18、19 推送草稿箱 | 8.1、8.2 |
| 20 改稿重推 | 8.1、8.2 幂等；9 草稿映射 |
| 21 推送前确认 | 8.3 `describe` |
| 22 推送前体检 | 11 |
| 23 推送结果可读 | 8.3、10 |
| 24 推送目标平台可配置 | 8.3、9 `targets` |
| 26 配置一次两处可用 | 9 |
| 27 白名单引导 | 8.1 40164 处理与出口 IP 变化提示、11 出口 IP |
| 28 知乎登录 | 8.2、各壳设计 |
| 6.7 可扩展性 | 新平台等于新增一个 `Publisher`、一个 `ImageStore`、一支方言与一套模板目录，壳不改 |

## 变更记录

- 2026-09-08 初稿，来源 issue #4
- 2026-09-09 网页版框架定为 Next.js 服务端模式，中转桶签名为一期唯一服务端能力；网页版复制路径按平台固定（公众号 data URL、知乎中转桶）。来源 issue #4 快照 2
- 2026-09-09 待实测第 2 项（知乎转存公网图片）由用户证实关闭
- 2026-09-09 合并 Codex 评审（issue #4 A1 至 A6）：宿主接口按能力拆为 `RenderHost` 与 `PublishHost`；渲染拆为异步 `prepare` 与同步 `render`；补 `rehype-raw` 与允许列表清理，图片收集移到统一的树上；属性清理移到高亮与主题之后；`ImageStore` 可返回附加属性；图片规格只在 `NormalizeProfile` 定义；三种长度口径分开；主题引擎收窄到三套主题实际用到的语法（用户裁定保留 CSS 方案）
- 2026-09-10 按 issue #6 的 skill 合并结论同步：草稿映射与图片、封面缓存带账号标识；一期不做跨进程投递互斥，只保留状态文件写锁与「一次一个入口」的使用说明；运行时改为 Node 22 以上、24 首测；代理措辞更正
- 2026-09-10 评审收敛，状态改为已评审，沉淀到仓库
- 2026-09-30 按已实现的 core（main `4d312c0`）同步：第 1 节加实现状态；第 2 节目录与构建按实际（依赖打进产物、包不发布、主题生成、快照基线）；第 3 节去掉 `RenderHost`（渲染只需 `AssetResolver`，编解码由 `ImageStore` 持有），`ResolvedAsset` 改为实际类型并去掉 `local`，插件编解码复用 `CanvasImageCodec`，依赖边界检查落到脚本；第 4 节接口改为实际签名，补 `sourceLocations`、根入口的其他导出、`htmlChars` 的实际口径与体检预算，更新警告码与各阶段规则（frontmatter 只去映射、按源位置保留原始引用、中文软换行、`style` 允许列表、压缩不再按继承删除声明）；4.1 根节点、表格、脚注、任务列表与主题限制按实现；4.2 补相邻代码块规则与粘贴路径验收；第 5 节 `ImageStore.put` 改为接收引用，补两档规格与 Canvas 编解码细节；第 6 节标出已实现与未实现（`:::card`、`:::recent` 样式、模板文件）；第 7 节主题引擎按实现收窄（不支持 `var()`、`url()`）并补维护规则；第 8 至 11 节标为未实现，体检长度预估补地址预算；第 12 节更新实测进展。来源 issue #4、#5、#9
- 2026-09-30 按插件设计定稿（issue #12）回写：`./node` 只放命令行与插件共用的文件读写，sharp 编解码与带代理的传输由各壳的宿主实现提供（命令行包用 sharp 与 undici）；与平台无关的 data URL 归位放 `./browser`，网页与插件共用；宿主表的插件一列按插件设计更新（`requestUrl` 自包超时、解析器分支）；补 `jz-local://` 的三种用法；插件设计链接改为 obsidian-plugin.md
- 2026-09-30 投递适配器、配置目录读写与 Obsidian 插件实现合入（issue #12，PR #17、#18、#19）：第 1 节实现状态与第 2、3、5、6、8 至 11 节的「未实现」标注更新；接口与实现的出入不回改，记在 issue #12 的批次快照
