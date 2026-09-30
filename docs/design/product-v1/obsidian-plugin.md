# 锦章一期设计：Obsidian 插件

状态：已评审，2026-09-30 定稿（issue #12）。2026-09-08 起草，2026-09-30 按已实现的 core 与合并后的 architecture.md、skill.md 重写，同日合并 Codex 评审。上游：[需求文档](../../requirements/product-v1/requirements.md) 功能 2、5、6、12、13、15、16、18 至 28、31 与业务规则 6.1 至 6.6；过程记录在 [issue #12](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/12)（插件）与 [issue #4](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/4)（总体架构）。总体架构与 core 见 [architecture.md](architecture.md)，本文只写插件这个壳。

## 1. 结论

- 插件是作者日常的发布入口，也是本地形态的第一个实现：投递适配器、共享的配置与状态读写这些 core 里还没有的部分，随插件一起实现，命令行以后直接复用。固定内容（开头结尾、名片、往期文章）后面单独调整，第 10 节先按现有设计写，调整后再改
- 渲染只用 core：`prepare`、`render`、`placeImages`、`previewDocument` 与 `./browser` 的 `CanvasImageCodec` 都是网页版已在用的代码。Obsidian 的 `MarkdownRenderer` 不参与渲染（同类插件用它换来 callout 与 dataview 保真，代价是与网页、命令行结果不一致，本项目不取）
- 桌面专用，`isDesktopOnly: true`。配置、凭证、登录态与草稿映射放用户目录 `~/.config/jinzhang/`，与命令行共用；插件自己的 `data.json` 只放界面偏好，不放凭证，避免随 vault 同步
- 网络走 Obsidian 的 `requestUrl`：它在主进程发请求，没有跨域限制，可以带 `Cookie`、`Origin`、`Referer`；multipart 手工拼装。四个同类公众号插件都这样做
- 预览是右侧栏视图，`iframe` 加 `sandbox` 与样式隔离，跟随当前笔记
- 知乎登录在插件弹窗里用 `webview` 打开知乎登录页，扫码后读取会话 cookie 写入共享文件；读不到时退化为粘贴 cookie
- 分发先走 BRAT，用本仓库的 GitHub Release；社区上架是二期
- 第一版先可用：不做编辑器与预览的同步滚动、手机宽度切换、模板实时预览这类体验项，也不做结果不确定时「绑定已有草稿」的界面，等日常用起来再按需补

## 2. 工程结构

```
apps/obsidian/
├── manifest.json            # id: jinzhang, name: 锦章, isDesktopOnly: true, minAppVersion 至少 1.5.7
├── versions.json            # 版本到 minAppVersion 的映射
├── esbuild.config.mjs       # cjs 单文件；external: obsidian、electron、@electron/remote、Node 内置模块
├── styles.css
└── src/
    ├── main.ts              # onload：registerView、addCommand、addSettingTab、事件监听
    ├── host.ts              # PublishHost 的 Obsidian 实现：requestUrl、代理例外、readBinary、共享配置目录
    ├── resolver.ts          # VaultAssetResolver：按 Obsidian 链接规则找附件
    ├── obsidian-markdown.ts # 私有写法预处理（第 4 节）
    ├── view.ts              # 右侧栏预览 ItemView
    ├── push.ts              # 体检、确认、逐平台投递、结果
    ├── modals/              # 确认、结果、封面选择、知乎登录
    └── settings.ts          # 设置页
```

- 依赖 `@jinzhang/core` 的 `.`、`./preview`、`./browser`，以及随插件新增的 `./publish`（投递适配器）与 `./node`（共享配置与状态的文件读写）。esbuild 把它们打进一个 `main.js`，Node 内置模块标为外部，由 Obsidian 桌面端提供
- `./node` 只放文件读写（配置、凭证、状态、模板、写锁），不放 sharp：插件打包不能带原生模块。sharp 版编解码放进命令行包。architecture.md 第 2 节已按这个划分回写
- `minAppVersion` 至少 1.5.7：`getFrontMatterInfo` 与 `Vault.getFileByPath` 从这一版开始提供；最终值按 webview 登录的实测定（第 14 节）
- 构建产物进 `.gitignore`；`pnpm check` 增加插件的类型检查与构建，并用 `scripts/check-browser-boundary.mjs` 同样的方式确认产物里没有 sharp 与 ali-oss

