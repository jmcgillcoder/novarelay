#!/usr/bin/env bash
# NovaRelay offline backup / integrity verification / guarded restore.
# Never upload these archives: they contain 139 web sessions and keys.
set -Eeuo pipefail
APP_DIR="${APP_DIR:-/opt/novarelay}"
NATIVE="$APP_DIR/native"
BACKUPS="$APP_DIR/backups"
DATA="$NATIVE/data"
COMPOSE=(docker compose -f "$NATIVE/compose.yml")
umask 077
usage(){ echo "Usage: $0 create | verify FILE | restore FILE --confirm" >&2; exit 2; }
verify(){
  local archive="$1" entry
  [[ -f "$archive" && -s "$archive" ]] || { echo '备份不存在或为空' >&2; return 1; }
  tar -tzf "$archive" >/dev/null
  # Do not extract symlinks, hardlinks, devices or special files from an archive.
  # Even a valid relative path may otherwise resolve outside the data directory.
  while IFS= read -r detail; do
    case "${detail:0:1}" in
      -|d) ;;
      *) echo '备份含有危险的链接或特殊文件' >&2;return 1;;
    esac
  done < <(tar -tvzf "$archive")
  while IFS= read -r entry; do
    case "$entry" in
      native/.env|native/data|native/data/|native/data/*) ;;
      *) echo "备份中包含非预期路径：$entry" >&2; return 1;;
    esac
    [[ "$entry" != *'/../'* && "$entry" != ../* && "$entry" != /* ]] || return 1
  done < <(tar -tzf "$archive")
  tar -tzf "$archive" | grep -x 'native/.env' >/dev/null || { echo '备份缺少 .env' >&2; return 1; }
  tar -tzf "$archive" | grep -E '^native/data(/|$)' >/dev/null || { echo '备份缺少数据目录' >&2; return 1; }
  echo '备份完整性校验通过（仅验证结构和压缩包，不验证会话可登录）'
}
[[ $# -ge 1 ]] || usage
case "$1" in
  verify) [[ $# == 2 ]] || usage;verify "$2";exit 0;;
  create|restore) [[ "$(id -u)" == 0 ]] || { echo '创建/恢复备份需要 root' >&2;exit 1;};;
  *)usage;;
esac
[[ -f "$NATIVE/.env" && -d "$DATA" ]] || { echo '未找到项目配置和数据目录' >&2;exit 1; }
mkdir -p "$BACKUPS";chmod 700 "$BACKUPS"
exec 9>/run/lock/novarelay-update.lock
flock -n 9 || { echo '升级正在执行，备份操作已拒绝' >&2;exit 75; }
create_snapshot(){
  local prefix="$1" outfile
  outfile="$BACKUPS/${prefix}-$(date -u +%Y%m%d-%H%M%S)-$$.tar.gz"
  tar -czf "$outfile" -C "$APP_DIR" --exclude='native/data/update-request.json' --exclude='native/data/update-inflight.json' native/.env native/data
  chmod 600 "$outfile"
  verify "$outfile" >/dev/null
  echo "$outfile"
}
if [[ "$1" == create ]];then
  [[ $# == 1 ]] || usage
  "${COMPOSE[@]}" stop gateway
  trap '"${COMPOSE[@]}" up -d --no-build --no-deps gateway >/dev/null || true' EXIT
  created="$(create_snapshot manual)"
  printf '已完成：%s\n' "$created"
  exit 0
fi
[[ $# == 3 && "$3" == --confirm ]] || usage
archive="$(realpath "$2")"
verify "$archive" >/dev/null
"${COMPOSE[@]}" stop gateway
trap '"${COMPOSE[@]}" up -d --no-build --no-deps gateway >/dev/null || true' EXIT
before="$(create_snapshot before-restore)"
printf '恢复前快照：%s\n' "$before"
# Keep failed data and restore only approved archive members.
mv "$DATA" "${DATA}.before-restore-$(date -u +%Y%m%d%H%M%S)"
tar -xzf "$archive" -C "$APP_DIR" --no-same-owner
chown -R 10001:10001 "$DATA"
chmod 700 "$DATA"
chmod 600 "$NATIVE/.env"
echo '数据已恢复；正在启动旧镜像。请自行检查 /healthz、登录和账号状态。'
