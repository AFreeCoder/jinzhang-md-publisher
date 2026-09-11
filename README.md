# 锦章 Jinzhang · Markdown 发布助手

让文字，锦绣成章。网页版提供 Markdown 输入、微信公众号主题预览、知乎结构预览和正文富文本复制。页面采用白底、朱砂强调色，沿用 `prototypes/web-v1` 中已评审的视觉方向。

## 本地运行

需要 Node.js 22 或以上、pnpm 10.29.2；CI 使用 Node 24。本地开发不需要平台账号，公众号复制可以完全在浏览器中运行。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

访问 [首页](http://127.0.0.1:3000/) 或 [排版工作区](http://127.0.0.1:3000/format)。原文和排版设置存于本站 `localStorage`，图片存于 IndexedDB；刷新可以恢复。首次为空白，点击「载入示例」查看效果。

正文支持标准 Markdown、GFM 表格/任务列表、脚注、代码高亮、内置分隔与往期文章块，以及经过安全清理的原始 HTML。三套公众号主题为少数派、公众号原生、Mac；知乎只输出平台结构。固定头尾按平台分别配置，开启后展开对应文案。标题仅用于预览；网页版不提供封面设置，复制正文不包含标题和封面，两者在平台编辑器单独设置。

原文与预览双向同步滚动，点击预览正文可定位到原文。窄屏通过「编辑 / 预览」切换工作区。「更多操作」提供新建文章、载入示例和恢复上一稿；替换文章时保留一份上一稿，并保留平台、主题和固定内容设置。

原文里被忽略的 frontmatter、不支持的语法和被清理的 HTML 会在编辑区底部常驻提示。复制在编辑防抖期间点击时等待最新排版结果，不复制旧正文。本地图片可通过粘贴、拖入或选择文件插入；无法读取的 Markdown 图片引用会提示逐项补齐。不要依赖文件名自动匹配：`a/image.png` 和 `b/image.png` 是不同引用。GIF/动态 WebP 复制时转为静态首帧并提示；SVG 尝试栅格化。图片复制时归一化为 JPEG/PNG，默认长边不超过 1600px、单张不超过 1MB。

## 知乎图片中转配置

纯文本复制无需中转；本地图片插入或补齐后即在后台上传 OSS，保留本地副本。公众号复制使用内嵌图片，不等待后台上传；知乎复制复用已上传地址，旧稿或过期图片在复制时补传。正常上传和复制不弹确认窗口。开发环境也必须明确配置真实测试桶，应用没有伪造成功或自动改用公共图床的路径。

复制 `apps/web/.env.example` 为 `apps/web/.env.local`，填写测试资源；该文件已忽略，不提交密钥。`JINZHANG_ORIGIN` 必须和访问网页的 Origin 完全相同。`TRANSIT_TICKET_SECRET` 是至少 32 字符的独立随机密钥。

中转桶必须为专用私有桶：

- 私有读写，禁止匿名列表，关闭版本控制；应用凭证仅允许对应 `transit/` 前缀的读写和删除。
- 设置七天生命周期删除；对象清理由存储服务周期执行，不承诺到期即时删除。
- CORS 仅允许本站域名的 POST/GET，按 OSS 控制台配置允许头；不可使用任意域名通配符。
- 两个 `/api/transit/` 接口必须在部署平台或反向代理配置按 IP 的分钟与每日上限，并配置桶流量告警。代码没有用进程内计数伪装分布式限流。正式部署前需要用实际平台规则验证 429 与额度恢复。
- 读取链接使用七天有效的 OSS V4 GET 签名；上传表单五分钟有效、绑定具体对象与精确大小、禁止覆盖；完成接口核对票据、HEAD、魔数、像素上限和完整解码后才签发读取链接。

密钥只在服务端使用，文章正文不发给服务端；远程图片由浏览器尝试读取，受 CORS 限制时保留原地址并提醒核对。知乎已上传图片由编辑器粘贴时抓取，必须在知乎完成转存后保存。

签名依据 [OSS POST V4 文档](https://www.alibabacloud.com/help/en/oss/developer-reference/signature-version-4-recommend)，并与 `ali-oss` 官方 SDK 做无网络对照测试。

## 验证与构建

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

如本机已安装 Chrome，可用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`，测试使用独立浏览器上下文，不操作个人浏览器资料。

`pnpm check` 包含 TypeScript、Vitest、Next.js 生产构建、浏览器依赖边界及 ESM/CJS 输出一致性检查。端到端测试覆盖图片输入/恢复、即时上传与失败重试、两平台真实剪贴板载荷、权限失败重试复用、快速改稿、手动复制、新建与上一稿恢复、长文定位及窄屏切换。端到端中的 OSS 返回由隔离路由模拟，不代表真实云端上传验收。

```sh
pnpm build
pnpm --filter @jinzhang/web start
```

需要 Node 服务端运行时；不能用静态导出替代图片接口。生产环境使用 HTTPS，并按实际域名配置 Origin、OSS CORS 与限流。

## 目录与范围

- `packages/core`：共享解析、清理、平台规则、CSS 主题、图片接口、浏览器资源适配与预览壳；tsup 生成 ESM/CJS 及类型声明。
- `apps/web`：Next.js 门户、排版工作区、剪贴板流程与图片中转 API。
- `fixtures`：标准测试文章与图片；主题/平台快照以此作为回归输入。
- `prototypes/web-v1`：开发前可点击设计稿，保留原始截图作设计参考。

本次只实现网页版所需的 core 与网页入口，不包含 CLI、Skill 或 Obsidian 插件实现。首页相应安装信息通过 `JINZHANG_SKILL_INSTALL`、`JINZHANG_OBSIDIAN_REPO` 在构建时注入；未发行时如实显示准备中。

真实平台验收与实施记录留在 [Issue #5](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/5)。原始技术结论见 `docs/design/product-v1/web.md` 和 `architecture.md`。需要真实 OSS 与平台测试资源才能验证签名链接抓取、平台保存后重开、Safari 大体积剪贴板等门禁；本地测试不代替这些结果。
