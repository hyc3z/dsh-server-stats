# dsh-server-stats

A [DeepSeek Harness](https://deepseek.com/) bundle that puts a live **Server status** pill beside
the composer statistics — CPU percentage and used memory for any Linux host you can reach over SSH,
with load, disk, containers, systemd units and uptime one click away.

```
[server icon] 1.6% · 298M          ← pill (turns warning-colored at CPU ≥ 80% / memory ≥ 90%)
```

Click it for the full snapshot:

| Row | Source |
| --- | --- |
| Host | the configured SSH target |
| Load | `/proc/loadavg` |
| CPU | two `/proc/stat` samples 0.3 s apart |
| Memory / Swap | `/proc/meminfo` |
| Disk | `df -P /` |
| Containers | `podman ps -q` or `docker ps -q` (counts only) |
| Services | `systemctl is-active` for the units you configure |
| Uptime | `/proc/uptime` |

Nothing is installed on the remote host: the Host half runs one read-only script over SSH and caches
the result for 4 seconds; the browser only reads a local JSON route. No model request is involved.

## Requirements

- DeepSeek Harness with the Web/Desktop UI.
- An `ssh` client on the machine running DSH that can log in **non-interactively** to the target
  (`BatchMode=yes` — keys or ssh-agent, no password prompt). `ProxyJump`/`ProxyCommand` from
  `~/.ssh/config` work as usual.
- The target needs a POSIX shell, `awk` and `df`. `podman`/`docker` and `systemctl` are optional;
  missing ones simply produce `0` or an empty row.

## Install

1. Put this directory somewhere permanent (the plugin manager links to it, it is not copied).
2. DSH → **Plugins** → **Add plugin** → choose the directory.
   Or, with the `plugin_manager` tool: `install_bundle` with the absolute directory as target.
3. Reload the DSH page; the pill appears next to the token/balance pills.

## Configure

Set an SSH target. Two equivalent places, the row `config` wins over the JSON file:

**A. Plugin settings / bundle patch** (recommended for sharing a setup in the bundle):

```yaml
- insert:
    - id: server-stats
      name: dsh-server-stats
      config:
        target: my-server          # ~/.ssh/config alias, or user@host
        services: [nginx, docker]
```

**B. User config file** `~/.dsh/server-stats.json` (`$DSH_HOME/server-stats.json`):

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

| Field | Default | Meaning |
| --- | --- | --- |
| `target` | `""` | SSH destination; empty shows **Not set up** |
| `identityFile` | `""` | Private key path; empty uses ssh-agent / `~/.ssh/config` |
| `port` | `0` | SSH port; `0` keeps the default |
| `services` | `[]` | systemd units to report (names are validated, nothing else reaches the shell) |
| `containers` | `true` | Report a container count when podman or docker answers |
| `pollSeconds` | `30` | Browser refresh period, clamped 5–600 |
| `timeoutMs` | `8000` | SSH round-trip ceiling, clamped 1000–60000 |

Changes apply on the next poll; no restart needed.

## Verify

```bash
# the Host route (use the port DSH prints at startup)
curl -s http://127.0.0.1:55340/dsh-server-stats/stats
```

A healthy answer looks like:

```json
{"ok":true,"status":"ready","config":{"target":"my-server","pollSeconds":30,"services":[]},
 "stats":{"cpuPct":1.6,"load":"0.07 0.16 0.09","uptimeSec":387,
          "memTotalMb":3911,"memUsedMb":298,"diskUsedGb":6.2,"diskTotalGb":58,
          "diskPct":"12%","containers":2,"engine":"podman","services":[]}}
```

`status` is one of `ready`, `unreachable` (SSH failed — the pill shows Offline) or `unconfigured`.

## How it works

- `index.js` — Host half: `webServer` route `GET /dsh-server-stats/stats`, config resolution,
  the SSH collector and its parser.
- `client.js` — Client half: one `conversation.composer.dock` registration (id `server-stats`,
  order 3) with the pill and its panel, localized through the Client locale service.
- `cordis.patch.yml` — the bundle patch that inserts the Host row.

## Companion tuning kit

The same repository carries the server-side kit this bundle was built alongside:

| Path | Purpose |
| --- | --- |
| [`scripts/tune-ubuntu.sh`](scripts/tune-ubuntu.sh) | idempotent Ubuntu VM tuning: sysctl, TCP BBR, `noatime`, io scheduler, journald cap, unused services, optional crashkernel release |
| [`scripts/remove-tencent-agents.sh`](scripts/remove-tencent-agents.sh) | removes Tencent Cloud 云镜/主机安全 and 云监控 agents, including their anti-uninstall watchdog |
| [`skills/ubuntu-server-tuning/SKILL.md`](skills/ubuntu-server-tuning/SKILL.md) | a DeepSeek Harness skill that tells an agent when and how to run the two scripts |

See [`scripts/README.md`](scripts/README.md) for the measured results and the
reasoning behind each setting. To use the skill inside DSH, copy
`skills/ubuntu-server-tuning/` into `~/.dsh/skills/` and make sure the
filesystem skill provider is enabled.

## Limitations

- Read-only: it never writes, restarts or runs commands on the target beyond the fixed collector.
- One host per bundle row. For several hosts, install the bundle twice with different ids/configs.
- Every poll is an SSH authentication; with the default 30 s that is ~2880 log lines per day in the
  target's `auth.log`. Raise `pollSeconds` if that matters.
- `sudo -n` is tried for the container count; hosts that require a password simply report `0`.

## License

MIT — see [LICENSE](LICENSE).
