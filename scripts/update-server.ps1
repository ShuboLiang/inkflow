# 一键更新 InkFlow 服务器：构建 → 导出 tar → 上传 → 远程重建 → 验证
# 用法: powershell -File scripts/update-server.ps1
#   -SkipBuild   跳过本地构建，直接上传现有的 inkflow-all-in-one.tar（改完代码构建失败重试等场景）
#   -Config      指定服务器配置（默认 scripts/server.config.json，参考 server.config.example.json）
param(
  [string]$Tag = 'inkflow-all-in-one:latest',
  [switch]$SkipBuild,
  [string]$Config = "$PSScriptRoot/server.config.json"
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $Config)) { Write-Error "找不到配置文件 $Config，请复制 scripts/server.config.example.json 并填写" }

$Tar = Join-Path $Root 'inkflow-all-in-one.tar'

if (-not $SkipBuild) {
  Write-Host '[1/3] Building web (placeholders)...'
  Push-Location (Join-Path $Root 'web')
  $env:VITE_SUPABASE_URL = 'http://localhost:8000'
  $env:VITE_SUPABASE_ANON_KEY = '__INKFLOW_ANON_KEY__'
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error 'web build failed' }
  Pop-Location

  Write-Host "[2/3] Building image $Tag ..."
  docker build -f (Join-Path $Root 'docker\all-in-one\Dockerfile') -t $Tag $Root
  if ($LASTEXITCODE -ne 0) { Write-Error 'docker build failed' }

  Write-Host "Exporting $Tar ..."
  docker save -o $Tar $Tag
  if ($LASTEXITCODE -ne 0) { Write-Error 'docker save failed' }
} else {
  if (-not (Test-Path $Tar)) { Write-Error "-SkipBuild 但 $Tar 不存在" }
  Write-Host '[1/3] 跳过构建，用现有 tar'
}

Write-Host '[3/3] Deploying to server...'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
python (Join-Path $PSScriptRoot 'deploy-remote.py') --config $Config --tar $Tar
if ($LASTEXITCODE -ne 0) { Write-Error '远程部署失败' }
Write-Host '服务器更新完成'
