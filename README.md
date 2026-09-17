# InkFlow

本地优先（IndexedDB）+ Supabase 云同步的笔记 Web 应用。

## 技术栈

- 前端：Vite + React + TypeScript + TipTap + Dexie + @supabase/supabase-js + FlexSearch
- 后端：Docker 自托管 Supabase（官方 docker-compose 方案）

## 目录结构

```
inkflow/
├── scripts/
│   └── generate-keys.mjs      # 重新生成 Supabase 密钥/JWT 的脚本
├── supabase/
│   └── docker/                # 官方自托管 Supabase（从 supabase/supabase 浅克隆）
├── web/                       # 前端
│   ├── src/lib/               # supabase client、Dexie 本地库
│   ├── src/sync/              # 同步引擎骨架（LWW 策略）
│   ├── src/store/             # 笔记本地 CRUD
│   ├── src/components/        # TipTap 编辑器
│   └── supabase-migrations/   # 数据库 schema SQL
├── docs/
│   └── limitations.md         # 已知限制与后续处理方向
└── README.md
```

## 启动步骤

1. 启动 Supabase：

   ```bash
   cd supabase/docker
   docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
   ```

   首次拉取镜像较大（数 GB），请耐心等待。

   > 注意：必须显式带上 `-f docker-compose.override.yml`（本机 Compose v5 不再自动加载
   > override 文件）。override 里有两项本地修复：给 supavisor 设置可解析的 hostname
   > （修复反复重启），并移除宿主机 5432 端口映射（避免与残留端口代理冲突；前端走
   > 8000 网关，用不到它）。后续所有 `docker compose` 命令都要带这两个 `-f`。

2. 执行数据库 migration：
   打开 Supabase Studio（默认 http://localhost:8000 ，账号密码在 `supabase/docker/.env` 的
   `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`），进入 SQL Editor，粘贴并运行
   `web/supabase-migrations/001_init.sql` 的全部内容。

3. 配置前端 anon key：
   将 `supabase/docker/.env` 中的 `ANON_KEY` 复制到 `web/.env` 的 `VITE_SUPABASE_ANON_KEY`
   （当前为 PLACEHOLDER 占位符）。

4. 启动前端：

   ```bash
   cd web
   npm install
   npm run dev
   ```

5. 注册/登录：打开前端页面后先注册账号。**本地开发默认开启了邮箱验证，但 mailer 通常没配置**，
   会导致注册后收不到验证邮件、无法登录。免验证方案：编辑 `supabase/docker/.env`，设置

   ```
   ENABLE_EMAIL_AUTOCONFIRM=true
   ```

   然后重启 auth 服务：

   ```bash
   cd supabase/docker
   docker compose up -d --force-recreate auth
   ```

   之后新注册的账号会直接确认，注册即登录。前端代码也做了容错：注册后若未拿到 session，
   会自动尝试直接登录一次，失败才提示去查收验证邮件。

## 密钥安全

- 所有 `.env` 文件均已加入 `.gitignore`，**不要提交到任何仓库**。
- 仓库/示例中的默认 Supabase 密钥是公开的，绝不能用于真实环境。本项目
  `supabase/docker/.env` 中的密钥已用 `scripts/generate-keys.mjs` 重新生成。
- 如需重新生成密钥：`node scripts/generate-keys.mjs`，将输出更新到
  `supabase/docker/.env`（改 JWT_SECRET 后 ANON_KEY / SERVICE_ROLE_KEY 必须一起换）。

## 手动克隆 Supabase（备选）

若 `supabase/docker` 目录缺失（克隆失败时），手动执行：

```bash
cd supabase
git clone --depth 1 https://github.com/supabase/supabase.git
# Windows (Git Bash):
mv supabase/docker ./docker && rm -rf supabase
cd docker && cp .env.example .env
```

然后运行 `node ../../scripts/generate-keys.mjs` 并把输出值替换进 `.env`。
