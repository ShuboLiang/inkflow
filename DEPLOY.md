# InkFlow 服务器部署指南

部署形态：**all-in-one 单容器**——PostgreSQL + 认证 + REST + 文件存储 + 前端静态托管，
全部装进一个镜像。服务器上只有三样东西：一个镜像 tar、一个文件夹（compose + .env +
两个数据目录）。

特性与取舍：

- 前端 API 地址取浏览器当前来源、anon 密钥由 JWT_SECRET 启动时派生——**换 IP/域名不用重新打包**
- 服务互保：任一服务崩溃 3 秒自动拉起；postgres 挂了容器退出，由 restart 策略整体重启
- 注册即登录（免邮箱验证，自托管单人使用）
- **不含 Realtime**：多端同步退化为 5 秒轮询（个人使用几乎无感）
- 首次启动约 30-60 秒（数据库初始化 + 业务迁移），看日志 `docker logs -f inkflow`

## 一、开发机：构建并导出镜像

```powershell
powershell -File scripts/build-all-in-one.ps1
```

产出在仓库根目录：`inkflow-all-in-one.tar`（约 500MB）。连同 `deploy/` 文件夹一起上传到服务器。

## 二、服务器：部署

前置：装好 Docker 和 Docker Compose 插件。

```bash
docker load -i inkflow-all-in-one.tar

mkdir inkflow && cd inkflow
# 1. 放入 deploy/docker-compose.yml
# 2. 复制 deploy/.env.example 为 .env，修改两个密码（POSTGRES_PASSWORD、JWT_SECRET）
docker compose up -d        # 完事
```

访问 `http://服务器IP/`（compose 默认映射 80 端口，被占用就改 `ports` 为如 `"8080:8080"`，
改完重新 `docker compose up -d` 生效）。注册账号即用。

数据全部落在 compose 同级的两个目录，备份/迁移就是拷贝它们：

- `./data/db` —— 数据库（笔记、元数据全在这）
- `./data/storage` —— 文件二进制（PDF、图片）

## 三、日常运维

- **备份**：`bash scripts/backup.sh`（SSH 或 cron 每日执行），产出单文件 tar.gz，
  默认保留 14 份；恢复 = 停容器 → 用备份内容覆盖 `data/db`（或导入其中的 db.sql）和
  `data/storage` → 启动
- **升级**：开发机重新 `build-all-in-one.ps1` → 服务器 `docker load` 新 tar →
  `docker compose up -d`（会自动用新镜像重建容器）；数据库结构变化随镜像内的迁移自动递增
- **密钥**：anon/service 密钥由 `JWT_SECRET` 派生，改 JWT_SECRET 会让所有已登录会话失效
  （相当于全部重新登录）；注册完账号后可在 `.env` 设 `DISABLE_SIGNUP=true` 禁止新注册

## 四、极空间 NAS 部署要点

- **机型要求**：必须是 **x86 机型**（Z4 / Z4S / Z423 等）。ARM 机型（Z2S）跑不了
  （基础镜像是 amd64）。SSH 上去 `uname -m` 确认输出 `x86_64`。
- **内存**：建议 4GB 空闲内存，笔记多再加一点。
- **传文件**：tar 包通过 SMB 拷到共享文件夹（如 `个人空间/inkflow`），在「文件管理」里解压。
- **起服务**（二选一）：
  1. 新版极空间「Docker」应用支持导入 compose 项目：指向解压后的 `docker-compose.yml`
     （同目录的 `.env` 会被自动读取）；
  2. 更稳的方式是开 SSH：`cd` 到解压后的目录，`docker compose up -d`。
- **防火墙/端口**：compose 默认映射 80；NAS 面板占了 80 就改成如 `"8080:8080"`。
- **备份**：`bash scripts/backup.sh`，建议加 cron 每日执行，并定期把包拉离 NAS。
- **数据留在哪**：`data/db` 和 `data/storage` 都在你映射的共享文件夹里，
  NAS 的 RAID/备份套件可直接兜住这两个目录。

## 五、从旧的多容器 Supabase 栈迁移数据（可选）

旧方案（supabase/docker 全家桶）已移除。若手上有旧栈的整库导出（`pg_dumpall` 或
`pg_dump` 的 plain SQL）和 storage 目录，按下法迁移：

```bash
# 1. 全新启动 all-in-one（空 data/db）
docker compose up -d
# 等初始化完成（约 60 秒，docker logs -f inkflow 看到 "all services starting"）

# 2. 灌入旧数据库导出（对象已存在之类的 ERROR 属正常，psql 会跳过继续，数据照常写入）
docker cp db.sql inkflow:/tmp/restore.sql
docker exec inkflow psql -h 127.0.0.1 -U postgres -d postgres -f /tmp/restore.sql

# 3. 文件二进制：停容器后把旧 storage 内容放进数据目录，再启动
docker compose down
cp -r <旧storage>/* data/storage/
docker compose up -d
```

恢复后用原账号登录（两边 JWT_SECRET 一致才不用换 anon key；不一致就重新登录一次，
或按 README 用 derive-keys.mjs 重新生成 anon key 填进前端配置）。
