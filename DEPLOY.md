# InkFlow 服务器部署指南

目标形态：服务器上 Docker Compose 跑 Supabase 全家桶，前端是构建好的静态文件（任意静态服务器托管），浏览器直连 Supabase API（`:8000`）。

## 一、开发机：打包

```powershell
# 在仓库根目录（有网服务器用这条）
powershell -File scripts/package-release.ps1 -ServerUrl http://你的服务器IP:8000

# 服务器完全离线（拉不了镜像）时加 -IncludeImages，把镜像也打进去
powershell -File scripts/package-release.ps1 -ServerUrl http://你的服务器IP:8000 -IncludeImages
```

产出在仓库根目录：`inkflow-release-<时间戳>.tar.gz`（必传）和 `inkflow-images.tar`（可选）。上传到服务器，比如：

```bash
scp inkflow-release-*.tar.gz user@server:/opt/
```

## 二、服务器：部署

前置：装好 Docker 和 Docker Compose 插件。

```bash
mkdir -p /opt/inkflow && cd /opt/inkflow
tar xzf /opt/inkflow-release-*.tar.gz        # 解包后本目录就是仓库根

# 离线部署先导入镜像（有网跳过）
docker load -i /opt/inkflow-images.tar

# 启动 Supabase 全家桶（.env 已随包携带，密钥与开发机一致）
cd supabase/docker
docker compose up -d

# 等数据库就绪（约 10-20 秒），依次应用 InkFlow 的业务迁移
until docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done
for f in ../../web/supabase-migrations/0*.sql; do
  docker exec -i supabase-db psql -U postgres -d postgres < "$f"
done
```

## 三、服务器：托管前端

前端已并入 compose（`docker-compose.override.yml` 里的 `web` 服务，nginx 托管 `web/dist`，
VITE_SUPABASE_URL 打包时已写入），`docker compose up -d` 会连同前端一起起，无需单独操作。

浏览器访问 `http://服务器IP/` 即可，首次打开注册新账号（Auth 页面）。
端口被占用就改 `supabase/docker/docker-compose.override.yml` 里的映射（如 `"8080:80"`），
改完重新 `docker compose up -d` 生效。

> 防火墙：需要开放 **80**（前端）和 **8000**（Supabase API，浏览器要直连）。不想暴露 8000 的话，在 nginx 里加 `/supabase` 反代并改前端构建地址，属于进阶配置。

## 四、迁移旧数据（可选）

全新部署是空库。要带走旧笔记/文件，用开发机的备份（`scripts/backup.ps1` 产出）：

```bash
# 备份 zip 传到服务器并解压后：
docker cp db.sql supabase-db:/tmp/db.sql
docker exec -i supabase-db psql -U postgres -d postgres -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
docker exec -i supabase-db psql -U postgres -d postgres -f /tmp/db.sql
# storage 二进制（停 stack → 覆盖 → 启动）
cd supabase/docker && docker compose down
cp -r <解压的备份>/storage/* volumes/storage/
docker compose up -d
```

恢复后用原账号登录，数据原样回来。

## 五、日常运维

- **备份**：在服务器上同样跑 `scripts/backup.ps1`（PowerShell）或手工 `pg_dump` + 拷贝 `volumes/storage`；定期把 zip 拉离服务器
- **升级**：开发机重新打包 → 服务器解包覆盖 → `docker compose up -d`（会自动重建有变化的容器）；数据库结构变化会随包里的迁移文件递增
- **注意**：`docker-compose.override.yml`、`.env` 属于环境配置，换机器时保持和打包时一致

## 六、极空间 NAS 部署要点

- **机型要求**：必须是 **x86 机型**（Z4 / Z4S / Z423 等）。ARM 机型（Z2S）跑不了 Supabase
  官方镜像（只有 amd64）。SSH 上去 `uname -m` 确认输出 `x86_64`。
- **内存**：整套 Supabase 约需 4GB 空闲内存，笔记多再加一点。
- **传文件**：tar 包通过 SMB 拷到共享文件夹（如 `个人空间/inkflow`），在「文件管理」里解压
  或 SSH 解压均可。
- **起服务**（二选一）：
  1. 新版极空间「Docker」应用支持导入 compose 项目：指向 `supabase/docker/docker-compose.yml`
     （同目录的 `.env` 会被自动读取）；
  2. 更稳的方式是开 SSH：`cd` 到解压后的 `supabase/docker`，`docker compose up -d`。
- **前端**：Docker 应用里新建容器，`nginx:alpine`，文件夹映射 `web/dist` →
  `/usr/share/nginx/html`（只读），端口映射如 `8080 → 80`（避开 NAS 面板占用的端口）。
- **打包地址**：开发机打包时 `-ServerUrl` 填 NAS 的访问地址。内网用 `http://<NAS内网IP>:8000`；
  要通过极空间外网/域名访问，就填那个外网地址重新打包（地址是构建期写死的）。
- **防火墙/端口**：需要开放 **8000**（Supabase API，浏览器直连）和前端端口。
- **备份**：NAS 上没有 PowerShell，用 `bash scripts/backup.sh`（SSH 或计划任务），
  产出与 Windows 版一致的单文件 tar.gz；建议加 cron 每日执行，并定期把包拉离 NAS。
- **数据留在哪**：数据库数据在 `supabase/docker/volumes/db/data`，文件二进制在
  `volumes/storage`——都在你映射的共享文件夹里，NAS 的 RAID/备份套件可直接兜住这两目录。
