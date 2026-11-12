#!/usr/bin/env bash
# Host-only updater. NEVER mount docker.sock into the web container.
# The Docker image can read its own source even when Git checked files out with umask 077.
set -Eeuo pipefail
APP_DIR=/opt/novarelay
NATIVE="$APP_DIR/native"
DATA="$NATIVE/data"
REQ="$DATA/update-request.json"
INFLIGHT="$DATA/update-inflight.json"
STATUS="$DATA/update-status.json"
DEPLOYED="$DATA/deployed-version.json"
BACKUPS="$APP_DIR/backups"
LOCK=/run/lock/novarelay-update.lock
COMPOSE=(docker compose -f "$NATIVE/compose.yml")
umask 077
exec 9>"$LOCK"
flock -n 9 || { echo '当前已有更新正在执行，拒绝并发升级' >&2; exit 75; }
if [[ ! -f "$REQ" && -f "$INFLIGHT" ]]; then
  # Never claim success after a host crash. Leave data intact and require an operator check.
  last_modified="$(stat -c %Y "$INFLIGHT")"
  if (( $(date +%s) - last_modified > 1200 )); then
    printf '{"state":"error","step":"interrupted","progress":100,"message":"更新服务意外中断，请检查日志并手动恢复","updatedAt":"%s"}\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$STATUS"
    chown 10001:10001 "$STATUS";chmod 600 "$STATUS"
  fi
fi
[ -f "$REQ" ] || exit 0
mv -- "$REQ" "$INFLIGHT"
old='' old_image='' old_version='' backup='' stopped=0 backup_complete=0
step='preflight'
write_status(){
  local state="$1" progress="$2" description="$3"
  # All values are fixed, internal text; never store untrusted exception strings in JSON.
  printf '{"state":"%s","step":"%s","progress":%s,"message":"%s","updatedAt":"%s"}\n' \
    "$state" "$step" "$progress" "$description" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$STATUS.tmp"
  chown 10001:10001 "$STATUS.tmp"
  chmod 600 "$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"
}
check_health(){
  local wanted="$1" body code
  for _ in $(seq 1 30); do
    body="$(curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:8323/healthz 2>/dev/null || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 http://127.0.0.1:8323/console/api/session 2>/dev/null || true)"
    if [[ "$body" == *'"ok":true'* && "$body" == *"\"version\":\"$wanted\""* && "$code" == 200 ]]; then return 0; fi
    sleep 2
  done
  return 1
}
rollback(){
  trap - ERR
  step=rollback
  write_status rollback 85 '部署未通过检查，正在恢复旧版'
  cd "$APP_DIR"
  if [[ -n "$old" ]]; then git reset --hard "$old" >/dev/null || true; fi
  if [[ "$stopped" == 1 ]]; then
    "${COMPOSE[@]}" stop gateway >/dev/null 2>&1 || true
    if [[ "$backup_complete" == 1 && -n "$backup" && -f "$backup" ]]; then
      # Preserve a copy of the failed data for diagnostics; restore the coherent stopped snapshot.
      mv "$DATA" "${DATA}.failed-$(date -u +%Y%m%d%H%M%S)" || true
      tar -xzf "$backup" -C "$APP_DIR" || true
    fi
    if [[ -n "$old_image" ]]; then
      docker image tag "$old_image" novarelay-gateway:latest || true
      "${COMPOSE[@]}" up -d --no-build --no-deps --force-recreate gateway || true
    fi
    # Never report a successful rollback unless the previous HTTP version responds.
    if [[ -n "$old_version" ]] && ! check_health "$old_version"; then
      write_status error 100 '回滚后健康检查未通过，请手动检查日志与备份'
      rm -f -- "$INFLIGHT"
      exit 1
    fi
  fi
  step=rollback
  write_status error 100 '更新失败；已尝试回滚旧版并恢复备份，请查看主机更新服务日志'
  rm -f -- "$INFLIGHT"
  exit 1
}
trap rollback ERR
step=preflight
write_status running 5 '检查 GitHub 源码和服务器环境'
cd "$APP_DIR"
[[ -d .git && "$(git branch --show-current)" == main ]] || { step=preflight; write_status error 100 '部署目录不是 main 分支'; rm -f "$INFLIGHT"; exit 1; }
case "$(git remote get-url origin)" in
  https://github.com/jmcgillcoder/novarelay.git|https://github.com/jmcgillcoder/novarelay) ;;
  *) write_status error 100 '仓库来源未在允许列表中'; rm -f "$INFLIGHT"; exit 1;;
