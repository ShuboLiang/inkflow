# InkFlow 发布打包脚本（在开发机上运行）
# 用法: powershell -File scripts/package-release.ps1 -ServerUrl http://服务器IP:8000 [-IncludeImages]
#
# 产出（仓库根目录）:
#   inkflow-release-<时间戳>.tar.gz   项目包：编排/配置/迁移/前端构建产物（不含开发数据）
#   inkflow-images.tar                仅 -IncludeImages：当前用到的所有 docker 镜像（离线部署用）
#
# 说明:
#   - 前端是静态构建，VITE_SUPABASE_URL 在构建期写入，必须传服务器实际地址（含端口）
#   - 排除项: .git / node_modules / backups / 数据库数据目录 / storage 二进制
#     （服务器初始化后如需旧数据，用 scripts/backup.ps1 的备份恢复，见 DEPLOY.md）
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [switch]$IncludeImages
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$pkg = Join-Path $Root "inkflow-release-$stamp.tar.gz"

# 1. 前端构建（把服务器地址写进静态产物）
Write-Host "[1/2] Building web frontend for $ServerUrl ..."
Push-Location (Join-Path $Root "web")
$env:VITE_SUPABASE_URL = $ServerUrl
# anon key 是公开密钥，直接沿用开发配置
if (Test-Path ".env") { Get-Content ".env" | Where-Object { $_ -match '^VITE_SUPABASE_ANON_KEY=' } | ForEach-Object { $kv = $_ -split '=', 2; $env:VITE_SUPABASE_ANON_KEY = $kv[1] } }
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "web build failed" }
Pop-Location

# 2. 打项目包（优先用系统自带的 bsdtar，避免 Git 的 GNU tar 把 C: 当远程主机）
Write-Host "[2/2] Packing $pkg ..."
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $tar)) { $tar = "tar" }
& $tar -czf $pkg `
  --exclude=.git --exclude=node_modules --exclude=backups --exclude=".shots" `
  --exclude="supabase/docker/volumes/db/data" --exclude="supabase/docker/volumes/storage" `
  -C $Root .
if ($LASTEXITCODE -ne 0) { Write-Error "tar failed" }
Write-Host ("Package: " + $pkg + " (" + [math]::Round((Get-Item $pkg).Length/1MB, 1) + " MB)")

# 3. 可选：导出镜像（服务器离线时使用）
if ($IncludeImages) {
  $imagesFile = Join-Path $Root "inkflow-images.tar"
  Write-Host "Exporting docker images (server offline scenario) ..."
  $images = docker compose -f (Join-Path $Root "supabase\docker\docker-compose.yml") config --images
  docker save -o $imagesFile $images
  if ($LASTEXITCODE -ne 0) { Write-Error "docker save failed" }
  Write-Host ("Images: " + $imagesFile + " (" + [math]::Round((Get-Item $imagesFile).Length/1MB, 1) + " MB)")
}

Write-Host "Done. Upload the tar(s) to your server and follow DEPLOY.md."
