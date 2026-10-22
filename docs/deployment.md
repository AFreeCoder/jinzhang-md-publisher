# 锦章生产部署

目标为 silicon（硅谷，SSH 别名 `silicon`），域名 `https://jinzhang.ink`。腾讯云保留注册与续费，Cloudflare 托管权威 DNS。使用仅 DNS 的 A 记录指向 `49.51.206.62`；`www` 跳转到主域名。NS 为 `bob.ns.cloudflare.com`、`lucy.ns.cloudflare.com`。

## 架构与配置

宿主 Caddy 自动签发 HTTPS，转发到本机 `127.0.0.1:17622` 的 HAProxy，再到隔离 Docker 网络内 Next.js standalone 服务。Next.js 容器内存上限 1 GiB、CPU 上限 1 核；HAProxy 上限 128 MiB、0.25 核。应用不使用数据库。

`/home/work/online/jinzhang` 保存 Compose、HAProxy 配置和权限为 0600 的 `.env.production`。环境变量参考 `apps/web/.env.example`，生产 Origin 为 `https://jinzhang.ink`。OSS 使用北京地域专用私有桶 `jinzhang-md`，`transit/` 一天生命周期；原有本地开发 CORS 保留并增加生产 Origin。密钥不进入镜像、Git 或日志。

两个图片接口共用每 IP 每分钟 60 次、滚动 24 小时 1000 次限额。HAProxy 计数在代理内存中，重启会清零，不用于计费。Caddy 覆盖 `X-Real-IP` 防止外部伪造，网关端口仅本机可达。`complete` 后端最多两条并发连接，排队上限 8、等待最多 5 秒；超过容量返回失败，客户端可重试。Caddy 请求体上限 8 KiB，图片通过浏览器直传 OSS，不经过该请求体。

## 构建与发布