## 3. 与 core 的接线

| 接口 | 插件的实现 |
|---|---|
| `AssetResolver` | `VaultAssetResolver`，按引用的形式分支：`http(s)` 地址返回 `remote`；`data:image/...` 解码返回 `data`；`jz-local://vault/<vault 内路径>`（预处理改写过的嵌入图，第 4 节）用 `vault.getFileByPath` 取文件；`jz-local://file/<绝对路径>` 按磁盘绝对路径用 `node:fs` 读；以 `/` 开头的路径先按 vault 根路径找，vault 里没有再按磁盘绝对路径读；其余相对引用先 URL 解码，交给 `metadataCache.getFirstLinkpathDest(路径, 当前笔记)`，与 Obsidian 自己显示这张图时的解析一致，根目录与笔记目录下有同名附件时也不会解析错；找不到再按当前笔记所在的磁盘目录解析，覆盖指向 vault 外的 `../` 路径。读出字节返回 `blob` 类，`assetId` 填 vault 内路径或磁盘绝对路径；都找不到返回 `missing`，原因写明找过哪些位置 |
| `ImageCodec` | 直接用 `./browser` 的 `CanvasImageCodec`：Electron 渲染进程有 Canvas 与 `createImageBitmap`，规范化规则与网页版完全一致 |
| `http` | 默认 `requestUrl({ url, method, headers, body, throw: false })`；multipart 用 `TextEncoder` 把 boundary、头、文件字节拼成一个 `ArrayBuffer`；知乎 OSS 直传用二进制 `PUT`。`requestUrl` 没有代理参数，配置了 `wechat.proxy` 时公众号请求改走 Node `https` 加代理 agent（纯 JS 包，可以打进 `main.js`）。`requestUrl` 也没有超时与取消参数，宿主层用 `Promise.race` 包一层超时；超时后的请求可能仍在平台侧完成，创建草稿时一律按结果不确定处理（第 7 节） |
| `readFile` | vault 内文件用 `vault.readBinary`；vault 外路径用 `node:fs` |
| `store` / `secrets` | `./node` 的文件实现，目录 `~/.config/jinzhang/`，尊重 `JINZHANG_HOME` |
| 预览 | `previewDocument(result, html, { coverSrc, account, date })`：插件显示封面区与公众号名称；图片用 `blob:` 地址，只用于预览，复制与推送都不用它 |

源文件的绝对路径由 vault 根目录（`FileSystemAdapter.getBasePath()`）加笔记在 vault 里的路径拼出，与命令行推同一篇文章时命中同一条草稿映射。

## 4. 输入预处理

core 只认标准 Markdown，Obsidian 的写法由插件在交给 core 前转换（需求 31、业务规则 6.2）。转换按语法位置进行，代码块与行内代码里的内容不动：

| 写法 | 处理 |
|---|---|
| 属性区（frontmatter） | 对本次取得的编辑器文本调用 `getFrontMatterInfo(content)`，按返回的 `contentStart` 去掉属性区，不提示：在 Obsidian 里属性区是常态，不是误写。不用 `metadataCache` 给出的位置：它来自已保存的文件，与编辑器里未保存的文本可能不是同一版，偏移会把属性留在正文里或截掉正文 |
| `%%注释%%` | 整段删除。Obsidian 阅读视图里不显示，发布时也不应出现，否则会把写给自己的话发出去 |
| `![[图片.png]]`、`![[图片.png\|300]]` | 用 `getFirstLinkpathDest(链接, 当前笔记)` 找到文件后，按它在 vault 里的路径转成标准图片语法，例如 `![](<jz-local://vault/assets/a.png>)`，宽度参数丢弃；找不到则保留原引用，由 core 报缺图 |
| `![[笔记]]`、`![[笔记#标题]]` | 不展开，替换为「嵌入笔记：笔记」文本并警告 |
| `[[笔记]]`、`[[笔记\|别名]]` | 只留显示文字 |
| `file://` 地址、Windows 盘符路径 | 改写为 `jz-local://file/<绝对路径>`。core 的清理只放行 `http`、`https`、`data`、`jz-local` 与不带协议的地址，这两种会被当成协议删掉，图片变成缺失 |
| `> [!note] 标题` 及其他 callout | 转成普通引用，首行标题加粗 |
| dataview、excalidraw 等其他插件语法 | 原样交给 core，按普通文本处理并由 core 警告 |

