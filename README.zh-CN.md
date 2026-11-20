# dsh-server-stats

English | [中文](README.zh-CN.md)

给 [DeepSeek Harness](https://deepseek.com/) 用的插件包：在输入框统计栏加一枚 **服务器状态** pill，
显示任意 SSH 可达 Linux 主机的 CPU 占用与已用内存，点开看负载、磁盘、容器数、systemd 单元状态和运行时长。

```
[服务器图标] 1.6% · 298M          ← CPU ≥ 80% 或内存 ≥ 90% 时变告警色
```

点开后的面板：

| 行 | 来源 |
| --- | --- |
| 主机 | 配置的 SSH 目标 |
| CPU | 间隔 0.3 秒两次采样 `/proc/stat` |
| 负载 | `/proc/loadavg` |
| 内存 / Swap | `/proc/meminfo` |
| 磁盘 | `df -P /` |
| 容器 | `podman ps -q` 或 `docker ps -q`（只数个数） |
| 服务 | 你配置的 systemd 单元 `systemctl is-active` |
| 运行时长 | `/proc/uptime` |

远端**不安装任何东西**：Host 半通过 SSH 跑一条只读脚本，结果缓存 4 秒；浏览器只读本地 JSON 路由。
不经过任何模型请求。

## 前提

- 带 Web/桌面界面的 DeepSeek Harness。
- 运行 DSH 的机器上有 `ssh` 客户端，且**能免交互登录**目标机（`BatchMode=yes`，走密钥或 ssh-agent，
  不弹密码）。`~/.ssh/config` 里的 `ProxyJump` / `ProxyCommand` 照常可用。
- 目标机需要 POSIX shell、`awk`、`df`。`podman`/`docker` 与 `systemctl` 可选，缺失时对应行显示 `0` 或空。

## 安装

1. 把本目录放到一个固定位置（插件管理器是**链接**它，不会复制）。
2. DSH → **Plugins** → **Add plugin** → 选择该目录；或用 `plugin_manager` 工具的 `install_bundle`，
   target 传绝对路径。
3. 刷新 DSH 页面，pill 会出现在 token/余额 pill 旁边。

## 配置

需要先给一个 SSH 目标。两处配置等价，**row config 优先于 JSON 文件**：

**A. 插件设置 / bundle patch**（适合随 bundle 一起分享）：

```yaml
- insert:
    - id: server-stats
      name: dsh-server-stats
      config:
        target: my-server          # ~/.ssh/config 别名，或 user@host
        services: [nginx, docker]
```

**B. 用户配置文件** `~/.dsh/server-stats.json`（即 `$DSH_HOME/server-stats.json`）：

```json
{
  "target": "my-server",
  "identityFile": "C:/Users/me/.ssh/id_ed25519",
  "port": 22,
  "services": ["nginx", "docker"],
  "containers": true,
  "pollSeconds": 30,
  "timeoutMs": 8000
}
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `target` | `""` | SSH 目标；为空时 pill 显示「未配置」 |
| `identityFile` | `""` | 私钥路径；为空则用 ssh-agent 或 `~/.ssh/config` |
| `port` | `0` | SSH 端口；0 表示默认 |
| `services` | `[]` | 要显示状态的 systemd 单元（单元名会校验，其他内容不会进入 shell） |
| `containers` | `true` | podman 或 docker 可用时报告容器数 |
| `pollSeconds` | `30` | 刷新周期，限制在 5–600 秒 |
| `timeoutMs` | `8000` | SSH 往返超时，限制在 1000–60000 毫秒 |

改完下一次轮询即生效，无需重启。

## 验证

```bash
# Host 路由（端口用 DSH 启动时打印的那个）
curl -s http://127.0.0.1:55340/dsh-server-stats/stats
```

正常返回形如：

```json
{"ok":true,"status":"ready","config":{"target":"my-server","pollSeconds":30,"services":[]},
 "stats":{"cpuPct":1.6,"load":"0.07 0.16 0.09","uptimeSec":387,
          "memTotalMb":3911,"memUsedMb":298,"diskUsedGb":6.2,"diskTotalGb":58,
          "diskPct":"12%","containers":2,"engine":"podman","services":[]}}
```

`status` 只可能是 `ready`、`unreachable`（SSH 失败，pill 显示「离线」）、`unconfigured`。

## 实现结构

- `index.js` — Host 半：注册 `webServer` 路由 `GET /dsh-server-stats/stats`，负责配置解析、SSH 采集与结果解析。
- `client.js` — Client 半：注册一个 `conversation.composer.dock` 条目（id `server-stats`，order 3），
  绘制 pill 与面板，文案走 Client locale 服务。
- `cordis.patch.yml` — 插入 Host 行的 bundle patch。

## 配套的服务器调优工具

同一个仓库里还带了这套 pill 诞生时用的服务端工具：

| 路径 | 作用 |
| --- | --- |
| [`scripts/tune-ubuntu.sh`](scripts/tune-ubuntu.sh) | 幂等的 Ubuntu 调优：sysctl、TCP BBR、`noatime`、IO 调度器、journald 上限、无用服务、可选释放 crashkernel |
| [`scripts/remove-tencent-agents.sh`](scripts/remove-tencent-agents.sh) | 卸载腾讯云云镜/主机安全与云监控 agent，含其防卸载守护进程的处理 |
| [`skills/ubuntu-server-tuning/SKILL.md`](skills/ubuntu-server-tuning/SKILL.md) | DeepSeek Harness skill：告诉 agent 什么时候、按什么顺序执行这两个脚本 |

每个参数的理由与实测数据见 [`scripts/README.md`](scripts/README.md)。
想在自己的 DSH 里用这个 skill，把 `skills/ubuntu-server-tuning/` 复制到
`~/.dsh/skills/`，并确认文件系统 skill provider 已启用。

## 限制

- **只读**：除这条固定采集脚本外，不会在目标机上写文件、重启服务或执行任意命令。
- 一个 bundle row 对应一台主机。多台主机就装两次、用不同 id 与 config。
- 每次轮询都是一次 SSH 认证；默认 30 秒约每天在目标机 `auth.log` 留 2880 条记录。介意就调大 `pollSeconds`。
- 容器数会尝试 `sudo -n`；需要密码的主机该项显示 `0`。

## 许可

MIT，见 [LICENSE](LICENSE)。
