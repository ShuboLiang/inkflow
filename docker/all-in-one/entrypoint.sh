#!/bin/bash
# InkFlow all-in-one 容器入口：postgres + gotrue + postgrest + storage-api + realtime + 网关
# 必需环境变量（compose .env 提供）:
#   POSTGRES_PASSWORD, JWT_SECRET
# 可选: PUBLIC_ORIGIN（默认 http://localhost，仅用于生成链接）、DISABLE_SIGNUP
set -uo pipefail

: "${POSTGRES_PASSWORD:?need POSTGRES_PASSWORD}"
: "${JWT_SECRET:?need JWT_SECRET}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost}"

mkdir -p /var/lib/postgresql/data /var/lib/storage /run/postgresql
chown -R postgres:postgres /var/lib/postgresql/data /var/lib/storage /run/postgresql 2>/dev/null || true

log() { echo "[inkflow] $*"; }

# ---------- PostgreSQL（首次启动自动执行镜像内基础初始化脚本） ----------
# 必须用镜像自带的 postgresql.conf（含 shared_preload_libraries=pg_net 等扩展加载）
# 注意：首次初始化的引导服务器也监听 TCP，单看端口就绪会撞上初始化半途。
# 就绪判定：pg_net 扩展存在（98-webhooks 初始化脚本已跑完，基础库就绪）。
# 不能用 storage.buckets 当门槛——它是 storage-api 首次启动时才建的，会死锁。
log "starting postgres..."
su-exec postgres bash /usr/local/bin/docker-entrypoint.sh postgres \
  -c config_file=/etc/postgresql/postgresql.conf -c log_min_messages=fatal &
PG_PID=$!
pg_ready() {
  kill -0 "$PG_PID" 2>/dev/null || return 1
  su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc "select 1 from pg_extension where extname='pg_net'" 2>/dev/null | grep -q 1
}
for i in $(seq 1 240); do pg_ready && break; sleep 1; done
pg_ready || { log "postgres not ready"; exit 1; }
log "postgres ready"

# ---------- 服务监督：崩溃自动拉起（postgres 除外，它挂了容器退出由 docker 重启） ----------
declare -a SVC_PIDS=()
run() {
  local name="$1"; shift
  (
    while :; do
      log "starting $name"
      "$@" >>"/var/log/inkflow-$name.log" 2>&1
      log "$name exited (code $?), restart in 3s"
      sleep 3
    done
  ) &
  SVC_PIDS+=($!)
}

# ---------- 先启动 auth 与 storage（它们自带迁移，会建 auth 表和 storage.buckets 等） ----------
read -r ANON_KEY SERVICE_KEY <<<"$(node /opt/derive-keys.mjs)"
export ANON_KEY SERVICE_KEY

run auth env \
  GOTRUE_API_HOST=0.0.0.0 GOTRUE_API_PORT=9999 \
  API_EXTERNAL_URL="$PUBLIC_ORIGIN" \
  GOTRUE_DB_DRIVER=postgres \
  GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}" \
  GOTRUE_SITE_URL="$PUBLIC_ORIGIN" GOTRUE_URI_ALLOW_LIST='*' \
  GOTRUE_DISABLE_SIGNUP="${DISABLE_SIGNUP:-false}" \
  GOTRUE_JWT_ADMIN_ROLES=service_role GOTRUE_JWT_AUD=authenticated \
  GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_EXP="${JWT_EXPIRY:-3600}" \
  GOTRUE_JWT_SECRET="$JWT_SECRET" \
  GOTRUE_MAILER_AUTOCONFIRM=true \
  /usr/local/bin/auth

# storage-api（文件/图片对象存储；必须在 /app 下启动，它按相对路径找 migrations，
# 且 storage.buckets/objects 表由它在首次启动时创建）
(
  cd /app
  run storage env \
    ANON_KEY="$ANON_KEY" SERVICE_KEY="$SERVICE_KEY" \
    POSTGREST_URL=http://127.0.0.1:3000 \
    AUTH_JWT_SECRET="$JWT_SECRET" \
    DATABASE_URL="postgres://supabase_storage_admin:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}" \
    STORAGE_PUBLIC_URL="$PUBLIC_ORIGIN/storage/v1" \
    FILE_SIZE_LIMIT=52428800 STORAGE_BACKEND=file \
    GLOBAL_S3_BUCKET="${GLOBAL_S3_BUCKET:-stub}" \
    TENANT_ID="${STORAGE_TENANT_ID:-stub}" REGION="${REGION:-local}" \
    FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
    ENABLE_IMAGE_TRANSFORMATION=false \
    REQUEST_ALLOW_X_FORWARDED_PATH=true \
    node dist/start/server.js
)

