#!/usr/bin/env bash
#
# tune-ubuntu.sh — opinionated, idempotent tuning for a small single-node Ubuntu
# cloud VM (roughly 1–8 GB RAM) that runs a web service or a handful of
# containers. Every section is independent and can be skipped with a flag.
#
# Why these settings (measured on a 4 GB Tencent Cloud CVM, Ubuntu 26.04,
# 2 vCPU, stock image with no tuning at all):
#
#   * crashkernel reservation: the stock image reserved 192 MB for kdump even
#     though nobody reads the dumps. Dropping it raised MemTotal from
#     3,807,984 kB to 4,004,592 kB. This is the single biggest win, and it is
#     the only item that needs a reboot.
#   * vm.swappiness 60 -> 10: with ~3 GB free there is no reason to page active
#     process memory out; the stock 60 causes needless swap-in latency.
#   * dirty ratios: stock allowed ~720 MB of dirty pages before writeback,
#     which turns one burst of writes into a multi-hundred-ms stall on a cloud
#     disk. Absolute byte limits (32 MB / 128 MB) bound that stall.
#   * TCP BBR + fq: better throughput on high-RTT / lossy paths than cubic;
#     the backlog and buffer limits below keep it from being the bottleneck on
#     load bursts.
#   * noatime: removes one metadata write per read; on a web host that serves a
#     lot of static files it is pure win.
#   * io scheduler none: virtio-blk has no seek cost, so the mq-deadline queue
#     only adds latency.
#   * journald cap: the stock config may grow to 10% of the disk; cap it.
#   * unused services: snapd, motd-news, update-notifier, e2scrub (no LVM),
#     lvm2-monitor, packagekit, fwupd — none of them serve a server workload.
#
# Everything this script writes is listed in the final report so it can be
# reverted by hand. Backups are written to /var/backups/server-tuning-<stamp>/.
#
# Usage:
#   sudo ./tune-ubuntu.sh [--dry-run] [--yes]
#        [--drop-crashkernel] [--purge-snapd]
#        [--no-sysctl] [--no-mount] [--no-io] [--no-journal] [--no-services]
#        [--no-cloudinit]
#
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
DROP_CRASHKERNEL=0
PURGE_SNAP=0
DO_SYSCTL=1
DO_MOUNT=1
DO_IO=1
DO_JOURNAL=1
DO_SERVICES=1
DO_CLOUDINIT=1

REBOOT_NEEDED=0
CHANGES=()
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/var/backups/server-tuning-${STAMP}"

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --drop-crashkernel) DROP_CRASHKERNEL=1 ;;
    --purge-snapd) PURGE_SNAP=1 ;;
    --no-sysctl) DO_SYSCTL=0 ;;
    --no-mount) DO_MOUNT=0 ;;
    --no-io) DO_IO=0 ;;
    --no-journal) DO_JOURNAL=0 ;;
    --no-services) DO_SERVICES=0 ;;
    --no-cloudinit) DO_CLOUDINIT=0 ;;
    --help|-h) usage ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# run <cmd...>: execute, or print when --dry-run. Records the change.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

# note <text>: record a change, and say plainly whether it was applied or only planned
note() {
  if [ "$DRY_RUN" = "1" ]; then
    CHANGES+=("would: $*")
    printf '  [dry-run] would: %s\n' "$*"
    return 0
  fi
  CHANGES+=("$*")
  printf '  + %s\n' "$*"
}

say() { printf '\n== %s\n' "$*"; }

# --- preconditions ---------------------------------------------------------

if [ "$(id -u)" != "0" ]; then
  echo "run as root (sudo $0)" >&2
  exit 1
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) echo "warning: tuned for Ubuntu/Debian, found ID=${ID:-unknown}; continuing in 5s" >&2; sleep 5 ;;
  esac
fi

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  read -r -p "Apply tuning as described in the header? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

say "summary"
echo "  dry-run=${DRY_RUN} drop-crashkernel=${DROP_CRASHKERNEL} purge-snapd=${PURGE_SNAP}"
echo "  sysctl=${DO_SYSCTL} mount=${DO_MOUNT} io=${DO_IO} journald=${DO_JOURNAL} services=${DO_SERVICES} cloudinit=${DO_CLOUDINIT}"
echo "  backups: ${BACKUP_DIR}"

run mkdir -p "$BACKUP_DIR"

# --- 1. sysctl: memory + TCP ----------------------------------------------

if [ "$DO_SYSCTL" = "1" ]; then
  say "sysctl (memory + TCP)"
  run tee /etc/sysctl.d/99-server-tuning.conf >/dev/null <<'EOF'
