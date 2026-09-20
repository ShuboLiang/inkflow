# 一键部署的远端执行器：SFTP 上传 tar → docker load → compose 重建 → 就绪/Realtime 验证
# 由 update-server.ps1 调用；也可单独：python scripts/deploy-remote.py --config ... --tar ...
import argparse
import json
import os
import sys
import time

import paramiko


def log(msg):
    print(f"[deploy] {msg}", flush=True)


def run(ssh, cmd, timeout=600, stdin_text=None):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    if stdin_text is not None:
        stdin.write(stdin_text)
        stdin.flush()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--tar", required=True)
    args = ap.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)
    pw = cfg["password"]
    remote_dir = cfg["remoteDir"].rstrip("/")
    # SSH 用户通常对 remoteDir 没有写权限——传到 /tmp 再让 sudo 处理
    remote_tar = "/tmp/inkflow-update.tar"
    port = int(cfg.get("gatewayPort", 9911))

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log(f"连接 {cfg['user']}@{cfg['host']}:{cfg['port']} ...")
    ssh.connect(cfg["host"], port=int(cfg["port"]), username=cfg["user"], password=pw, timeout=15)

    # sudo 预热，拿到 5 分钟免密窗口
    code, _, err = run(ssh, "sudo -S -v", timeout=30, stdin_text=pw + "\n")
    if code != 0:
        log(f"sudo 认证失败: {err.strip()}")
        sys.exit(1)

    # 上传 tar（覆盖式，文件名固定，失败重传不残留多份）
    size = os.path.getsize(args.tar)
    log(f"上传 {args.tar} ({size / 1e6:.0f}MB) → {remote_tar}")
    sftp = ssh.open_sftp()
    last = -10

    # paramiko 回调第一个参数是累计已传字节（非本块大小）
    def cb(done, _total):
        nonlocal last
        pct = int(done * 100 / size)
        if pct >= last + 10:
            last = pct
            log(f"上传进度 {pct}%")

    sftp.put(args.tar, remote_tar, callback=cb)
    sftp.close()
    log("上传完成")

    # 每次 sudo 都带 -S 并经 stdin 喂密码：paramiko 每条命令是新会话，
    # sudo 的免密时间戳按 tty 记，跨会话不生效
    def sudo(cmd, timeout=600):
        return run(ssh, f"sudo -S {cmd}", timeout=timeout, stdin_text=pw + "\n")

    log("docker load ...")
    code, out, err = sudo(f"docker load -i {remote_tar}", timeout=1800)
    if code != 0:
        log(f"docker load 失败: {err.strip()[-500:]}")
        sys.exit(1)
    log(out.strip().splitlines()[-1] if out.strip() else "load 完成")
    log("重建容器（数据卷不动）...")
    code, out, err = sudo(f'sh -c "cd {remote_dir} && docker compose up -d --force-recreate"', timeout=600)
    if code != 0:
        log(f"compose 失败: {(out + err).strip()[-500:]}")
        sys.exit(1)

    log("等待网关就绪...")
    ok = False
    for _ in range(60):
        code, _, _ = run(ssh, f"curl -sf -o /dev/null http://127.0.0.1:{port}/", timeout=15)
        if code == 0:
            ok = True
            break
        time.sleep(3)
    if not ok:
        log("网关 90 秒未就绪，看日志: sudo docker logs --tail 50 inkflow")
        sys.exit(1)
    log("网关已就绪")

    # 镜像含 Realtime 时验证 WebSocket 握手（101 = 网关→realtime 链路通）
    code, out, _ = sudo("docker exec inkflow ls /opt/realtime/bin >/dev/null 2>&1 && echo HAS_RT || echo NO_RT")
    if "HAS_RT" in out:
        log("验证 Realtime WebSocket 握手 ...")
        ws_cmd = (
            f'ANON=$(echo "{pw}" | sudo -S docker exec inkflow node /opt/derive-keys.mjs | cut -d" " -f1); '
            f'curl -si --max-time 5 -H "Connection: Upgrade" -H "Upgrade: websocket" '
            f'-H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" '
            f'"http://127.0.0.1:{port}/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0" | head -1'
        )
        # realtime 启动比网关晚几秒，握手持重试
        first = ""
        for _ in range(10):
            code, out, err = run(ssh, ws_cmd, timeout=30)
            first = (out or "").strip()
            if first:
                break
            time.sleep(3)
        log(f"握手结果: {first}")
        if "101" not in first:
            log("警告: WebSocket 握手异常（不影响部署，可稍后排查）")
    else:
        log("镜像不含 Realtime，跳过握手验证")

    log("清理服务器上的临时 tar ...")
    run(ssh, f"rm -f {remote_tar}")
    ssh.close()
    log("完成")


if __name__ == "__main__":
    main()
