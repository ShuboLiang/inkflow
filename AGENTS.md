# AGENTS.md

InkFlow：本地优先（IndexedDB）+ 云端同步的笔记 Web 应用。all-in-one 单容器部署。

## 每次改完必须提交

**每完成一个修复/功能，把本次所有改动 `git add -A` 并提交**，提交信息用中文、一句话说清改了什么。不要积攒多个改动才提交，也不要只提交部分文件。部署类产物（`inkflow-all-in-one.tar`、前端 `dist/`）已被 .gitignore 排除，不会误提交。

## 目录与要点

- `web/` — 前端（Vite + React + TS + TipTap + Dexie + supabase-js）。改动后必须 `npm run build` 和 `npx oxlint` 全绿。
- `web/src/components/PdfViewer.tsx` — pdf.js 自渲染 PDF 查看器。中文 PDF 常不内嵌字体，靠 `registerFontAliases()` 把霞鹜文岸子集注册成常见字体名（FandolSong/SimSun 等）+ `web/public/pdfjs/` 下的 cmaps/standard_fonts 兜底。**别删这两样**。
- `docker/all-in-one/` — 镜像构建：Dockerfile（多阶段拷贝 gotrue/postgrest/storage/realtime 到 nix 系 postgres 基础镜像）、gateway.mjs（静态+反代，路由仿 Kong：/realtime/v1/* → /socket/* 且 Host 改写成 realtime-dev.supabase-realtime）、entrypoint.sh（拉起 postgres+四个服务+迁移+发布配置）。改网关记得 MIME 表要全（缺 .mjs 会导致 pdf.js worker 加载失败）。
- `deploy/` — 服务器模板（compose + .env 示例）。compose 里 `pull_policy: never`，镜像只来自 `docker load`。
- `scripts/update-server.ps1` + `scripts/deploy-remote.py` — 一键部署（构建→导出→SFTP 上传→load→重建→验证）。**`.ps1` 文件必须带 UTF-8 BOM**（Windows PowerShell 5.1 无 BOM 会把中文按 GBK 解析报错）；用 `-ExecutionPolicy Bypass` 执行。服务器连接配置在 `scripts/server.config.json`（已 gitignore）。

## 常用命令

```powershell
# 前端检查
cd web && npm run build && npx oxlint

# 本地起测试容器（端口 8100，独立于 dev 实例的 8000）
docker build -f docker/all-in-one/Dockerfile -t inkflow-all-in-one:latest .
docker run -d --name inkflow-test -p 8100:8080 -e POSTGRES_PASSWORD=testpass123 -e JWT_SECRET=<64+字符> inkflow-all-in-one:latest

# 一键部署到服务器（改完代码跑这个就行）
powershell -ExecutionPolicy Bypass -File scripts/update-server.ps1
```

## 验证习惯

- 动了同步/网关：WebSocket 握手要验（`curl -si -H "Connection: Upgrade" -H "Upgrade: websocket" ... /realtime/v1/websocket?apikey=<anon>&vsn=1.0.0` 应返回 101）。
- 动了前端：无头 Chrome + puppeteer-core（本机 Chrome 在 `C:/Program Files/Google/Chrome/Application/chrome.exe`）按手机视口（390×844）实测并截图。
- 服务器 SSH：192.168.10.44:10000，连接配置在 `scripts/server.config.json`，sudo 用 `echo <密码> | sudo -S`（SSH 用户不在 docker 组；paramiko 每条命令是新会话，sudo 免密时间戳不跨会话）。
