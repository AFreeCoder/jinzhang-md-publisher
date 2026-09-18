# 锦章生产部署

目标为 silicon（硅谷，SSH 别名 `silicon`），域名 `https://jinzhang.ink`。腾讯云保留注册与续费，Cloudflare 托管权威 DNS。使用仅 DNS 的 A 记录指向 `49.51.206.62`；`www` 跳转到主域名。NS 为 `bob.ns.cloudflare.com`、`lucy.ns.cloudflare.com`。

## 架构与配置

宿主 Caddy 自动签发 HTTPS，转发到本机 `127.0.0.1:17622` 的 HAProxy，再到隔离 Docker 网络内 Next.js standalone 服务。Next.js 容器内存上限 1 GiB、CPU 上限 1 核；HAProxy 上限 128 MiB、0.25 核。应用不使用数据库。

`/home/work/online/jinzhang` 保存 Compose、HAProxy 配置和权限为 0600 的 `.env.production`。环境变量参考 `apps/web/.env.example`，生产 Origin 为 `https://jinzhang.ink`。OSS 使用北京地域专用私有桶 `jinzhang-md`，`transit/` 七天生命周期；原有本地开发 CORS 保留并增加生产 Origin。密钥不进入镜像、Git 或日志。

两个图片接口共用每 IP 每分钟 60 次、滚动 24 小时 1000 次限额。HAProxy 计数在代理内存中，重启会清零，不用于计费。Caddy 覆盖 `X-Real-IP` 防止外部伪造，网关端口仅本机可达。`complete` 后端最多两条并发连接，排队上限 8、等待最多 5 秒；超过容量返回失败，客户端可重试。Caddy 请求体上限 8 KiB，图片通过浏览器直传 OSS，不经过该请求体。

## 构建与发布

源码基线为 fetch 后的 `origin/main`。修改 Next.js / core 时运行 `pnpm check` 与 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`；Linux CI 使用 Chromium。原有 Check 工作流必须成功。

`.github/workflows/image.yml` 在 main 或初次部署分支推送时构建 Linux 镜像，标签为 `ghcr.io/afreecoder/jinzhang:sha-<完整提交>`；生产按镜像 digest 部署。流水线仅构建，不自动改动服务器。

发布时先备份部署目录（包含私密环境文件，备份保持 0700/0600）与 `/etc/caddy/Caddyfile`，记录旧镜像 digest。核对新镜像标签中的 revision 与候选提交一致，并先验证 HAProxy 配置：

```sh
cd /home/work/online/jinzhang
# .env 中仅保存 JINZHANG_IMAGE=ghcr.io/afreecoder/jinzhang@sha256:...
docker compose config --quiet
docker compose pull
docker compose run --rm --no-deps gateway haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg
docker compose up -d --wait
curl -fsS http://127.0.0.1:17622/api/health
```

Caddy 站点片段见 `deploy/Caddyfile`。首次部署在完整配置备份后加入；`sudo caddy validate --config /etc/caddy/Caddyfile` 通过才 `sudo systemctl reload caddy`，不得覆盖其他站点。

## 验收与恢复

`/api/health` 返回实际 `APP_REVISION` 和配置齐备状态；它不代替 OSS 连通性验收。公开首页、工作区、静态资源、HTTP 到 HTTPS、www 到主域名跳转都必须正常。需验证真实图片签名 → OSS 上传 → 服务端完整校验 → 签名读取、无效图片拒绝、429 与限额恢复，以及浏览器排版与复制。

通过 `docker compose ps`、`docker compose logs --tail=80`、`docker stats --no-stream` 检查状态。保留上一镜像及配置备份；升级失败时恢复 `.env` 中旧 digest 和对应 Compose/HAProxy 配置再 `docker compose up -d --wait`。首次上线无旧应用可回滚时，移除仅本次新增的 Caddy 站点并验证后 reload，再停止本项目容器；保留其他站点配置。DNS 可恢复原 DNSPod NS，但传播并非即时。

源码合入后在干净的本地 main 工作区执行 `git merge --ff-only origin/main` 并核对 SHA。过程、具体发布 SHA/digest、备份位置和验收结果记录于 [Issue #7](https://github.com/AFreeCoder/jinzhang-md-publisher/issues/7)。
