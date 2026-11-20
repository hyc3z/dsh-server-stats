/**
 * Server-stats pill.
 *
 * One `conversation.composer.dock` entry beside the composer statistics: a
 * server icon with the remote host's CPU percentage and used memory. Clicking
 * it opens a small panel with load, memory, swap, disk, container count,
 * configured systemd units and uptime. Values come from this bundle's Host half
 * (`/dsh-server-stats/stats`), which reads them over SSH; the page never talks
 * to the remote host directly and no model request is made.
 */
window.__ModuleLoader__.load({
  id: 'dsh-server-stats',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    /** Portal so the panel escapes the composer's clipping. */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (typeof reactDom?.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      /* the inline fallback still renders the panel */
    }

    /** Locale namespace for tooltip and panel copy. */
    const NS = 'server-stats'
    /** Fallback refresh period; the route's configured value wins. */
    const DEFAULT_POLL_MS = 30000
    /** Route served by the Host half. */
    const ROUTE = '/dsh-server-stats/stats'
    /** Panel width used by the placement math. */
    const PANEL_WIDTH = 268
    /** `<style>` element id owned by this plugin. */
    const STYLE_ID = 'dsh-server-stats-style'

    const DICT = {
      zh: {
        title: '服务器状态',
        loading: '正在读取…',
        unreachable: '离线',
        unconfigured: '未配置',
        configure: '还没有配置 SSH 目标：在插件设置里填 target，或写 ~/.dsh/server-stats.json',
        host: '主机',
        load: '负载',
        memory: '内存',
        swap: 'Swap',
        disk: '磁盘',
        containers: '容器',
        services: '服务',
        uptime: '运行时长',
        updated: '更新于',
        refresh: '刷新',
        open: '查看服务器状态',
        cpu: 'CPU',
      },
      en: {
        title: 'Server status',
        loading: 'Reading…',
        unreachable: 'Offline',
        unconfigured: 'Not set up',
        configure: 'No SSH target configured: set target in the plugin settings, or write ~/.dsh/server-stats.json',
        host: 'Host',
        load: 'Load',
        memory: 'Memory',
        swap: 'Swap',
        disk: 'Disk',
        containers: 'Containers',
        services: 'Services',
        uptime: 'Uptime',
        updated: 'Updated',
        refresh: 'Refresh',
        open: 'Show server status',
        cpu: 'CPU',
      },
    }

    const CSS = `
.dsh-ss-anchor {
  display: inline-flex;
  min-width: 0;
  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-ss-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-ss-pill svg { width: 14px; height: 14px; flex: none; }
.dsh-ss-pill[data-warn] { color: var(--dsw-alias-state-warn-label, inherit); }
.dsh-ss-pill[data-muted] { opacity: 0.6; }
.dsh-ss-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
@media (hover: hover) {
  .dsh-ss-pill:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}
.dsh-ss-sep { opacity: 0.45; }
.dsh-ss-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: 268px;
  max-width: calc(100vw - 24px);
  max-height: min(420px, calc(100dvh - 24px));
  overflow-y: auto;
  padding: 14px 16px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  text-align: left;
}
.dsh-ss-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-ss-headvalue { font-variant-numeric: tabular-nums; }
.dsh-ss-rule {
  margin-bottom: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-ss-grid {
  display: grid;
  grid-template-columns: minmax(56px, auto) minmax(0, 1fr);
  gap: 5px 14px;
  margin: 0;
}
.dsh-ss-grid dt {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.dsh-ss-grid dd {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ss-grid dd[data-bad] { color: var(--dsw-alias-state-warn-label, inherit); }
.dsh-ss-note { color: var(--dsw-alias-label-tertiary); }
.dsh-ss-foot {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.dsh-ss-action {
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  padding: 0;
  cursor: pointer;
}
.dsh-ss-action:hover { text-decoration: underline; }
`

    /** Mount this plugin's stylesheet once per page. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Drop the stylesheet on teardown. */
    function dropStyles() {
      document.getElementById(STYLE_ID)?.remove()
    }

    /** Locale lookup that survives an unregistered namespace. */
    function translator(t) {
      const fallback = (key) => DICT.zh[key] ?? key
      if (typeof t !== 'function') return fallback
      return (key) => {
        const value = t(key)
        return typeof value === 'string' && value !== key ? value : fallback(key)
      }
    }

    /**
     * Format a duration in seconds as a short human string.
     * @param seconds - uptime.
     * @returns text such as `3d 4h`.
     */
    function formatUptime(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return `${days}d ${hours}h`
      if (hours > 0) return `${hours}h ${minutes}m`
      return `${minutes}m`
    }

    /**
     * One shared snapshot source, re-armed after each read with the configured
     * period, so a settings change applies on the next cycle.
     * @param read - reads the Host route.
     * @returns snapshot source plus start/dispose/refresh.
     */
    function createStats(read) {
      let snapshot = { status: 'loading', stats: null, config: null }
      const listeners = new Set()
      let timer = null
      let inflight = null
      let disposed = false
      let periodMs = DEFAULT_POLL_MS

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }

      const schedule = () => {
        if (disposed) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => { void refresh() }, periodMs)
      }

      const refresh = () => {
        if (disposed) return Promise.resolve()
        if (inflight !== null) return inflight
        inflight = (async () => {
          try {
            const next = await read()
            if (disposed) return
            if (Number.isFinite(next?.config?.pollSeconds)) {
              periodMs = Math.min(600, Math.max(5, next.config.pollSeconds)) * 1000
            }
            publish(next)
          } catch {
            if (!disposed) publish({ status: 'unreachable', stats: null, config: snapshot.config })
          } finally {
            inflight = null
            schedule()
          }
        })()
        return inflight
      }

      const onVisible = () => {
        if (document.visibilityState === 'visible') void refresh()
      }

      return {
        refresh,
        source: {
          getSnapshot: () => snapshot,
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        },
        start() {
          void refresh()
          document.addEventListener('visibilitychange', onVisible)
        },
        dispose() {
          disposed = true
          if (timer !== null) clearTimeout(timer)
          timer = null
          document.removeEventListener('visibilitychange', onVisible)
          listeners.clear()
        },
      }
    }

    /** Server stack outline: reads as a host at 14px. */
    function ServerIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 2.1, y: 2.2, width: 11.8, height: 4.6, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { x: 2.1, y: 9.2, width: 11.8, height: 4.6, rx: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 4.6, cy: 4.5, r: 0.75, fill: 'currentColor' }),
        h('circle', { cx: 4.6, cy: 11.5, r: 0.75, fill: 'currentColor' }),
      )
    }

    /**
     * Panel body: the metric grid for one snapshot.
     * @param props - snapshot stats and translator.
     */
    function PanelBody(props) {
      const { stats, copy } = props
      const rows = [
        [copy('host'), stats.target],
        [copy('load'), stats.load || '—'],
        [copy('memory'), `${stats.memUsedMb}M / ${stats.memTotalMb}M`],
      ]
      if (stats.swapTotalMb > 0) {
        rows.push([copy('swap'), `${stats.swapUsedMb}M / ${stats.swapTotalMb}M`])
      }
      rows.push([copy('disk'), `${stats.diskUsedGb}G / ${stats.diskTotalGb}G · ${stats.diskPct || '—'}`])
      if (stats.containers !== null && stats.containers !== undefined) {
        const engine = stats.engine !== '' && stats.engine !== 'none' ? ` (${stats.engine})` : ''
        rows.push([copy('containers'), `${stats.containers}${engine}`])
      }
      for (const service of Array.isArray(stats.services) ? stats.services : []) {
        rows.push([copy('services'), `${service.unit}: ${service.state}`])
      }
      rows.push([copy('uptime'), formatUptime(stats.uptimeSec)])

      return h('dl', { className: 'dsh-ss-grid' },
        rows.map(([label, value], index) => [
          h('dt', { key: `${index}:k` }, label),
          h('dd', {
            key: `${index}:v`,
            title: value,
            'data-bad': /inactive|failed|unknown/.test(value) ? '' : undefined,
          }, value),
        ]),
      )
    }

    /**
     * The dock entry: pill plus click-opened panel.
     * @param props - injected snapshot hook, actions and translator.
     */
    function StatsPill(props) {
      const { useStats, actions, t } = props
      const snapshot = useStats((value) => value)
      const [open, setOpen] = React.useState(false)
      const [placement, setPlacement] = React.useState(null)
      const anchor = React.useRef(null)
      const panel = React.useRef(null)
      const openedAt = React.useRef(0)
      const copy = translator(t)

      React.useEffect(() => {
        if (!open) return undefined
        const recent = () => Date.now() - openedAt.current < 350
        const onPointerDown = (event) => {
          if (recent()) return
          const target = event.target
          if (panel.current?.contains(target) === true) return
          if (anchor.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (snapshot.status === 'loading') return null

      const toggle = () => {
        const rect = anchor.current?.getBoundingClientRect()
        if (open) {
          setOpen(false)
          return
        }
        openedAt.current = Date.now()
        if (rect !== undefined && rect !== null) {
          const left = Math.min(Math.max(8, rect.left + rect.width / 2 - PANEL_WIDTH / 2), window.innerWidth - PANEL_WIDTH - 8)
          setPlacement({ left, bottom: window.innerHeight - rect.top + 8 })
        }
        setOpen(true)
      }

      const dialog = (body, updatedAt) => {
        if (!open || placement === null) return null
        const element = h('div', {
          className: 'dsh-ss-panel',
          role: 'dialog',
          'aria-label': copy('title'),
          ref: panel,
          style: { left: placement.left + 'px', bottom: placement.bottom + 'px' },
        },
          h('div', { className: 'dsh-ss-head' },
            h('span', null, copy('title')),
            h('span', { className: 'dsh-ss-headvalue' }, snapshot.status === 'ready' ? `${snapshot.stats.cpuPct}%` : ''),
          ),
          h('div', { className: 'dsh-ss-rule' }),
          body,
          h('div', { className: 'dsh-ss-foot' },
            h('span', null, updatedAt === null ? '' : copy('updated') + ' ' + updatedAt),
            h('button', { type: 'button', className: 'dsh-ss-action', onClick: () => { void actions.refresh() } }, copy('refresh')),
          ),
        )
        return createPortal !== null ? createPortal(element, document.body) : element
      }

      if (snapshot.status === 'unconfigured') {
        return h('span', { className: 'dsh-ss-anchor', ref: anchor },
          h('button', {
            type: 'button',
            className: 'dsh-ss-pill',
            'data-muted': '',
            title: copy('configure'),
            'aria-label': copy('configure'),
            onClick: toggle,
          }, h(ServerIcon), h('span', null, copy('unconfigured'))),
          open && placement !== null ? dialog(
            h('div', { className: 'dsh-ss-note' }, copy('configure')),
            null,
          ) : null,
        )
      }

      if (snapshot.status !== 'ready' || snapshot.stats === null) {
        return h('span', { className: 'dsh-ss-anchor', ref: anchor },
          h('button', {
            type: 'button',
            className: 'dsh-ss-pill',
            'data-muted': '',
            title: copy('unreachable'),
            'aria-label': copy('unreachable'),
            onClick: toggle,
          }, h(ServerIcon), h('span', null, copy('unreachable'))),
          open && placement !== null ? dialog(
            h('div', { className: 'dsh-ss-note' }, copy('unreachable')),
            null,
          ) : null,
        )
      }

      const stats = snapshot.stats
      const warn = stats.cpuPct >= 80 || (stats.memUsedMb / Math.max(1, stats.memTotalMb)) >= 0.9
      const tooltip = [
        copy('title') + ' · ' + stats.target,
        `${copy('cpu')} ${stats.cpuPct}%`,
        `${copy('memory')} ${stats.memUsedMb}M / ${stats.memTotalMb}M`,
        `${copy('disk')} ${stats.diskUsedGb}G / ${stats.diskTotalGb}G`,
        `${copy('load')} ${stats.load}`,
      ].join('\n')
      const updated = new Date(stats.at).toTimeString().slice(0, 8)

      return h('span', { className: 'dsh-ss-anchor', ref: anchor },
        h('button', {
          type: 'button',
          className: 'dsh-ss-pill',
          title: tooltip,
          'aria-label': copy('open'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'data-warn': warn ? '' : undefined,
          onClick: toggle,
        },
          h(ServerIcon),
          h('span', null, `${stats.cpuPct}%`),
          h('span', { className: 'dsh-ss-sep' }, '·'),
          h('span', null, `${stats.memUsedMb}M`),
        ),
        dialog(h(PanelBody, { stats, copy }), updated),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        ctx.effect(() => () => { dropStyles() }, 'server-stats: stylesheet')

        const read = async () => {
          const response = await fetch(ROUTE, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('stats route answered ' + response.status)
          const payload = await response.json()
          if (payload?.ok !== true) throw new Error('stats route refused')
          const config = payload.config ?? null
          if (payload.status === 'ready' && payload.stats !== undefined && payload.stats !== null) {
            return { status: 'ready', stats: payload.stats, config }
          }
          if (payload.status === 'unconfigured') return { status: 'unconfigured', stats: null, config }
          return { status: 'unreachable', stats: null, config }
        }

        const stats = createStats(read)
        ctx.effect(() => () => { stats.dispose() }, 'server-stats: polling')
        stats.start()

        try {
          if (typeof ctx.locale.register === 'function') {
            ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'server-stats: dictionaries')
          }
        } catch {
          /* the pill falls back to its built-in copy */
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'server-stats',
          order: 3,
          locale: NS,
          inject: () => ({ hooks: { stats: stats.source }, actions: { refresh: stats.refresh } }),
        }, StatsPill))
      },
    }
  },
})