# Small single-node server profile (see scripts/tune-ubuntu.sh for rationale).
# --- memory ---
vm.swappiness = 10
vm.vfs_cache_pressure = 50
# Absolute dirty limits instead of ratios: a 4 GB box should not buffer
# hundreds of MB of dirty pages before writeback.
vm.dirty_background_bytes = 33554432
vm.dirty_bytes = 134217728
# --- TCP ---
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 4096
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fastopen = 3
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
EOF
  note "sysctl profile /etc/sysctl.d/99-server-tuning.conf"

  # BBR needs its module loaded before the sysctl can name it.
  if modinfo tcp_bbr >/dev/null 2>&1; then
    run modprobe tcp_bbr || true
    run tee /etc/modules-load.d/tcp_bbr.conf >/dev/null <<<'tcp_bbr'
    run tee /etc/sysctl.d/99-server-tuning-bbr.conf >/dev/null <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
EOF
    note "TCP BBR + fq"
  else
    echo "  ! tcp_bbr module unavailable; keeping the current congestion control"
  fi

  run sysctl --system >/dev/null
  echo "  swappiness=$(sysctl -n vm.swappiness 2>/dev/null || echo n/a)" \
       "cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo n/a)" \
       "qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo n/a)"
fi

# --- 2. noatime on / -------------------------------------------------------

if [ "$DO_MOUNT" = "1" ]; then
  say "noatime on /"
  run cp -a /etc/fstab "${BACKUP_DIR}/fstab"
  if awk '$2 == "/" && $4 ~ /(^|,)noatime(,|$)/ {found=1} END{exit !found}' /etc/fstab; then
    echo "  already set"
  else
    # Only rewrite the options field of the / row; leave everything else intact.
    run sed -i -E 's#^(\S+\s+/\s+\S+\s+)([^ \t]+)(\s)#\1\2,noatime\3#' /etc/fstab
    note "noatime on / in /etc/fstab"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] would remount / (now: $(findmnt -no OPTIONS /))"
  else
    mount -o remount / && echo "  remounted: $(findmnt -no OPTIONS /)"
  fi
fi

# --- 3. io scheduler -------------------------------------------------------

if [ "$DO_IO" = "1" ]; then
  say "io scheduler"
  run tee /etc/udev/rules.d/60-io-scheduler.rules >/dev/null <<'EOF'
# virtio-blk / vd* devices are SSD-backed: no seek cost, so skip the queue.
ACTION=="add|change", KERNEL=="vd*", ATTR{queue/scheduler}="none"
ACTION=="add|change", KERNEL=="vd*", ATTR{queue/read_ahead_kb}="256"
EOF
  note "io scheduler rule /etc/udev/rules.d/60-io-scheduler.rules"
  run udevadm control --reload-rules || true
  for dev in /sys/block/vd*; do
    [ -e "${dev}/queue/scheduler" ] || continue
    run bash -c "echo none > '${dev}/queue/scheduler'"
    run bash -c "echo 256 > '${dev}/queue/read_ahead_kb'"
  done
  echo "  current: $(cat /sys/block/vda/queue/scheduler 2>/dev/null || echo 'no vda')"
fi

# --- 4. journald cap -------------------------------------------------------

if [ "$DO_JOURNAL" = "1" ]; then
  say "journald cap"
  run mkdir -p /etc/systemd/journald.conf.d
  run tee /etc/systemd/journald.conf.d/60-cap.conf >/dev/null <<'EOF'
# Keep journals bounded: the stock default can grow to 10% of the disk.
[Journal]
SystemMaxUse=100M
SystemMaxFileSize=20M
RuntimeMaxUse=64M
MaxRetentionSec=14day
EOF
  note "journald cap /etc/systemd/journald.conf.d/60-cap.conf"
  run systemctl restart systemd-journald
  journalctl --disk-usage || true
fi

# --- 5. unused services and timers ----------------------------------------

if [ "$DO_SERVICES" = "1" ]; then
  say "unused services"
  # disabled+stopped where the unit exists and is enabled
  for unit in motd-news.timer update-notifier-download.timer \
              update-notifier-motd.timer e2scrub_all.timer e2scrub_reap.service; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1; then
      if systemctl is-enabled "$unit" >/dev/null 2>&1; then
        run systemctl disable --now "$unit" >/dev/null 2>&1 || true
        note "disabled ${unit}"
      fi
    fi
  done
  # only when no LVM volume group exists
  if [ -z "$(vgs --noheadings -o vg_name 2>/dev/null | tr -d ' ')" ]; then
    if systemctl is-enabled lvm2-monitor.service >/dev/null 2>&1; then
      run systemctl disable --now lvm2-monitor.service >/dev/null 2>&1 || true
      note "disabled lvm2-monitor.service (no volume groups)"
    fi
  fi
  # D-Bus activated helpers come back after 'disable', so mask them
  for unit in packagekit.service packagekit-offline-update.service fwupd.service; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1 && [ ! -L "/etc/systemd/system/${unit}" ]; then
      run systemctl mask "$unit" >/dev/null 2>&1 || true
      note "masked ${unit}"
    fi
  done
  if [ "$PURGE_SNAP" = "1" ]; then
    if command -v snap >/dev/null 2>&1 && [ -z "$(snap list 2>/dev/null | tail -n +2)" ]; then
      run systemctl disable --now snapd.service snapd.socket >/dev/null 2>&1 || true
      run env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq snapd >/dev/null 2>&1 || true
      note "purged snapd (no snaps installed)"
    else
      echo "  ! snapd kept: snaps are installed or snapd is absent"
    fi
  fi