源码基线为 fetch 后的 `origin/main`。修改 Next.js / core 时运行 `pnpm check` 与 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`；Linux CI 使用 Chromium。部署脚本变更运行 `shellcheck deploy/release.sh scripts/deploy-ssh.sh`、`actionlint` 与 `python3 -B -m unittest discover -s tests/deploy -v`。这些隔离测试使用临时目录和 Docker/网络桩，不接触生产。

正式流程为 **Codex 开发与合入 → GitHub Actions 检查、构建、部署 → Codex 跟踪与验收**：

1. PR 和非 main 分支运行 `.github/workflows/check.yml`，执行应用构建、类型检查、单元测试、浏览器测试，以及部署脚本测试和工作流校验。
2. 合入 main 触发 `.github/workflows/image.yml` 的 `Build and Deploy`。先复用同一套 Check，全部成功后才构建 `linux/amd64` 镜像并推送 GHCR，标签为 `ghcr.io/afreecoder/jinzhang:sha-<完整提交>`。
3. 镜像构建成功后，`needs` 依赖自动调用 `.github/workflows/deploy.yml`（`Deploy to Silicon`）。构建输出的镜像 digest 直接传给部署任务，不通过可变标签猜测版本，也不需要 Codex 再发起部署。
4. Actions 调用 `scripts/deploy-ssh.sh`，通过已校验主机密钥的 SSH 上传该提交的部署文件，调用服务器上的临时 `deploy/release.sh`。源码 checkout、镜像 revision、本机和公网健康接口都必须对应本次完整 SHA。

手动重发使用 `Build and Deploy` 的 `workflow_dispatch`，选择 main，仍完整执行检查、构建、部署。非 main 的手动运行不会发布；`deploy.yml` 只允许内部复用，不能手动绕过检查。Obsidian 的 tag 发布仍独立，只生成插件 Release，不触发网站部署。

部署使用 GitHub 的 `jinzhang-production` 并发组，不取消正在进行的发布；服务器另外持有 `/home/work/online/jinzhang/.release.lock`。SSH 前以及服务器持锁后的镜像预检前后都会核对远端 main；过期版本跳过，查询失败则停止。跳过发布不代表该 SHA 已上线，Codex 必须核对实际健康版本。

## 首次启用

合入自动部署改造前，在锦章仓库配置以下 Actions secrets；部署环境准备就绪后再合入，合入本身会触发生产发布：

| Secret | 用途 |
| --- | --- |
| `SILICON_HOST` | silicon 的 SSH 地址；连接用户固定为 `work`，端口 `22222` |
| `SILICON_SSH_PRIVATE_KEY` | 已允许登录该用户的部署私钥 |
| `SILICON_SSH_KNOWN_HOSTS` | 经可信渠道核对的 `[主机]:22222` known_hosts 记录 |

主机密钥必须先与现有可信 SSH 记录或服务器控制台核对，不能把未经验证的 `ssh-keyscan` 输出直接作为信任依据。缺少凭据或主机密钥不匹配时部署失败，不降级关闭校验。

服务器需有 Bash、Git、Docker Compose、Python 3、curl、flock，能访问 GitHub/GHCR，并保留健康的现有锦章实例和部署目录。`work` 需可管理 Docker、写入部署与备份目录、读取 Caddyfile。此流程用于现有站点升级，不负责首次装机。拉取 GHCR 使用任务的临时 `GITHUB_TOKEN`（`packages: read`），经 SSH 标准输入传入；Docker 登录目录位于私有临时目录，退出时删除，不需要长期 GHCR PAT。包需允许本仓库 Actions 读取。

`.env.production` 继续仅存服务器，应用密钥不进入 GitHub、镜像或日志。首页静态内容的 `JINZHANG_SKILL_INSTALL` 取自仓库 Actions 变量，在镜像构建时注入，写到服务器环境文件无效；修改后在 main 手动运行完整发布流水线或等待下一次 main 推送。插件安装包从同一提交构建，推 tag 后需要发布包含对应版本的网站镜像才会更新下载。

## 服务器执行与备份

`deploy/release.sh` 先核对当前容器、`.env` 的旧镜像和健康版本一致，拉取新镜像并核对 revision，再在私有临时目录校验 Compose 与 HAProxy 配置。预检失败不会替换现有应用。

变更生效前，将 `.env`、已有的 `.env.previous`、`.env.production`、Compose、HAProxy 配置及宿主 Caddyfile 备份到 `/home/work/backups/jinzhang/<时间>-<提交前缀>.<随机后缀>/`，核对关键文件副本一致。目录权限 0700，文件 0600；`release.txt` 保存新旧 SHA 和镜像引用。备份失败停止发布，备份只留服务器，不上传 Actions artifact；当前不自动删除历史备份或镜像。

随后复制候选 Compose/HAProxy 配置，写入新 digest，并通过 `docker compose up -d --force-recreate --wait --wait-timeout 120 web gateway` 更新两个服务。必须重新创建 gateway 才能确保挂载的 HAProxy 新配置生效。本次保留单实例架构，替换容器时可能短暂不可用，网关重建也会清空内存限流计数；没有引入 GPT101 的双槽位切流。

正常发布不修改或 reload 宿主 Caddy。首次装机的站点片段见 `deploy/Caddyfile`，需另外备份完整配置、执行 `caddy validate` 后 reload，保留其他站点。

## 验收与恢复

流水线自动核验本机和公网 `/api/health`：`status=ready`、`transitConfigured=true`、`revision` 与目标 SHA 一致，并检查 `/`、`/format`、`/obsidian` 可访问。全部通过才更新 `.env.previous` 并报告部署成功。

Codex 通过 GitHub Actions 跟踪检查、构建和部署任务，失败时定位实际步骤；上线后核对健康版本和本次变更相关业务。健康接口不代替 OSS 连通性验收。公开首页、工作区、插件教程与安装包下载、静态资源和域名跳转应正常；涉及图片或网关改动时还需验证签名 → OSS 上传 → 服务端校验 → 签名读取、无效图片拒绝、429 与限额恢复，以及浏览器排版与复制。

替换开始后的启动、版本或页面检查失败时，脚本自动恢复本次备份中的旧 `.env`、Compose 与 HAProxy 配置，重新创建旧服务并核对旧版本健康。即使恢复成功，Actions 仍报告失败，不能把回退当作本次发布成功。恢复也失败时，日志明确指出备份位置，需进一步处理。断电、强制杀进程等无法执行脚本的情况需使用保留的备份恢复。

人工恢复也必须持有同一把 `.release.lock`，从发布日志选定备份目录，恢复其中的 `.env`、`compose.yaml`、`haproxy.cfg`，再执行上述 Compose 更新命令；核对本机和公网健康版本为 `release.txt` 中的 `previous_revision`。不要将备份的整个共享 Caddyfile直接覆盖回去，因为发布脚本没有更改它。通过 `docker compose ps`、`docker compose logs --tail=80`、`docker stats --no-stream` 补充检查状态。

源码合入后在干净的本地 main 工作区执行 `git merge --ff-only origin/main` 并核对 SHA。首次上线的过程、发布 SHA 与 digest、备份位置和验收结果记录于 [Issue #7](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/7)；之后每次发布记在对应的变更 Issue（如 [#9](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/9)）。

自动发布链路改造及首次启用记录见 [Issue #35](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/35)。