预处理只改写引用、不读文件，读取在解析器里做（第 3 节）。一次操作只取一份编辑器文本，预处理、排版、体检、确认、复制与推送都基于它（第 7 节）。

标题取笔记文件名（去扩展名），正文首个一级标题与它相同时由 core 去重（业务规则 6.1）。规则来源是 my-toolbox 的 `obsidianMarkdown.ts`。

## 5. 预览视图

- `ItemView`，视图类型 `jinzhang-preview`；命令「打开锦章预览」在右侧栏打开，已打开则切过去
- 工具栏：平台切换（公众号 / 知乎）、主题（只在公众号下可选）、封面按钮（显示当前封面来源，点击进封面选择）、复制到当前平台、推送、体检。用 Obsidian 原生控件
- 内容区是一个 `iframe`，`sandbox="allow-same-origin"`，`srcdoc` 由 `previewDocument` 生成，与网页版同一个预览壳；宽度就是侧栏宽度，用户拖动侧栏即可看窄屏效果
- 跟随当前笔记：监听 `active-leaf-change`、`editor-change`、`vault.modify`，500 毫秒防抖；每次排版取一份编辑器文本快照（含未保存的改动）；每次排版带递增的版本号，晚返回的旧结果丢弃；视图不可见时不排版
- 缺失图片显示占位块，视图底部列出无法解析的引用与找过的位置；core 的原文警告与知乎降级标注在预览末尾列出
- 公众号预览按配置显示开头结尾与名片占位块；知乎预览按知乎结构

## 6. 命令

命令面板暴露，均可绑定快捷键；只在当前活动文件是 Markdown 时可用：

| 命令 | 行为 |
|---|---|
| 锦章：打开预览 | 见第 5 节 |
| 锦章：推送到默认平台 | 按配置的 `targets` 推送当前笔记，走第 7 节流程 |
| 锦章：推送到公众号 / 推送到知乎 | 单平台推送 |
| 锦章：推送前体检 | 弹出体检结果 |
| 锦章：复制为公众号格式 / 复制为知乎格式 | 写剪贴板，见第 8 节 |
| 锦章：设置本文封面 | 见第 9 节 |
| 锦章：登录知乎 | 见第 11 节 |

## 7. 推送流程

1. 取当前笔记在编辑器里的文本（含未保存的改动）作为本次操作的快照；预处理、排版、体检、确认、推送都用这一份。推送中途再改稿不影响本次，下次推送读新内容
2. 体检逐平台进行（architecture.md 第 11 节）：列出每个平台的状态，阻塞的平台逐条写明原因与下一步动作。只要还有可执行的平台，就可以确认继续，被阻塞的平台留在结果里标为未执行，与 skill 第 4 节一致。例如没有封面的纯文字稿不能推公众号，但可以推知乎。公众号正文长度按 `htmlChars` 加每张图的地址预算预估
3. 确认弹窗：本次实际执行的平台与账号（因阻塞跳过的平台单独列出）、标题、封面缩略图、图片数、可见字数与接口正文字符数、开头结尾是否启用、创建还是更新哪份草稿。确认后才出站
4. 执行期间用通知报进度（上传图片 3/7、写入草稿）；同一篇笔记推送期间不允许重复触发
5. 结果弹窗：每个平台一行，成功给「打开草稿」（公众号跳后台草稿箱，知乎跳编辑页）与警告；失败给原因与下一步。结果不确定（创建草稿的请求超时或中断）时写明「先去草稿箱确认」，这篇下次推送时确认弹窗多一个必勾项「草稿箱里没有对应草稿」，对应命令行的 `--confirm-uncertain`。去看了发现草稿其实已经建好的，先在平台里删掉那份，再勾选重推。第一版不做「绑定已有草稿」的界面，等命令行实现 `drafts bind` 时放进共享实现，插件再加入口
6. 草稿映射、图片与封面缓存写回共享的 `state.json`，带账号标识，与命令行共用
7. 多平台逐个执行，一个平台失败不影响也不重发已成功的平台

同一篇笔记向同一平台投递时一次用一个入口；插件与命令行先后使用同一篇笔记，正常共享映射（architecture.md 第 9 节）。

## 8. 复制

