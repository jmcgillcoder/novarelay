#!/usr/bin/env bash
# NovaRelay; independent installation, never mutates /opt/mailbridge-ai.
set -Eeuo pipefail
APP_DIR="${APP_DIR:-/opt/novarelay}"
REPO_URL="${REPO_URL:-https://github.com/jmcgillcoder/novarelay.git}"
BRANCH="${BRANCH:-main}"
[[ "$(id -u)" == 0 ]] || { echo '请使用 root 执行安装或升级' >&2;exit 1; }
for cmd in git openssl docker curl flock tar; do command -v "$cmd" >/dev/null || { echo "缺少依赖：$cmd" >&2;exit 1; };done
docker compose version >/dev/null 2>&1 || { echo '请安装 Docker Compose v2' >&2;exit 1; }
[[ "$BRANCH" == main ]] || { echo '自动更新仅支持 main 分支' >&2;exit 1; }
install_updater(){
  [[ "$(realpath "$APP_DIR")" == /opt/novarelay ]] || { echo '非标准目录，跳过网页更新服务';return 0; }
  if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]];then
    echo '没有 systemd，网页更新禁用；可以通过此安装脚本更新';return 0
  fi
  cat >/etc/systemd/system/novarelay-updater.service <<'UNIT'
[Unit]
Description=NovaRelay restricted main-branch updater
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/novarelay/native/scripts/host-update.sh
TimeoutStartSec=1200
UMask=0077
UNIT
  cat >/etc/systemd/system/novarelay-updater.path <<'UNIT'
[Unit]
Description=Watch authorized NovaRelay update requests
[Path]
PathExists=/opt/novarelay/native/data/update-request.json
Unit=novarelay-updater.service
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now novarelay-updater.path
  touch "$APP_DIR/native/data/host-updater-enabled"
  chown 10001:10001 "$APP_DIR/native/data/host-updater-enabled"
  chmod 600 "$APP_DIR/native/data/host-updater-enabled"
}
if [[ -d "$APP_DIR/.git" ]];then
  [[ "$(realpath "$APP_DIR")" == /opt/novarelay ]] || { echo '自动升级仅支持默认安装目录' >&2;exit 1; }
  case "$(git -C "$APP_DIR" remote get-url origin)" in
    https://github.com/jmcgillcoder/novarelay.git|https://github.com/jmcgillcoder/novarelay) ;;
    *) echo '拒绝从未绑定的仓库自动升级' >&2;exit 1;;
  esac
  echo '[升级] 获取固定仓库的最新主机更新脚本'
  git -C "$APP_DIR" fetch --depth=100 origin main
  TMP="$(mktemp /tmp/novarelay-update.XXXXXX)"
  trap 'rm -f "$TMP"' EXIT
  git -C "$APP_DIR" show FETCH_HEAD:native/scripts/host-update.sh >"$TMP"
  chmod 700 "$TMP"
  if [[ -f "$APP_DIR/native/data/update-inflight.json" ]];then echo '已有更新正在执行，请勿覆盖' >&2;exit 1;fi
  systemctl stop novarelay-updater.path 2>/dev/null || true
  if [[ ! -f "$APP_DIR/native/data/update-request.json" ]];then
    printf '{"action":"update_main","requestedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$APP_DIR/native/data/update-request.json"
    chown 10001:10001 "$APP_DIR/native/data/update-request.json"
  fi
  if /bin/bash "$TMP";then
    install_updater
    echo '升级成功'; exit 0
  else
    install_updater
    echo '升级失败；请检查备份及主机更新日志' >&2;exit 1
  fi
fi
[[ ! -e "$APP_DIR" ]] || { echo "目标路径已存在但不是 Git 仓库：$APP_DIR" >&2;exit 1; }
echo '[1/5] 获取独立仓库（不会覆盖旧项目）'
mkdir -p "$(dirname "$APP_DIR")"
git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
cd "$APP_DIR/native"
umask 077
printf 'MASTER_KEY=%s\nHOST=127.0.0.1\nPORT=8323\nCOOKIE_SECURE=1\nPRICE_AUTO_SYNC=1\n' "$(openssl rand -hex 32)" > .env
mkdir -p data
chown 10001:10001 data
chmod 700 data
chmod 600 .env
echo '[2/5] 构建隔离镜像'
docker compose build gateway
echo '[3/5] 初始化管理员密码（仅显示这一次）'
docker compose run --rm gateway node scripts/bootstrap-admin.mjs
echo '[4/5] 启动'
docker compose up -d --no-deps gateway
found=0
for i in $(seq 1 30);do
  if curl -fsS --max-time 2 http://127.0.0.1:8323/healthz | grep -q '"ok":true';then found=1;break;fi
  sleep 2
done
[[ "$found" == 1 ]] || { echo '新服务健康检查失败，未修改旧 MailBridge AI；请检查新容器日志' >&2;exit 1; }
echo '[5/5] 设置可选的 systemd 更新服务'
install_updater
printf '{"sha":"%s","at":"%s","version":"%s"}\n' "$(git -C "$APP_DIR" rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' package.json | head -n1)" > data/deployed-version.json
chown 10001:10001 data/deployed-version.json
chmod 600 data/deployed-version.json
printf '新服务：http://127.0.0.1:8323/healthz\n控制台：/console\n旧服务未修改。完成真实测试后再切换 HTTPS 反代。\n'
