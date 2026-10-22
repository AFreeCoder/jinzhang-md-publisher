#!/usr/bin/env bash
# 远端参数有意在本地展开；路径严格校验，其余参数通过 printf %q 转义。
# shellcheck disable=SC2029
set -Eeuo pipefail
umask 077

for name in DEPLOY_REVISION DEPLOY_IMAGE SILICON_HOST SILICON_SSH_PRIVATE_KEY SILICON_SSH_KNOWN_HOSTS GHCR_TOKEN GITHUB_ACTOR; do
  test -n "${!name:-}" || { echo "缺少部署参数: $name" >&2; exit 1; }
done
[[ "$DEPLOY_REVISION" =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ "$DEPLOY_IMAGE" =~ ^ghcr\.io/afreecoder/jinzhang@sha256:[a-f0-9]{64}$ ]] || exit 1
[[ "$SILICON_HOST" =~ ^[a-zA-Z0-9.-]+$ ]] || exit 1
test "$(git rev-parse HEAD)" = "$DEPLOY_REVISION"
latest="$(git ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
if [[ "$latest" != "$DEPLOY_REVISION" ]]; then
  echo "跳过过期发布: ${DEPLOY_REVISION}；main 已更新为 $latest"
  exit 0
fi

ssh_dir="$(mktemp -d)"
remote_dir=''
cleanup() {
  if [[ -n "$remote_dir" ]]; then
    ssh "${ssh_options[@]}" "work@$SILICON_HOST" "rm -rf -- '$remote_dir'" || true
  fi
  rm -rf -- "$ssh_dir"
}
trap cleanup EXIT
printf '%s\n' "$SILICON_SSH_PRIVATE_KEY" > "$ssh_dir/key"
printf '%s\n' "$SILICON_SSH_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
ssh_options=(-i "$ssh_dir/key" -p 22222 -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_dir/known_hosts"
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3)
remote_dir="$(ssh "${ssh_options[@]}" "work@$SILICON_HOST" 'umask 077; mktemp -d /home/work/online/.jinzhang-release.XXXXXXXX')"
if [[ ! "$remote_dir" =~ ^/home/work/online/\.jinzhang-release\.[a-zA-Z0-9]+$ ]]; then
  remote_dir=''
  echo '服务器返回了无效临时目录，停止部署' >&2
  exit 1
fi
tar -czf - deploy | ssh "${ssh_options[@]}" "work@$SILICON_HOST" "tar -xzf - -C '$remote_dir'"
printf -v remote_command 'bash %q %q %q %q' "$remote_dir/deploy/release.sh" "$DEPLOY_IMAGE" "$DEPLOY_REVISION" "$GITHUB_ACTOR"
# Token 仅经标准输入传递，远端临时 Docker 登录目录在退出时删除。
printf '%s' "$GHCR_TOKEN" | ssh "${ssh_options[@]}" "work@$SILICON_HOST" "$remote_command"