复制粘贴兜底（需求 25），只含正文与启用的固定内容，封面在平台编辑器里单独设置：

- 公众号：图片按 `clipboard` 档规范化后内嵌为 data URL，与网页版相同。这部分放在 core 的 `./browser`，与网页版共用（architecture.md 第 5 节）
- 知乎：要求已登录，图片经知乎图片接口上传得到知乎地址后再复制（与命令行一致）；未登录时提示登录，或改用网页版（网页版走中转桶）
- 写入：`navigator.clipboard.write` 同时写 `text/html` 与成品可见文本；成功提示「已复制，请到平台编辑器粘贴后核对；封面请单独设置」
- 写入失败时，用本次 `placeImages` 的结果重建一个只含正文的视图（不含预览外壳、封面与原文行号属性）并全选，提示手动复制：公众号的图片是 data URL，知乎的是已上传的地址。不能直接全选预览，预览里的图片是 `blob:` 临时地址，粘到平台编辑器里无法访问。重试复制复用已上传的图片

## 9. 封面选择

- 「设置本文封面」打开选择弹窗：显示当前生效的封面（单独设置的图，或正文首图）；可在 vault 图片里模糊搜索选一张，或清除回到首图
- 选择按源文件绝对路径存进 `state.json` 的 `articles[path].cover`，值是图片的绝对路径，读取走第 3 节的磁盘分支；命令行推送同一篇时同样生效，命令行的 `--cover` 只作用于那一次
- 封面不做裁剪，公众号后台可以调整；预览壳里显示在标题下方

## 10. 设置页

| 分区 | 内容 |
|---|---|
| 公众号 | AppID、AppSecret（密码型输入，保存时写 `credentials.json`，界面只显示已设置）；「探测出口 IP」按钮与白名单后台路径；代理地址 |
| 知乎 | 登录状态与账号名、登录、退出（退出会清掉命令行也在用的这份登录态，提示里写明） |
| 排版 | 默认主题、默认推送平台、作者名（模板变量 `{{author}}`） |
| 固定内容（后面单独调整，本行先按现有设计） | 公众号与知乎各自的开头、结尾开关；名片字段（公众号 id、昵称、头像地址、简介）；四个模板（两个平台的开头、结尾）各一个多行编辑区，保存即写 `templates/` 下对应文件，满足需求 12「文案可在页面直接修改」；「打开模板目录」作为高级入口 |
| 高级 | 配置目录路径（只读，说明 `JINZHANG_HOME` 可改） |

除界面偏好外，设置读写的都是 `~/.config/jinzhang/` 里的文件；设置页打开时重新读取，与命令行的修改互通。

## 11. 知乎登录

- 弹窗里放一个 `<webview src="https://www.zhihu.com/signin" partition="persist:jinzhang-zhihu">`；地址变成 `https://www.zhihu.com/` 后，经 `@electron/remote` 取这个 webview 的会话读 cookie（Zhihu on Obsidian 的做法），校验 `z_c0`、`_xsrf`、`d_c0` 齐全后写 `zhihu-session.json`，再调 `/api/v4/me` 取用户名显示
- 独立的 `partition`，登录态不与 Obsidian 内置网页查看器混用；退出时清掉这个 partition 的 cookie
- 知乎要求滑动验证时用户就在 webview 里完成
- `webview` 或 `@electron/remote` 不可用时，弹窗退化为多行输入框，粘贴浏览器里复制的 cookie 串，解析规则与命令行相同

## 12. 分发

- BRAT 从 GitHub Release 的附件读取 `manifest.json`、`main.js`、`styles.css`，并按语义化版本号取最新的正式版或预发布版。所以本仓库的 GitHub Release 只用于插件：网页版按镜像发布、命令行发到 npm，都不建 GitHub Release
- 发布：tag 等于 `manifest.json` 的版本号，不带 `v`；GitHub Actions 在推 tag 时校验版本一致、构建、创建 Release 并上传三件套；`versions.json` 记录版本到 `minAppVersion` 的映射
- BRAT 用户填仓库地址 `AFreeCoder/jinzhang-md-publisher` 即可安装与更新；首个版本发布后，门户的插件卡片通过 `JINZHANG_OBSIDIAN_REPO` 显示这个地址
- 社区上架（二期）要求仓库根目录、默认分支上有插件的 `manifest.json`，Obsidian 按它判断最新版本。到时在「根目录放插件 manifest」与「单独建一个发布仓库」之间选，不影响第一版

