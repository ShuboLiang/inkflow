# InkFlow

本地优先（IndexedDB）+ 云端同步的笔记 Web 应用。

## 技术栈

- 前端：Vite + React + TypeScript + TipTap + Dexie + @supabase/supabase-js + FlexSearch
- 后端：all-in-one 单容器（PostgreSQL + GoTrue 认证 + PostgREST + Storage 文件存储 + Realtime
  即时同步 + 前端网关，构建定义在 `docker/all-in-one/`），服务端部署见 [DEPLOY.md](DEPLOY.md)

## 目录结构

```
inkflow/
├── docker/all-in-one/         # 单容器镜像（Dockerfile / 网关 / 入口 / 库初始化 SQL）
├── deploy/                    # 服务器部署模板（compose + .env 示例）
├── scripts/
│   ├── build-all-in-one.ps1   # 构建镜像并导出 tar（开发机→服务器）
│   └── backup.sh              # 备份脚本（pg_dump + storage 拷贝）
├── web/                       # 前端
│   ├── src/lib/               # supabase client、Dexie 本地库
│   ├── src/sync/              # 同步引擎（LWW 策略）
│   ├── src/store/             # 笔记本地 CRUD
│   ├── src/components/        # TipTap 编辑器
│   └── supabase-migrations/   # 数据库 schema SQL（打包进镜像，启动时自动应用）
├── skills/inkflow-notes/      # 给 agent 写笔记用的 skill
└── README.md
```

## 本地开发

1. 构建 all-in-one 镜像（只需一次；改动过 `docker/all-in-one/` 或迁移后重新构建）：

   ```powershell
   powershell -File scripts/build-all-in-one.ps1
   ```

2. 启动本地后端（密钥随意，开发用固定值即可）：

   ```bash
   docker run -d --name inkflow -p 8000:8080 \
     -e POSTGRES_PASSWORD=dev-password \
     -e JWT_SECRET=dev-secret-dev-secret-dev-secret-dev-secret-dev-secret-dev-secre \
     -e PUBLIC_ORIGIN=http://localhost:8000 \
     -v "$PWD/dev-data/db:/var/lib/postgresql/data" \
     -v "$PWD/dev-data/storage:/var/lib/storage" \
     inkflow-all-in-one:latest
   ```

   首次启动约 30-60 秒（库初始化 + 业务迁移），日志 `docker logs -f inkflow`。

3. 配置前端 anon key（密钥是从 JWT_SECRET 派生的，改 JWT_SECRET 就要换）：

   ```bash
   JWT_SECRET=dev-secret-dev-secret-dev-secret-dev-secret-dev-secret-dev-secre \
     node docker/all-in-one/derive-keys.mjs
   ```

   输出的第一个 token 填到 `web/.env` 的 `VITE_SUPABASE_ANON_KEY`
   （`cp web/.env.example web/.env` 后修改，URL 保持 `http://localhost:8000`）。

4. 启动前端：

   ```bash
   cd web
   npm install
   npm run dev
   ```

5. 注册/登录：注册即登录（容器内已开启免邮箱验证）。

## 密钥安全

- anon 密钥是公开密钥（RLS 保护数据），泄露本身不致命；JWT_SECRET 才是根密钥，
  **生产环境务必用一长串随机字符**，泄露它等于别人可以签发任意身份。
- 服务器部署时 `.env` 里的两个密码用随机值；重新生成 anon key 可用
  `JWT_SECRET=<你的密钥> node docker/all-in-one/derive-keys.mjs`。

## 备份

`bash scripts/backup.sh`（详见 DEPLOY.md「日常运维」）。数据库 + 文件二进制一个 tar.gz 搞定，
恢复 = 停容器 → 用备份覆盖 `data/` 下对应目录 → 启动。
