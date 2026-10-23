#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

image="${1:?需要镜像 digest}"
revision="${2:?需要完整提交 SHA}"
registry_user="${3:-}"
[[ "$image" =~ ^ghcr\.io/afreecoder/jinzhang@sha256:[a-f0-9]{64}$ ]] || { echo '必须使用锦章镜像的 digest' >&2; exit 1; }
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo '提交 SHA 无效' >&2; exit 1; }
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="${JINZHANG_DEPLOY_DIR:-/home/work/online/jinzhang}"
backup_root="${JINZHANG_BACKUP_ROOT:-/home/work/backups/jinzhang}"
caddy_config="${JINZHANG_CADDY_CONFIG:-/etc/caddy/Caddyfile}"
public_origin="${JINZHANG_PUBLIC_ORIGIN:-https://jinzhang.ink}"
local_origin="${JINZHANG_LOCAL_ORIGIN:-http://127.0.0.1:17622}"

for command in docker python3 curl git flock; do command -v "$command" >/dev/null; done
test "$source_dir" != "$deploy_dir"
for file in .env .env.production compose.yaml haproxy.cfg; do test -f "$deploy_dir/$file"; done
test -r "$caddy_config"
exec 9>"$deploy_dir/.release.lock"
flock -n 9 || { echo '已有锦章发布或恢复正在执行' >&2; exit 1; }

is_current() {
  local latest
  latest="$(git ls-remote --exit-code https://github.com/AFreeCoder/jinzhang-md-publisher.git refs/heads/main | awk '{print $1}')" || return 1
  [[ "$latest" =~ ^[a-f0-9]{40}$ ]] || return 1
  if [[ "$latest" != "$revision" ]]; then
    echo "跳过过期发布: ${revision}；main 已更新为 $latest"
    exit 0
  fi
}
compose() { docker compose --project-directory "$deploy_dir" -f "$deploy_dir/compose.yaml" "$@"; }
probe() {
  curl -fsS --connect-timeout 5 --max-time 10 "$1/api/health" |
    python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status")=="ready" and d.get("transitConfigured") is True and d.get("revision")==sys.argv[1] else 1)' "$2"
}
wait_ready() {
  local attempt
  for attempt in {1..12}; do
    if probe "$1" "$2"; then return 0; fi
    if [[ "$attempt" -lt 12 ]]; then sleep 2; fi
  done
  return 1
}

is_current
old_image="$(sed -n 's/^JINZHANG_IMAGE=//p' "$deploy_dir/.env")"
[[ "$old_image" =~ ^ghcr\.io/afreecoder/jinzhang@sha256:[a-f0-9]{64}$ ]] || { echo '旧镜像引用无效' >&2; exit 1; }
container="$(compose ps -q web)"
test -n "$container"
test "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$old_image"
old_revision="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")"
[[ "$old_revision" =~ ^[a-f0-9]{40}$ ]] || { echo '旧镜像版本无效' >&2; exit 1; }
probe "$local_origin" "$old_revision"

candidate="$(mktemp -d "$deploy_dir/.candidate.XXXXXXXX")"
trap 'rm -rf -- "$candidate"' EXIT
if [[ -n "$registry_user" ]]; then
  export DOCKER_CONFIG="$candidate/docker-auth"
  mkdir -m 700 "$DOCKER_CONFIG"
  docker login ghcr.io --username "$registry_user" --password-stdin
fi
docker pull "$image"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
cp "$source_dir/compose.yaml" "$source_dir/haproxy.cfg" "$candidate/"
# HAProxy 以非 root 用户读取挂载配置；密钥文件和临时目录仍保持私有权限。
chmod 644 "$candidate/haproxy.cfg"
cp "$deploy_dir/.env.production" "$candidate/.env.production"
printf 'JINZHANG_IMAGE=%s\n' "$image" > "$candidate/.env"
docker compose --project-directory "$candidate" -f "$candidate/compose.yaml" config --quiet
docker compose --project-directory "$candidate" -f "$candidate/compose.yaml" run --rm --no-deps --entrypoint haproxy gateway -c -f /usr/local/etc/haproxy/haproxy.cfg

# 下载和预检可能耗时，持锁状态下再次排除过期版本。
is_current
mkdir -p "$backup_root"
backup="$(mktemp -d "$backup_root/$(date +%Y%m%d-%H%M%S)-${revision:0:12}.XXXXXXXX")"
for file in .env .env.production compose.yaml haproxy.cfg; do
  cp "$deploy_dir/$file" "$backup/$file"
  cmp -s "$deploy_dir/$file" "$backup/$file"
done
if [[ -f "$deploy_dir/.env.previous" ]]; then
  cp "$deploy_dir/.env.previous" "$backup/.env.previous"
  cmp -s "$deploy_dir/.env.previous" "$backup/.env.previous"
fi
cp "$caddy_config" "$backup/Caddyfile"
cmp -s "$caddy_config" "$backup/Caddyfile"
printf 'previous_image=%s\nprevious_revision=%s\nimage=%s\nrevision=%s\n' "$old_image" "$old_revision" "$image" "$revision" > "$backup/release.txt"
chmod 600 "$backup/"* "$backup/.env" "$backup/.env.production"
echo "部署前备份: $backup"

recover() {
  local result=$?
  trap - ERR HUP INT TERM
  echo "部署失败（状态 ${result}），恢复 ${old_revision}；备份: $backup" >&2
  if cp "$backup/.env" "$deploy_dir/.env" &&
     cp "$backup/compose.yaml" "$deploy_dir/compose.yaml" &&
     cp "$backup/haproxy.cfg" "$deploy_dir/haproxy.cfg" &&
     chmod 644 "$deploy_dir/haproxy.cfg" &&
     compose up -d --force-recreate --wait --wait-timeout 120 web gateway &&
     wait_ready "$local_origin" "$old_revision" &&
     wait_ready "$public_origin" "$old_revision"; then
    echo "旧版本已恢复: $old_revision" >&2
  else
    echo "自动恢复未通过，请检查锦章容器和备份: $backup" >&2
  fi
  if [[ -f "$backup/.env.previous" ]]; then
    cp "$backup/.env.previous" "$deploy_dir/.env.previous"
  else
    rm -f "$deploy_dir/.env.previous"
  fi
  exit 1
}
trap recover ERR HUP INT TERM
cp "$candidate/compose.yaml" "$deploy_dir/compose.yaml"
cp "$candidate/haproxy.cfg" "$deploy_dir/haproxy.cfg"
chmod 644 "$deploy_dir/haproxy.cfg"
cp "$candidate/.env" "$deploy_dir/.env"
compose up -d --force-recreate --wait --wait-timeout 120 web gateway
wait_ready "$local_origin" "$revision"
wait_ready "$public_origin" "$revision"
for path in / /format /obsidian; do
  curl -fsS --connect-timeout 5 --max-time 20 -o /dev/null "$public_origin$path"
done
cp "$backup/.env" "$deploy_dir/.env.previous"
trap - ERR HUP INT TERM
trap 'rm -rf -- "$candidate"' EXIT
echo "部署成功: $revision ($image)；回退备份: $backup"