esac
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { write_status error 100 '检测到源码本地修改，未执行更新'; rm -f "$INFLIGHT"; exit 1; }
old="$(git rev-parse HEAD)"
old_version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$NATIVE/package.json" | head -n 1)"
old_image="$(docker inspect -f '{{.Image}}' novarelay 2>/dev/null || true)"
[[ -n "$old_image" ]] || { write_status error 100 '找不到当前运行的 novarelay 容器'; rm -f "$INFLIGHT"; exit 1; }
git fetch --depth=100 origin main
git merge-base --is-ancestor "$old" FETCH_HEAD || { write_status error 100 'Git 历史不支持快进更新'; rm -f "$INFLIGHT"; exit 1; }
new="$(git rev-parse FETCH_HEAD)"
if [[ "$old" == "$new" ]]; then step=done;write_status success 100 '当前已是最新版';rm -f "$INFLIGHT";exit 0;fi
# Preserve the old image by content ID: tag before Compose overwrites :latest.
docker image tag "$old_image" "novarelay-rollback:${old:0:12}"
step=build
write_status running 24 '正在构建新版镜像；旧服务继续运行'
git merge --ff-only FETCH_HEAD
# Non-root readability is validated inside Dockerfile (including vendor code).
"${COMPOSE[@]}" build gateway
expected="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$NATIVE/package.json" | head -n 1)"
[[ -n "$expected" ]] || { echo 'Version missing from package.json' >&2; false; }
step=backup
write_status running 50 '正在暂停服务并制作一致性备份'
"${COMPOSE[@]}" stop gateway
stopped=1
mkdir -p "$BACKUPS"
chmod 700 "$BACKUPS"
backup="$BACKUPS/pre-update-$(date -u +%Y%m%d-%H%M%S)-${old:0:12}.tar.gz"
# Save accounts, keys, pricing and login secrets. Existing backups are not inside this archive.
tar -czf "$backup" -C "$APP_DIR" --exclude='native/data/update-request.json' --exclude='native/data/update-inflight.json' native/.env native/data
chmod 600 "$backup"
# Verify compressed contents before the only copy of the live data is replaced.
"$NATIVE/scripts/backup.sh" verify "$backup" >/dev/null
backup_complete=1
# Keep the 5 newest backups (no deletion unless this update succeeds).
step=restart
write_status running 70 '正在启动新容器并重新连接 API'
"${COMPOSE[@]}" up -d --no-build --no-deps gateway
step=verify
write_status running 83 '正在检查版本号和管理 API'
check_health "$expected"
step=done
printf '{"sha":"%s","at":"%s","version":"%s"}\n' "$new" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$expected" > "$DEPLOYED.tmp"
chown 10001:10001 "$DEPLOYED.tmp";chmod 600 "$DEPLOYED.tmp";mv -f "$DEPLOYED.tmp" "$DEPLOYED"
write_status success 100 '新版本已启动并通过健康检查'
rm -f "$INFLIGHT"
find "$BACKUPS" -maxdepth 1 -type f -name 'pre-update-*.tar.gz' -printf '%T@ %p\n' | sort -rn | tail -n +6 | cut -d' ' -f2- | while IFS= read -r stale;do rm -f -- "$stale";done
trap - ERR
