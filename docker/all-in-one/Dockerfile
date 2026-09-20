# InkFlow all-in-one 镜像：PostgreSQL + GoTrue + PostgREST + Storage-API + Realtime + 前端网关
# 全部材料来自本地镜像（离线可构建）；服务由 entrypoint.sh 统一拉起。
#
# 构建（仓库根目录，先构建前端产物）:
#   cd web && VITE_SUPABASE_URL=http://localhost:8000 VITE_SUPABASE_ANON_KEY=__INKFLOW_ANON_KEY__ npm run build
#   docker build -f docker/all-in-one/Dockerfile -t inkflow-all-in-one:latest .
FROM supabase/gotrue:v2.196.0 AS gotrue
FROM postgrest/postgrest:v14.17 AS pgrst
FROM supabase/storage-api:v1.74.0 AS storage
FROM supabase/realtime:v2.134.10 AS realtime
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
# realtime（Elixir 发布，整体拷到 /opt/realtime；基础镜像缺 beam 依赖的 libtinfo）
COPY --from=realtime /app /opt/realtime
# beam 及其依赖统一用 realtime 自带的 Debian 版（基础镜像里 /usr/lib 的 C++ 库是 Alpine 版，
# 混用会在 VM 退出时 segfault），集中到 /opt/realtime-libs 经 LD_LIBRARY_PATH 指过去
COPY --from=realtime /usr/lib/x86_64-linux-gnu/libtinfo.so.6.5 /opt/realtime-libs/libtinfo.so.6.5
COPY --from=realtime /usr/lib/x86_64-linux-gnu/libstdc++.so.6.0.33 /opt/realtime-libs/libstdc++.so.6.0.33
COPY --from=realtime /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 /opt/realtime-libs/libgcc_s.so.1
RUN ln -sf libstdc++.so.6.0.33 /opt/realtime-libs/libstdc++.so.6 \
 && ln -sf libtinfo.so.6.5 /opt/realtime-libs/libtinfo.so.6
# 基础镜像是 nix 系（没有 /lib64/ld-linux），beam 是 Debian glibc 链接，
# 补齐 glibc 运行时 + 动态加载器才能跑 erl/beam
COPY --from=realtime /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
COPY --from=realtime /lib/x86_64-linux-gnu/libc.so.6 /lib/x86_64-linux-gnu/libc.so.6
COPY --from=realtime /lib/x86_64-linux-gnu/libm.so.6 /lib/x86_64-linux-gnu/libm.so.6
COPY --from=realtime /lib/x86_64-linux-gnu/libpthread.so.0 /lib/x86_64-linux-gnu/libpthread.so.0
COPY --from=realtime /lib/x86_64-linux-gnu/libdl.so.2 /lib/x86_64-linux-gnu/libdl.so.2
COPY --from=realtime /lib/x86_64-linux-gnu/librt.so.1 /lib/x86_64-linux-gnu/librt.so.1
COPY --from=realtime /lib/x86_64-linux-gnu/libresolv.so.2 /lib/x86_64-linux-gnu/libresolv.so.2
COPY --from=realtime /lib/x86_64-linux-gnu/libutil.so.1 /lib/x86_64-linux-gnu/libutil.so.1
COPY --from=realtime /lib/x86_64-linux-gnu/libnss_files.so.2 /lib/x86_64-linux-gnu/libnss_files.so.2
COPY --from=realtime /lib/x86_64-linux-gnu/libnss_dns.so.2 /lib/x86_64-linux-gnu/libnss_dns.so.2
RUN mkdir -p /lib64 && ln -sf ../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /lib64/ld-linux-x86-64.so.2

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
