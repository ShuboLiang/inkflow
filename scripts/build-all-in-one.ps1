# 构建 InkFlow all-in-one 镜像并导出为 tar（在开发机运行）
# 用法: powershell -File scripts/build-all-in-one.ps1 [-Tag <镜像标签>]
# 产出: inkflow-all-in-one.tar（docker save 结果，连同 deploy\ 目录一起上传服务器）
param([string]$Tag = "inkflow-all-in-one:latest")

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent

# 1. 前端用占位符构建（anon key 与 API 地址在容器启动时注入，镜像与服务器地址解耦）
Write-Host "[1/2] Building web (placeholders)..."
Push-Location (Join-Path $Root "web")
$env:VITE_SUPABASE_URL = "http://localhost:8000"
$env:VITE_SUPABASE_ANON_KEY = "__INKFLOW_ANON_KEY__"
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Error "web build failed" }
Pop-Location

# 2. 构建镜像（材料全部来自本地镜像，无需外网）
Write-Host "[2/2] Building image $Tag ..."
docker build -f (Join-Path $Root "docker\all-in-one\Dockerfile") -t $Tag $Root
if ($LASTEXITCODE -ne 0) { Write-Error "docker build failed" }

# 3. 导出 tar
$out = Join-Path $Root "inkflow-all-in-one.tar"
Write-Host "Exporting $out ..."
docker save -o $out $Tag
Write-Host ("Done: " + $out + " (" + [math]::Round((Get-Item $out).Length/1MB, 1) + " MB)")
Write-Host "Upload together with the deploy\ folder. See DEPLOY.md section '极简部署'."
