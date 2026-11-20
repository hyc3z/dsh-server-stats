/**
 * Host half of dsh-server-stats.
 *
 * The browser half draws one pill in `conversation.composer.dock`; this half
 * answers one read-only JSON route with a live snapshot of a remote POSIX host,
 * read over OpenSSH:
 *
 * | Method | Path                      | Effect                                        |
 * |--------|---------------------------|-----------------------------------------------|
 * | GET    | `/dsh-server-stats/stats` | `{ ok, status, config, stats? }`              |
 *
 * The remote side runs one read-only script (`/proc`, `df`, `podman`/`docker
 * ps`); it writes nothing, needs no daemon and no installed agent. Results are
 * cached briefly so concurrent polls collapse into one SSH round trip, and a
 * failed read answers `status: 'unreachable'` instead of throwing.
 *
 * Configuration precedence: the Loader row's `config` mapping wins over
 * `$DSH_HOME/server-stats.json`. Both are optional; without a `target` the
 * route reports `status: 'unconfigured'` and the pill says so.
 *
 * @module dsh-server-stats
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Snapshot route the browser half reads. */
export const STATS_ROUTE = '/dsh-server-stats/stats'

/** Cordis services this plugin needs before `apply` runs. */
export const inject = ['webServer']

/** Coalesce polls that land inside this window into one SSH call. */
const CACHE_MS = 4000

/** Default SSH round-trip ceiling. */
const DEFAULT_TIMEOUT_MS = 8000

/** Settings the route echoes to the browser half. */
const DEFAULTS = {
  /** SSH destination: a `~/.ssh/config` alias or `user@host`. */
  target: '',
  /** Private key path; empty uses ssh-agent or `~/.ssh/config`. */
  identityFile: '',
  /** SSH port; 0 keeps the default. */
  port: 0,
  /** systemd units to report; empty hides the row. */
  services: [],
  /** Report a container count when podman or docker answers. */
  containers: true,
  /** Browser refresh period in seconds (clamped 5..600). */
  pollSeconds: 30,
  /** ssh round-trip ceiling in milliseconds (clamped 1000..60000). */
  timeoutMs: DEFAULT_TIMEOUT_MS,
}

/** Only safe unit names reach the remote shell. */
const UNIT_NAME = /^[A-Za-z0-9@:._-]{1,120}$/

/**
 * Read `$DSH_HOME/server-stats.json`, if present.
 * @returns a partial settings object.
 */
function readConfigFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'server-stats.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Merge defaults, the config file, and the Loader row config.
 * @param row - the row's `config` mapping, when configured.
 * @returns normalized settings.
 */
function resolveConfig(row) {
  const merged = { ...DEFAULTS, ...readConfigFile(), ...(row ?? {}) }
  const services = Array.isArray(merged.services)
    ? merged.services.filter((unit) => typeof unit === 'string' && UNIT_NAME.test(unit))
    : []
  const port = Number(merged.port)
  const pollSeconds = Number(merged.pollSeconds)
  const timeoutMs = Number(merged.timeoutMs)
  return {
    target: typeof merged.target === 'string' ? merged.target.trim() : '',
    identityFile: typeof merged.identityFile === 'string' ? merged.identityFile.trim() : '',
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 0,
    services,
    containers: merged.containers !== false,
    pollSeconds: Number.isFinite(pollSeconds) ? Math.min(600, Math.max(5, Math.round(pollSeconds))) : DEFAULTS.pollSeconds,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.min(60000, Math.max(1000, Math.round(timeoutMs))) : DEFAULT_TIMEOUT_MS,
  }
}

/**
 * Build the remote collector for one configuration.
 *
 * Two `/proc/stat` samples derive the CPU percentage; everything else is a
 * single read. The container count tries rootless first, then `sudo -n`, then
 * docker, and reports `engine=none` when no runtime answers, so the same script
 * works on a plain VM and on a container host.
 *
 * @param settings - normalized settings.
 * @returns POSIX sh script.
 */
function buildCollector(settings) {
  const serviceProbe = settings.services.length === 0
    ? 'printf "services=\\n"'
    : `printf "services=%s\\n" "$(systemctl is-active ${settings.services.map((unit) => `'${unit}'`).join(' ')} 2>/dev/null | tr '\\n' ',' | sed 's/,$//')"`

  const containerProbe = settings.containers
    ? String.raw`
engine=none
count=0
for cmd in podman docker; do
  command -v "$cmd" >/dev/null 2>&1 || continue
  engine=$cmd
  if "$cmd" ps -q >/dev/null 2>&1; then
    count=$("$cmd" ps -q 2>/dev/null | wc -l | tr -d ' ')
  fi
  if [ "$count" -eq 0 ] && sudo -n "$cmd" ps -q >/dev/null 2>&1; then
    count=$(sudo -n "$cmd" ps -q 2>/dev/null | wc -l | tr -d ' ')
  fi
  break
done
printf "containers=%s\nengine=%s\n" "$count" "$engine"
`
    : 'printf "containers=\nengine=\n"'

  return String.raw`
cpu1=$(awk '/^cpu /{t=0; for(i=2;i<=8;i++) t+=$i; print t, $5+$6; exit}' /proc/stat)
sleep 0.3
cpu2=$(awk '/^cpu /{t=0; for(i=2;i<=8;i++) t+=$i; print t, $5+$6; exit}' /proc/stat)
awk -v a="$cpu1" -v b="$cpu2" 'BEGIN{
  split(a, x, " "); split(b, y, " ");
  dt = y[1] - x[1]; di = y[2] - x[2];
  printf "cpu_pct=%.1f\n", (dt > 0) ? (dt - di) / dt * 100 : 0
}'
awk '/^MemTotal:/{printf "mem_total_kb=%d\n", $2}
     /^MemAvailable:/{printf "mem_avail_kb=%d\n", $2}
     /^SwapTotal:/{printf "swap_total_kb=%d\n", $2}
     /^SwapFree:/{printf "swap_free_kb=%d\n", $2}' /proc/meminfo
awk '{printf "load=%s\n", $1" "$2" "$3; exit}' /proc/loadavg
awk '{printf "uptime_s=%d\n", $1; exit}' /proc/uptime
df -P / | awk 'NR==2{printf "disk_total_kb=%d\ndisk_used_kb=%d\ndisk_pct=%s\n", $2, $3, $5}'
${containerProbe}
${serviceProbe}
`
}

