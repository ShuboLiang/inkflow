#!/usr/bin/env bash
# InkFlow all-in-one 备份脚本（在服务器 compose 目录旁运行，或指定 compose 目录）
# 用法: bash scripts/backup.sh [compose目录] [备份输出目录]    （保留份数用环境变量 KEEP 控制，默认 14）
#   compose 目录: 含 docker-compose.yml 和 data/ 的目录，默认当前目录
# 产出: <输出目录>/inkflow-<时间戳>.tar.gz（内含 db.sql + storage/）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_DIR="${1:-$PWD}"
OUT_DIR="${2:-$ROOT/backups}"
KEEP="${KEEP:-14}"

docker inspect inkflow >/dev/null 2>&1 || { echo "inkflow 容器未运行，先 docker compose up -d"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/inkflow-$STAMP"
mkdir -p "$DEST"
echo "Backing up to $DEST ..."

docker exec inkflow pg_dump -U postgres -d postgres --no-comments > "$DEST/db.sql"
echo "  [1/3] database dump done ($(du -h "$DEST/db.sql" | cut -f1))"

STORAGE_DIR="$COMPOSE_DIR/data/storage"
[ -d "$STORAGE_DIR" ] && cp -r "$STORAGE_DIR" "$DEST/storage"
echo "  [2/3] storage copy done"

[ -f "$COMPOSE_DIR/.env" ] && cp "$COMPOSE_DIR/.env" "$DEST"
echo "  [3/3] config copy done"

(cd "$OUT_DIR" && tar czf "inkflow-$STAMP.tar.gz" "inkflow-$STAMP" && rm -rf "inkflow-$STAMP")
echo "Done: $DEST.tar.gz ($(du -h "$DEST.tar.gz" | cut -f1))"

# 保留策略
ls -t "$OUT_DIR"/inkflow-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
