# InkFlow 备份脚本
# 用法: powershell -File scripts/backup.ps1 [-OutDir <备份目录>] [-Keep <保留份数>]
#
# 备份内容（逻辑备份，可跨机器/版本恢复）:
#   1. db.sql      -- PostgreSQL 全量转储（笔记/文件夹/标签/文件元数据/分享/账号，全在里面）
#   2. storage\    -- 文件二进制（PDF、图片、分享副本）原样拷贝
#   3. *.env       -- 服务配置（存在才拷）
# 输出: <OutDir>\inkflow-<时间戳>.zip，超出保留份数的旧备份自动删除
#
# 恢复（新机器/重装后）:
#   1. 启动 stack（supabase\docker 下 docker compose up -d），应用旧 .env
#   2. 解压备份 zip
#   3. docker cp db.sql supabase-db:/tmp/db.sql
#      docker exec -i supabase-db psql -U postgres -d postgres -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
#      docker exec -i supabase-db psql -U postgres -d postgres -f /tmp/db.sql
#   4. 停 stack，用备份的 storage\ 覆盖 supabase\docker\volumes\storage，再启动
#   5. 重启 stack
param(
  [string]$OutDir = "",
  [int]$Keep = 14
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
if ($OutDir -eq "") { $OutDir = Join-Path $Root "backups" }

# 前置检查：容器在跑才能备份
$running = & docker inspect -f "{{.State.Running}}" supabase-db 2>$null
if ($running -ne "true") { Write-Error "supabase-db container is not running. Start the stack first: docker compose up -d" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $OutDir "inkflow-$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Write-Host "Backing up to $dest ..."

# 1. 数据库转储（先落在容器内再 docker cp，避免 PowerShell 重定向编码问题）
docker exec supabase-db pg_dump -U postgres -d postgres --no-comments -f /tmp/inkflow-backup.sql
if ($LASTEXITCODE -ne 0) { Write-Error "pg_dump failed" }
docker cp supabase-db:/tmp/inkflow-backup.sql "$dest\db.sql"
docker exec supabase-db rm /tmp/inkflow-backup.sql
Write-Host ("  [1/3] database dump done (" + [math]::Round((Get-Item "$dest\db.sql").Length/1KB) + " KB)")

# 2. 文件二进制（bind mount 目录原样拷贝；robocopy 0-7 均为成功）
$storageSrc = Join-Path $Root "supabase\docker\volumes\storage"
robocopy $storageSrc "$dest\storage" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "storage copy failed (robocopy $LASTEXITCODE)" }
Write-Host "  [2/3] storage copy done"

# 3. 配置文件（存在才拷）
foreach ($env in @("supabase\docker\.env", "web\.env")) {
  $p = Join-Path $Root $env
  if (Test-Path $p) { Copy-Item $p $dest }
}
Write-Host "  [3/3] config copy done"

# 打包并清理临时目录
$zip = "$dest.zip"
Compress-Archive -Path $dest -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $dest
Write-Host ("Done: " + $zip + " (" + [math]::Round((Get-Item $zip).Length/1MB, 1) + " MB)")

# 保留策略：删除超旧的备份
Get-ChildItem $OutDir -Filter "inkflow-*.zip" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object { Write-Host ("Pruning old backup: " + $_.Name); Remove-Item $_.FullName }
