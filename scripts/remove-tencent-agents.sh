#!/usr/bin/env bash
#
# remove-tencent-agents.sh — remove the Tencent Cloud host agents from an Ubuntu
# CVM/Lighthouse instance: 云镜/主机安全 (YDService + YDLive) and 云监控
# (barad_agent + stargate/sgagent). The 自动化助手 (tat_agent) is kept by default
# because it is also a useful remote-execution path.
#
# Why this is not just `rm -rf`:
#
#   云镜 ships an anti-uninstall watchdog. On the test host, deleting
#   /usr/local/qcloud/YunJing while it ran brought the whole directory back
#   within ~60 s — same mtimes, cron.d/yunjing recreated, YDService + YDLive
#   respawned. The watchdog lived in its own cgroup (/YunJing/YDEyes) as a
#   process whose cmdline was disguised as `/bin/sh -c sleep 100` (78 MB RSS for
#   a `dash`!). Its official uninstaller (uninst.sh, a Go binary) refuses to run
#   without a verification code from the 主机安全 console, so the only local path
#   is: cut its re-download channel, kill the cgroup members, then delete.
#
#   The agent talks to the CWP endpoint on 183.60.117.161:5574. Blocking that IP
#   in OUTPUT stops the re-download; the rule is temporary (not persisted) and
#   disappears on reboot. Delete it with:
#       sudo iptables -D OUTPUT -d 183.60.117.161 -j REJECT
#
# Consequences you accept by running this:
#   * 主机安全 shows the agent as missing/offline in the console
#   * 云监控 stops collecting this instance's metrics
#   * reinstalling from the console needs the egress block removed first
#
# Usage:
#   sudo ./remove-tencent-agents.sh [--dry-run] [--yes]
#        [--skip-yunjing] [--skip-monitor] [--remove-tat] [--no-egress-block]
#
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
DO_YUNJING=1
DO_MONITOR=1
DO_TAT=0
EGRESS_BLOCK=1

CWP_IP="${CWP_IP:-183.60.117.161}"
YUNJING_DIR="/usr/local/qcloud/YunJing"
STARGATE_DIR="/usr/local/qcloud/stargate"
MONITOR_DIR="/usr/local/qcloud/monitor"

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-yunjing) DO_YUNJING=0 ;;
    --skip-monitor) DO_MONITOR=0 ;;
    --remove-tat) DO_TAT=1 ;;
    --no-egress-block) EGRESS_BLOCK=0 ;;
    --help|-h) usage ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}
say() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" != "0" ]; then echo "run as root (sudo $0)" >&2; exit 1; fi

if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
  echo "This removes 云镜/主机安全 and 云监控 agents; the console will show them offline."
  read -r -p "Continue? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

say "before"
free -m | head -2
ps -eo rss,args | grep -E 'YDService|YDLive|barad_agent|sgagent' | grep -v grep || echo "  (no agent processes found)"

# --- 1. cut the re-download channel --------------------------------------
# Must happen before the kill, otherwise the watchdog simply fetches the agent
# back. The IP is only reachable while an agent connects out, so this is safe
# for an unrelated workload; remove the rule if you ever reinstall the agent.
if [ "$EGRESS_BLOCK" = "1" ] && [ "$DO_YUNJING" = "1" ]; then
  say "block CWP egress (${CWP_IP})"
  if iptables -C OUTPUT -d "$CWP_IP" -j REJECT >/dev/null 2>&1; then
    echo "  rule already present"
  else
    run iptables -I OUTPUT 1 -d "$CWP_IP" -j REJECT
    echo "  added temporary OUTPUT REJECT (not persisted across reboot)"
  fi
fi