## 13. 与需求的映射

| 需求 | 本文对应 |
|---|---|
| 2 封面图设置 | 9 |
| 5、6 预览 | 5 |
| 12、13、15 固定内容 | 10；固定内容后面单独调整，名片与 `:::recent` 样式按调整结论在 core 实现 |
| 16 推送时图片自动上传 | 7；架构见 architecture.md 第 5、8 节 |
| 18、19 一键推送 | 6、7 |
| 20 改稿重推 | 7 第 6 步 |
| 21 推送前确认 | 7 第 3 步 |
| 22 推送前体检 | 6、7 第 2 步，逐平台阻塞 |
| 23 推送结果可读 | 7 第 5 步 |
| 24 推送目标平台可配置 | 6、10 |
| 25 复制粘贴兜底 | 8 |
| 26 配置一次两处可用 | 3、10 |
| 27 白名单引导 | 10 |
| 28 知乎登录 | 11 |
| 31 Obsidian 插件 | 全文；私有写法见 4，BRAT 见 12 |
| 场景 S1、S3、S5、S6、S7 | 5 至 11 |

## 14. 待实测

1. 在插件弹窗里创建 `webview` 并经 `@electron/remote` 读 cookie，在作者本机 Obsidian 1.10 上是否可用；`minAppVersion` 按实测定，不低于 1.5.7
2. `requestUrl` 手工拼装的 multipart 在公众号 `uploadimg` 与 `add_material` 上是否通过（同类插件已证实，需在本项目复核）
3. `iframe srcdoc` 里的 `blob:` 图片在 `app://obsidian.md` 下能否显示
4. Canvas 规范化后的图片在 `platform` 档（长边 2000px、1MB）下的通过率
5. 渲染进程里 Node `https` 加代理 agent 调用公众号接口是否可用
6. architecture.md 第 12 节里需要真实账号的公众号与知乎接口实测（名片保留、合集链接、知乎 `PATCH` 写入与二次更新、限速等），随插件的投递实现一起做

## 15. 验收要点

按评审（issue #12）指出的风险点各验一次：

- 连续增删属性行时，正文不丢失，属性不进入成品
- 根目录与笔记目录下各有一份同名附件、嵌套目录、vault 外的绝对路径、共享状态里以绝对路径保存的封面，各解析一次，结果与 Obsidian 自己显示的一致
- 一个平台被阻塞时，另一个平台照常推送，结果里标出未执行的平台
- 主动让剪贴板写入失败，再手动复制、粘贴到平台编辑器并保存草稿，图片可见
- 创建草稿超时后按提示处理，不产生重复草稿

## 变更记录

- 2026-09-08 初稿，来源 issue #4
- 2026-09-30 重写：接线改为已实现的 core 接口（`VaultAssetResolver` 返回 `blob`、直接复用 `CanvasImageCodec`、`previewDocument` 显示封面）；明确插件是本地形态的第一个实现，投递、配置与状态、`:::card` 随插件落地，`./node` 不放 sharp；预处理增加属性区静默去掉与 `%%注释%%` 删除；复制改为公众号 data URL、知乎要求登录；分发按 BRAT 实际机制改写（Release 只用于插件，社区上架需根目录 manifest）；第一版不做同步滚动、手机宽度与模板实时预览。来源 issue #12
- 2026-09-30 合并 Codex 评审（issue #12）：属性区改为对编辑器文本调用 `getFrontMatterInfo`，一次操作只用一份文本快照；解析器按引用形式分支，补系统绝对路径，相对引用交给 `getFirstLinkpathDest`，嵌入图与 vault 外路径改写为 `jz-local://vault/…`、`jz-local://file/…` 以通过 core 的协议清理；体检逐平台阻塞；手动复制改用图片已归位的成品；结果不确定时第一版只提示在平台删掉重复草稿再重推，不做绑定界面（用户同意简化）；`requestUrl` 自包超时；`minAppVersion` 至少 1.5.7；固定内容标注后续单独调整；新增验收要点
- 2026-09-30 用户确认定稿，状态改为已评审，沉淀到仓库；两项跨壳调整回写 architecture.md 与 skill.md。来源 issue #12
