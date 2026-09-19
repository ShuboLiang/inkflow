#!/usr/bin/env bash
# InkFlow 备份脚本（Linux/NAS 用；Windows 用 scripts/backup.ps1）
# 用法: bash scripts/backup.sh [备份目录]    （保留份数用环境变量 KEEP 控制，默认 14）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$ROOT/backups}"
KEEP="${KEEP:-14}"

docker inspect supabase-db >/dev/null 2>&1 || { echo "supabase-db 容器未运行，先 docker compose up -d"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/inkflow-$STAMP"
mkdir -p "$DEST"
echo "Backing up to $DEST ..."

docker exec supabase-db pg_dump -U postgres -d postgres --no-comments > "$DEST/db.sql"
echo "  [1/3] database dump done ($(du -h "$DEST/db.sql" | cut -f1))"

cp -r "$ROOT/supabase/docker/volumes/storage" "$DEST/storage"
echo "  [2/3] storage copy done"

[ -f "$ROOT/supabase/docker/.env" ] && cp "$ROOT/supabase/docker/.env" "$DEST"
[ -f "$ROOT/web/.env" ] && cp "$ROOT/web/.env" "$DEST"
echo "  [3/3] config copy done"

(cd "$OUT_DIR" && tar czf "inkflow-$STAMP.tar.gz" "inkflow-$STAMP" && rm -rf "inkflow-$STAMP")
echo "Done: $DEST.tar.gz ($(du -h "$DEST.tar.gz" | cut -f1))"

# 保留策略
ls -t "$OUT_DIR"/inkflow-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
