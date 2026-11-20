---
name: ubuntu-server-tuning
description: Use when auditing, slimming, or tuning a small single-node Ubuntu/Debian cloud VM (roughly 1–8 GB RAM, 1–2 vCPU) — the user says the box is "wasting" CPU or memory, asks why most RAM is gone on an idle server, wants to drop a Kubernetes/GitOps stack, or wants to remove cloud-vendor monitoring/security agents. Ships an idempotent tuning script and a Tencent Cloud agent remover, plus the measurement routine behind them.
---

# Ubuntu server tuning

Apply the measured profile from a real cleanup: a 4 GB Tencent Cloud CVM
running a stock Ubuntu image, where a k3s + ArgoCD stack plus vendor agents kept
~1.7 GB busy on an idle box. After tuning: available memory 2092 MB -> 3278 MB,
disk 11 G -> 6.2 G, running services 24 -> 16.

Loading this skill authorizes nothing by itself. Changing sysctls, GRUB, or
removing vendor agents needs the user's go-ahead, and a reboot needs one too.

## Measure before changing anything

Never start from `free`'s "used" number: on Linux it counts reclaimable page
cache, which is the single most common false conclusion ("2 GB vanished on an
idle server").

```bash
# total RAM vs what the VM spec promised (the gap is often kdump, not processes)
awk '/^MemTotal:/{printf "MemTotal %d MB\n", $2/1024}' /proc/meminfo
free -m
cat /sys/kernel/kexec_crash_size          # crashkernel reservation in bytes

# real pressure per service: anon is memory, file is cache
for f in /sys/fs/cgroup/system.slice/*/memory.stat; do
  unit=$(basename "$(dirname "$f")")
  anon=$(awk '/^anon /{printf "%d", $2/1048576}' "$f")
  printf '%6s MB  %s\n' "$anon" "$unit"
done | sort -rn | head -10

# what a container platform actually costs
sudo systemd-cgtop -m -b -n1 --depth=2 | head -20
sudo kubectl top pods -A --sort-by=memory 2>/dev/null | head -15
```

Report numbers as a table of `anon / RSS / total`, and name the biggest line
item with its cgroup before proposing anything.

## The two scripts

Both live in `scripts/` of this repository (copy them to the target host, for
example `scp scripts/*.sh host:/tmp/`):

- `tune-ubuntu.sh` — sysctl (swappiness, absolute dirty limits, TCP buffers,
  BBR + fq), `noatime` on `/`, io scheduler `none` for virtio, journald cap,
  unused services/timers (snapd, motd-news, update-notifier, e2scrub,
  lvm2-monitor, packagekit/fwupd masked), optional crashkernel release, and a
  cloud-init guard that stops it rewriting networking.
- `remove-tencent-agents.sh` — removes 云镜/主机安全 (YDService, YDLive) and
  云监控 (barad_agent, stargate), handling the anti-uninstall watchdog.

Always run `--dry-run` first, then apply with `--yes`:

```bash
sudo ./tune-ubuntu.sh --dry-run
sudo ./tune-ubuntu.sh --yes                       # everything except crashkernel
sudo ./tune-ubuntu.sh --yes --drop-crashkernel    # +192 MB on a 4 GB host, reboots
sudo ./remove-tencent-agents.sh --dry-run
sudo ./remove-tencent-agents.sh --yes
```

## Rules that matter

1. **Page cache is not waste.** Only propose changes that reduce anon memory or
   inode/service count; never chase `buff/cache`.
2. **crashkernel is the biggest single win** (192 MB of a 4 GB host) and the
   only item needing a reboot. It costs crash dumps: say so before running it,
   and never drop it on a host the user debugs kernel panics on. Verify with
   `MemTotal` before/after — expected +192 MB, and `/sys/kernel/kexec_crash_size`
   reading 0.
3. **Never disable networking from cloud-init** without proving SSH survives:
   the script writes `network: {config: disabled}` before anything else, and the
   change only shows on the next boot. Reboot once, verify SSH, and keep the
   console/VNC path available before requiring a remote reboot.
4. **Vendor agents fight back.** 云镜 restores itself from the CWP endpoint
   within ~60 s; its official `uninst.sh` needs a console verification code. The
   script blocks `183.60.117.161` in OUTPUT (temporary, lost on reboot), kills
   every PID whose cgroup mentions `YunJing` — including a watchdog disguised as
   `/bin/sh -c sleep 100` — then deletes. Expect the console to show the agent
   offline afterwards, and tell the user that reinstalling requires removing the
   iptables rule.
5. **`tat_agent` is a decision, not a default.** It is 4 MB and enables console
   remote execution; removing it also removes the vendor's ability to run
   commands. Keep it unless the user asks for a fully isolated host.
6. **Keep the Tencent kernel cmdline.** `intel_idle.max_cstate=1`,
   `processor.max_cstate=1`, `intel_pstate=disable` trade power for wake-up
   latency — correct for a server, so leave them alone.
7. **Backups or it did not happen.** The script writes
   `/var/backups/server-tuning-<stamp>/` (fstab, grub, grubenv); quote that path
   in the final report together with the revert hints it prints.

## Verify, then report

```bash
sysctl vm.swappiness net.ipv4.tcp_congestion_control net.core.default_qdisc
findmnt -no OPTIONS /
cat /sys/block/vda/queue/scheduler
systemctl --failed --no-pager
systemctl list-units --type=service --state=running --no-legend | wc -l
free -m; df -h /
```

A passing run shows `swappiness = 10`, `bbr`, `fq`, `rw,noatime`,
`[none]`, zero failed units, and the workload's health checks still green.
Report before/after as a table, list what was skipped and why, and state plainly
what remains unverified (for example a service that has not run its first
scheduled execution yet).