/**
 * Run the collector over SSH.
 * @param settings - normalized settings.
 * @returns parsed snapshot.
 */
function collect(settings) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
  ]
  if (settings.port > 0) args.push('-p', String(settings.port))
  if (settings.identityFile.length > 0) args.push('-i', settings.identityFile, '-o', 'IdentitiesOnly=yes')
  args.push(settings.target, buildCollector(settings))

  return new Promise((resolve, reject) => {
    execFile('ssh', args, { timeout: settings.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        // Keep the route answer small: one diagnostic line, never the whole argv.
        const stderrLine = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim().split(/\r?\n/)[0] : ''
        const messageLine = String(error.message ?? error).split(/\r?\n/)[0]
        reject(new Error((stderrLine || messageLine).slice(0, 240)))
        return
      }
      try {
        resolve(parseSnapshot(stdout, settings))
      } catch (parseError) {
        reject(parseError)
      }
    })
  })
}

/**
 * Turn the collector's `key=value` output into a snapshot.
 * @param text - collector stdout.
 * @param settings - normalized settings, echoed into the snapshot.
 * @returns snapshot object.
 */
function parseSnapshot(text, settings) {
  const raw = new Map()
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    raw.set(line.slice(0, index).trim(), line.slice(index + 1).trim())
  }
  const num = (key) => {
    const value = Number(raw.get(key))
    return Number.isFinite(value) ? value : 0
  }
  if (!raw.has('mem_total_kb')) throw new Error('collector returned no memory data')
  const toMb = (kb) => Math.round(kb / 1024)
  const memTotal = num('mem_total_kb')
  const memAvail = num('mem_avail_kb')
  const swapTotal = num('swap_total_kb')
  const swapFree = num('swap_free_kb')
  const services = (raw.get('services') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return {
    at: new Date().toISOString(),
    target: settings.target,
    cpuPct: num('cpu_pct'),
    load: raw.get('load') ?? '',
    uptimeSec: num('uptime_s'),
    memTotalMb: toMb(memTotal),
    memUsedMb: toMb(Math.max(0, memTotal - memAvail)),
    memAvailMb: toMb(memAvail),
    swapTotalMb: toMb(swapTotal),
    swapUsedMb: toMb(Math.max(0, swapTotal - swapFree)),
    diskTotalGb: Math.round(num('disk_total_kb') / 1048576),
    diskUsedGb: Math.round((num('disk_used_kb') / 1048576) * 10) / 10,
    diskPct: raw.get('disk_pct') ?? '',
    containers: settings.containers ? num('containers') : null,
    engine: raw.get('engine') ?? '',
    services: settings.services.map((unit, index) => ({ unit, state: services[index] ?? 'unknown' })),
  }
}

/**
 * Register the snapshot route.
 * @param ctx - Host context with the `webServer` service.
 * @param rowConfig - the Loader row's `config` mapping, when configured.
 */
export function apply(ctx, rowConfig) {
  let cached = null
  let cachedAt = 0
  let inflight = null

  const read = () => {
    // Resolved per request so edits to the config file apply on the next poll;
    // a change to the row's own config restarts the plugin anyway.
    const settings = resolveConfig(rowConfig)
    const configNote = {
      target: settings.target,
      pollSeconds: settings.pollSeconds,
      services: settings.services,
    }
    if (settings.target.length === 0) return Promise.resolve({ status: 'unconfigured', config: configNote })
    const now = Date.now()
    if (cached !== null && cachedAt !== 0 && now - cachedAt < CACHE_MS && cached.target === settings.target) {
      return Promise.resolve(cached.payload)
    }
    if (inflight !== null) return inflight
    inflight = (async () => {
      try {
        const stats = await collect(settings)
        const payload = { status: 'ready', config: configNote, stats }
        cached = { target: settings.target, payload }
        cachedAt = Date.now()
        return payload
      } catch (error) {
        return { status: 'unreachable', config: configNote, error: String(error?.message ?? error) }
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATS_ROUTE,
    handler: async (request, response) => {
      const method = String(request.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        respond(response, 405, { ok: false, error: 'method not allowed' }, false)
        return
      }
      const payload = await read()
      respond(response, 200, { ok: true, ...payload }, method === 'HEAD')
    },
  }), 'server-stats: stats route')
}

/**
 * Write one JSON response.
 * @param response - response to complete.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 * @param headOnly - omit the body (HEAD requests).
 */
function respond(response, status, payload, headOnly) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(headOnly ? undefined : body)
}