# ---------- Realtime（多端即时同步；迁移+种子幂等，只在此跑一次） ----------
# 元数据库与业务库是同一个 postgres；supabase_admin 有建发布/槽的权限。
# SECRET_KEY_BASE 由 JWT_SECRET 确定性派生，重启不变（避免会话签名密钥漂移）。
SECRET_KEY_BASE="$(node -e 'const c=require("crypto"),h=s=>c.createHash("sha256").update(s).digest("hex");console.log(h(process.env.JWT_SECRET+":realtime:0")+h(process.env.JWT_SECRET+":realtime:1"))')"
REALTIME_ENV=(
  PORT=4000
  # beam 整套走 Debian 库（/opt/realtime-libs + /lib/x86_64-linux-gnu），避免混用基础镜像的 Alpine 库
  LD_LIBRARY_PATH=/opt/realtime-libs:/lib/x86_64-linux-gnu
  LANG=C.UTF-8
  DB_HOST=127.0.0.1 DB_PORT=5432
  DB_USER=supabase_admin DB_PASSWORD="$POSTGRES_PASSWORD" DB_NAME="$POSTGRES_DB"
  DB_AFTER_CONNECT_QUERY='SET search_path TO _realtime'
  DB_ENC_KEY=supabaserealtime
  API_JWT_SECRET="$JWT_SECRET"
  METRICS_JWT_SECRET="$SECRET_KEY_BASE"
  SECRET_KEY_BASE="$SECRET_KEY_BASE"
  APP_NAME=realtime
  ERL_AFLAGS="-proto_dist inet_tcp"
  DNS_NODES=''
)
log "initializing realtime (migrate + seed)..."
env "${REALTIME_ENV[@]}" /opt/realtime/bin/migrate >>/var/log/inkflow-realtime.log 2>&1 || { log "realtime migrate failed"; tail -5 /var/log/inkflow-realtime.log; exit 1; }
env "${REALTIME_ENV[@]}" /opt/realtime/bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)' >>/var/log/inkflow-realtime.log 2>&1 || { log "realtime seed failed"; tail -5 /var/log/inkflow-realtime.log; exit 1; }

# 等 storage-api 建好 storage.buckets（首次约 10-30 秒）
for i in $(seq 1 120); do
  su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc 'select 1 from storage.buckets limit 1' >/dev/null 2>&1 && break
  sleep 1
done
su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc 'select 1 from storage.buckets limit 1' >/dev/null 2>&1 || { log "storage schema not ready"; exit 1; }
log "storage schema ready"

# ---------- InkFlow 业务迁移（applied 表记录进度，只跑一次；带重试） ----------
su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -q <<'SQL'
create schema if not exists inkflow;
create table if not exists inkflow.migrations_applied(name text primary key, applied_at timestamptz not null default now());
SQL
for attempt in 1 2 3 4 5; do
  ok=1
  for f in /opt/inkflow-migrations/*.sql; do
    name=$(basename "$f")
    if [ "$(su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc "select 1 from inkflow.migrations_applied where name = '$name'")" = "1" ]; then
      continue
    fi
    log "applying $name"
    if su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -f "$f"; then
      su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -q -c "insert into inkflow.migrations_applied(name) values ('$name') on conflict do nothing"
    else
      ok=0
    fi
  done
  [ "$ok" = 1 ] && break
  log "migrations incomplete, retry in 5s (attempt $attempt)"
  sleep 5
done
[ "$ok" = 1 ] || { log "migrations failed"; exit 1; }

# ---------- 业务表纳入 realtime 发布（种子阶段已建 publication；幂等补表） ----------
for i in $(seq 1 120); do
  su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc "select 1 from pg_publication where pubname='supabase_realtime'" 2>/dev/null | grep -q 1 && break
  sleep 1
done
su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc "select 1 from pg_publication where pubname='supabase_realtime'" | grep -q 1 || { log "realtime publication not ready"; exit 1; }
for t in notes folders files; do
  if [ "$(su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -tAc "select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='$t'")" != "1" ]; then
    log "adding public.$t to supabase_realtime publication"
    su-exec postgres psql -h 127.0.0.1 -d "$POSTGRES_DB" -c "alter publication supabase_realtime add table public.$t"
  fi
done
log "realtime publication ready"

# ---------- 前端运行时注入 ----------
# 构建产物里的占位符替换成：API 地址 = 浏览器当前来源（换 IP/域名不用重打包）。
# 注意 vite 把 env 值输出为反引号模板字符串，必须连反引号一起替换，否则会变成字面文本。
for js in /srv/web/assets/*.js; do
  [ -f "$js" ] || continue
  sed -i \
    -e "s|\`http://localhost:8000\`|location.origin|g" \
    -e "s|\`__INKFLOW_ANON_KEY__\`|\"$ANON_KEY\"|g" \
    -e 's|"http://localhost:8000"|location.origin|g' \
    -e "s|\"__INKFLOW_ANON_KEY__\"|\"$ANON_KEY\"|g" \
    "$js"
done
log "frontend injected (anon key derived from JWT_SECRET)"

# ---------- 剩余服务 ----------
run rest env \
  PGRST_DB_URI="postgres://authenticator:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}" \
  PGRST_DB_SCHEMAS="${PGRST_DB_SCHEMAS:-public,storage,graphql_public}" \
  PGRST_DB_EXTRA_SEARCH_PATH="${PGRST_DB_EXTRA_SEARCH_PATH:-public}" \
  PGRST_DB_ANON_ROLE=anon PGRST_DB_MAX_ROWS=1000 \
  PGRST_ADMIN_SERVER_PORT=3001 PGRST_ADMIN_SERVER_HOST=127.0.0.1 \
  PGRST_JWT_SECRET="$JWT_SECRET" \
  /usr/local/bin/postgrest

# Realtime（postgres_changes 即时推送；初始化在上面已跑完）
run realtime env "${REALTIME_ENV[@]}" /opt/realtime/bin/server

# 网关（静态前端 + 反代，对外唯一端口）
run gateway node /opt/gateway.mjs

log "all services starting, gateway on :${GATEWAY_PORT:-8080}"

shutdown() { log "shutting down"; kill "${SVC_PIDS[@]}" "$PG_PID" 2>/dev/null; exit 0; }
trap shutdown TERM INT

# postgres 挂了 -> 容器退出（restart 策略负责拉起）；其余服务由 run() 自愈
wait "$PG_PID"
log "postgres exited, container stopping"