fi

# --- 6. crashkernel reservation (biggest memory win, needs reboot) --------

if [ "$DROP_CRASHKERNEL" = "1" ]; then
  say "crashkernel reservation"
  current="$(cat /sys/kernel/kexec_crash_size 2>/dev/null || echo 0)"
  if [ "$current" = "0" ]; then
    echo "  already released"
  else
    echo "  currently reserved: $((current / 1024 / 1024)) MB"
    run cp -a /etc/default/grub "${BACKUP_DIR}/grub"
    run cp -a /boot/grub/grub.cfg "${BACKUP_DIR}/grub.cfg" 2>/dev/null || true
    if grep -q 'crashkernel=' /etc/default/grub; then
      run sed -i -E 's/ ?crashkernel=[^ "]*//' /etc/default/grub
      note "crashkernel= removed from /etc/default/grub"
    fi
    if [ -f /etc/default/kdump-tools ]; then
      run sed -i 's/^USE_KDUMP=1/USE_KDUMP=0/' /etc/default/kdump-tools
      run systemctl disable --now kdump-tools >/dev/null 2>&1 || true
      note "kdump-tools disabled (USE_KDUMP=0)"
    fi
    run update-grub >/dev/null
    if grep -q 'crashkernel=' /boot/grub/grub.cfg; then
      echo "  ! crashkernel still present in grub.cfg — inspect before rebooting" >&2
    else
      note "grub.cfg regenerated without a crashkernel reservation (reboot to apply)"
      REBOOT_NEEDED=1
    fi
  fi
fi

# --- 7. cloud-init guard ---------------------------------------------------

if [ "$DO_CLOUDINIT" = "1" ] && [ -d /etc/cloud ]; then
  say "cloud-init guard"
  # Provisioning is done once; letting cloud-init rewrite networking later can
  # cut the SSH session to a remote box.
  run tee /etc/cloud/cloud.cfg.d/99-server-tuning-no-network.cfg >/dev/null <<'EOF'
# Keep cloud-init away from networking on an already provisioned host.
network:
  config: disabled
EOF
  note "cloud-init network config disabled (hostname preserved)"
  run tee /etc/cloud/cloud.cfg.d/99-server-tuning-hostname.cfg >/dev/null <<'EOF'
preserve_hostname: true
EOF
fi

# --- 8. repair a corrupt grubenv (a failed grub2-common.service) ----------

say "grub environment block"
if [ -f /boot/grub/grubenv ] && ! grub-editenv /boot/grub/grubenv list >/dev/null 2>&1; then
  run cp -a /boot/grub/grubenv "${BACKUP_DIR}/grubenv" 2>/dev/null || true
  run rm -f /boot/grub/grubenv
  run grub-editenv /boot/grub/grubenv create
  run systemctl restart grub2-common.service >/dev/null 2>&1 || true
  note "corrupt /boot/grub/grubenv recreated"
else
  echo "  ok"
fi

# --- report ---------------------------------------------------------------

say "result"
printf '  MemTotal: %s kB\n' "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
printf '  crashkernel: %s bytes reserved\n' "$(cat /sys/kernel/kexec_crash_size 2>/dev/null || echo n/a)"
printf '  failed units: %s\n' "$(systemctl --failed --no-legend --no-pager 2>/dev/null | wc -l)"
echo "  changes:"
for change in "${CHANGES[@]:-}"; do printf '    * %s\n' "$change"; done
echo "  backups: ${BACKUP_DIR}"

if [ "$REBOOT_NEEDED" = "1" ]; then
  printf '\n!! reboot required for the crashkernel change: sudo systemctl reboot\n'
fi

printf '\nRevert hints:\n'
printf '  rm -f /etc/sysctl.d/99-server-tuning*.conf /etc/modules-load.d/tcp_bbr.conf\n'
printf '  rm -f /etc/udev/rules.d/60-io-scheduler.rules /etc/systemd/journald.conf.d/60-cap.conf\n'
printf '  restore /etc/fstab and /etc/default/grub from %s, then update-grub\n' "$BACKUP_DIR"