# --- 2. 云镜 / 主机安全 ---------------------------------------------------
if [ "$DO_YUNJING" = "1" ]; then
  say "云镜 YunJing"
  # cron re-creates the agent on a 30-minute schedule and at boot; drop it first
  if [ -f /etc/cron.d/yunjing ]; then
    run rm -f /etc/cron.d/yunjing
    echo "  removed /etc/cron.d/yunjing"
  fi

  # kill every process inside the agent's cgroups, including the disguised
  # watchdog, before touching the files
  for pid in $(ps -eo pid --no-headers); do
    cg="$(cat "/proc/${pid}/cgroup" 2>/dev/null | head -1 || true)"
    case "$cg" in
      *YunJing*)
        echo "  killing pid=${pid} (${cg})"
        run kill -9 "$pid" 2>/dev/null || true
        ;;
    esac
  done

  if [ -x "${YUNJING_DIR}/stopYDCore.sh" ]; then
    run bash -c "'${YUNJING_DIR}/stopYDCore.sh' >/dev/null 2>&1 || true"
  fi
  for name in YDService YDLive YDEdr; do
    run pkill -9 -f "$name" 2>/dev/null || true
  done

  # the agent sets immutable bits on its own tree
  run chattr -R -i "$YUNJING_DIR" 2>/dev/null || true
  run rm -rf "$YUNJING_DIR" /var/lib/qcloud/YunJing
  # empty leftover cgroup; disappears on reboot if the kernel still holds it
  run rmdir /sys/fs/cgroup/YunJing/YDEyes /sys/fs/cgroup/YunJing 2>/dev/null || true
  echo "  removed ${YUNJING_DIR}"
fi

# --- 3. 云监控 / stargate -------------------------------------------------
if [ "$DO_MONITOR" = "1" ]; then
  say "云监控 stargate + barad"
  # root crontab: the 5-minute start.sh line, and /etc/cron.d/sgagenttask
  if crontab -l 2>/dev/null | grep -q 'stargate'; then
    run bash -c "crontab -l 2>/dev/null | grep -v 'stargate' | crontab -"
    echo "  removed stargate line from root crontab"
  fi
  run rm -f /etc/cron.d/sgagenttask

  if [ -x "${STARGATE_DIR}/admin/uninstall.sh" ]; then
    run bash -c "'${STARGATE_DIR}/admin/uninstall.sh' >/dev/null 2>&1 || true"
  elif [ -x "${STARGATE_DIR}/admin/stop.sh" ]; then
    run bash -c "'${STARGATE_DIR}/admin/stop.sh' >/dev/null 2>&1 || true"
  fi
  for name in barad_agent sgagent; do
    run pkill -9 -f "$name" 2>/dev/null || true
  done
  run rm -rf "$STARGATE_DIR" "$MONITOR_DIR"
  echo "  removed ${STARGATE_DIR} and ${MONITOR_DIR}"
fi

# --- 4. 自动化助手 (kept by default) --------------------------------------
if [ "$DO_TAT" = "1" ]; then
  say "自动化助手 tat_agent"
  run systemctl disable --now tat_agent.service 2>/dev/null || true
  echo "  disabled tat_agent.service (console can no longer run commands here)"
else
  say "自动化助手 tat_agent (kept)"
  systemctl is-active tat_agent.service 2>/dev/null || true
fi

# --- 5. prove it stays gone ----------------------------------------------
# The watchdog needed ~60 s to revive the agent on the test host; watch a little
# longer than that so a silent respawn shows up here instead of a week later.
if [ "$DRY_RUN" != "1" ]; then
  say "watching 90s for a respawn"
  sleep 90
  left="$(pgrep -fc 'YunJing|YDService|YDLive|barad_agent|sgagent' 2>/dev/null || true)"
  echo "  matching processes: ${left:-0}"
  pgrep -af 'YunJing|YDService|YDLive|barad_agent|sgagent' 2>/dev/null || echo "  (none)"
  if [ -d "$YUNJING_DIR" ]; then echo "  ! ${YUNJING_DIR} came back" >&2; else echo "  ${YUNJING_DIR} stays gone"; fi
  ls /etc/cron.d/
fi

say "after"
free -m | head -2
ls -d "$YUNJING_DIR" "$STARGATE_DIR" 2>/dev/null || echo "  agent directories removed"
printf '  remaining qcloud tree:\n'
du -sh /usr/local/qcloud/* 2>/dev/null | sed 's/^/    /' || true

printf '\nRevert / reinstall notes:\n'
printf '  the console can reinstall the agents; first remove the egress block:\n'
printf '    sudo iptables -D OUTPUT -d %s -j REJECT\n' "$CWP_IP"
printf '  re-enable the assistant if it was disabled: sudo systemctl enable --now tat_agent\n'
