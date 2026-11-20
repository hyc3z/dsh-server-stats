# Server tuning scripts

Two companion scripts for the hosts this bundle monitors. They come from a real
cleanup of a 4 GB Tencent Cloud CVM running stock Ubuntu 26.04 — every number in
the comments was measured there.

| Script | What it does | Risk |
| --- | --- | --- |
| [`tune-ubuntu.sh`](tune-ubuntu.sh) | sysctl (memory + TCP BBR), `noatime`, io scheduler, journald cap, unused services, optional crashkernel release, cloud-init network guard | low; each section has a flag and writes a backup |
| [`remove-tencent-agents.sh`](remove-tencent-agents.sh) | removes 云镜/主机安全 (YDService, YDLive) and 云监控 (barad_agent, stargate) | medium; the console shows those agents offline afterwards |

Both are idempotent, start with `--dry-run`, and print a revert hint at the end.

## Quick start

```bash
sudo ./tune-ubuntu.sh --dry-run                    # see the plan
sudo ./tune-ubuntu.sh --yes                        # apply everything except crashkernel
sudo ./tune-ubuntu.sh --yes --drop-crashkernel     # also release the 192 MB reservation (reboot)
sudo ./tune-ubuntu.sh --yes --purge-snapd          # also remove snapd when no snaps exist

sudo ./remove-tencent-agents.sh --dry-run
sudo ./remove-tencent-agents.sh --yes              # removes both agents, keeps tat_agent
```

Recommended order: tune first, reboot if you dropped crashkernel, then remove
agents. Measured result on the reference host (2 vCPU / 4 GB, k3s + ArgoCD
replaced by Podman): available memory went from **2092 MB to 3278 MB**, disk
from 11 G to 6.2 G, running services from 24 to 16.

## What `--drop-crashkernel` is worth

The stock image reserves 192 MB for kdump (`crashkernel=…,3G-8G:192M`). On a
4 GB host that is 5% of RAM held for a dump nobody reads. Removing it raised
`MemTotal` from `3,807,984 kB` to `4,004,592 kB`. It rewrites `/etc/default/grub`,
runs `update-grub`, disables `kdump-tools`, and needs one reboot.

## Why removing the Tencent agents is not a plain `rm -rf`

云镜 ships an anti-uninstall watchdog: after deleting `/usr/local/qcloud/YunJing`
it re-downloaded itself within ~60 s (same mtimes, `cron.d/yunjing` recreated,
both processes respawned). The watchdog ran in its own cgroup `/YunJing/YDEyes`
with a disguised command line. The script therefore:

1. adds a temporary `iptables` OUTPUT reject for the CWP endpoint
   (`183.60.117.161`) — the re-download path,
2. kills every PID whose cgroup mentions `YunJing` (the disguised watchdog too),
3. removes the cron entries, the directories, and the empty cgroup,
4. waits 90 s and reports whether anything came back.

The temporary iptables rule does not survive a reboot; remove it manually before
reinstalling an agent from the console.

## Convenience helpers

```bash
# what actually holds memory, in anonymous-vs-page-cache terms
sudo systemd-cgtop -m -b -n1 --depth=2 | head -20
# anon = real pressure, file = reclaimable page cache
for f in /sys/fs/cgroup/system.slice/*/memory.stat; do
  unit=$(basename "$(dirname "$f")")
  anon=$(awk '/^anon /{printf "%d", $2/1048576}' "$f")
  printf '%6s MB  %s\n' "$anon" "$unit"
done | sort -rn | head -10

# did the tuning stick?
sysctl vm.swappiness net.ipv4.tcp_congestion_control net.core.default_qdisc
findmnt -no OPTIONS /
cat /sys/block/vda/queue/scheduler
```
