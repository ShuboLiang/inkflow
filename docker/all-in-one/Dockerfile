# InkFlow all-in-one 镜像：PostgreSQL + GoTrue + PostgREST + Storage-API + 前端网关
# 全部材料来自本地镜像（离线可构建）；服务由 entrypoint.sh 统一拉起。
#
# 构建（仓库根目录，先构建前端产物）:
#   cd web && VITE_SUPABASE_URL=http://localhost:8000 VITE_SUPABASE_ANON_KEY=__INKFLOW_ANON_KEY__ npm run build
#   docker build -f docker/all-in-one/Dockerfile -t inkflow-all-in-one:latest .
FROM supabase/gotrue:v2.196.0 AS gotrue
FROM postgrest/postgrest:v14.17 AS pgrst
FROM supabase/storage-api:v1.74.0 AS storage
FROM supabase/postgres:17.6.1.136

# --- 服务二进制 ---
COPY --from=gotrue /usr/local/bin/auth /usr/local/bin/auth
COPY --from=pgrst /bin/postgrest /usr/local/bin/postgrest
# storage-api：node 运行时 + 应用（自带 node_modules）+ node 需要的 C++ 运行库
COPY --from=storage /usr/local/bin/node /usr/local/bin/node
COPY --from=storage /usr/lib/libstdc++.so.6.0.34 /usr/lib/libstdc++.so.6.0.34
COPY --from=storage /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=storage /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=storage /app /app

# --- Supabase 库初始化补充脚本（原本 bind mount 自官方 supabase/docker 栈，现已内置于本目录） ---
COPY docker/all-in-one/initdb/init-scripts/ /docker-entrypoint-initdb.d/init-scripts/
COPY docker/all-in-one/initdb/migrations/ /docker-entrypoint-initdb.d/migrations/

# --- InkFlow 业务迁移 / 网关 / 入口 / 前端静态产物 ---
COPY web/supabase-migrations/ /opt/inkflow-migrations/
COPY docker/all-in-one/gateway.mjs /opt/gateway.mjs
COPY docker/all-in-one/derive-keys.mjs /opt/derive-keys.mjs
COPY docker/all-in-one/entrypoint.sh /opt/entrypoint.sh
COPY web/dist/ /srv/web/

EXPOSE 8080
VOLUME ["/var/lib/postgresql/data", "/var/lib/storage"]
ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
