// dsh-time-stamp — Host 半部（动态 Cordis 插件）
//
// 用法：在 DSH 会话中通过 cordis_define 创建动态插件时，
// 把本文件的全部内容原样作为 code.host 参数提交
// （plugin.kind: "new", idPrefix: "tstmp"），
// client.js 的内容作为 code.client，然后 cordis_run 激活。
//
// 本文件是纯 JavaScript 函数体（无 import / require / TS），
// 运行在 DSH 动态插件的 node:vm 沙箱中，可用全局：ctx / harness /
// console / btoa / atob / TextEncoder / TextDecoder + 标准 ECMAScript。

// Time Stamp — host half: durable per-question clock context injection.
// Design notes:
//  - Injects ONE plugin-source user message per user-origin message entering a
//    step (agent/pre-step). The message is appended to the session log once,
//    then replayed byte-identically on every later request -> the provider
//    prefix cache keeps hitting; no per-step refresh, no churn inside a turn.
//  - Per-project (workspace) enable/disable is persisted in a storage domain
//    (json backend under DSH_HOME/storages) because the dynamic sandbox has no
//    schemastery/zod import for settings.register.
//  - Domain name MUST match /^[a-z][a-z0-9_]*$/ (no hyphens): 'time_stamp'.
//  - The listener never throws: on any unexpected failure it passes the
//    original decision through so the agent loop is never disturbed.
return {
  async apply(ctx) {
    const PLUGIN = 'time-stamp'
    const KEY_DEFAULT = '__default__'
    const DEFAULT_ENABLED = true
    let table = null
    let openError = null
    let seq = 0

    // ---- durable per-project config: storage domain (json backend) ----
    const storageDomain = ctx.get('storageDomain')
    if (storageDomain !== undefined) {
      try {
        // Duck-typed zod schema: this sandbox cannot import zod, and our own
        // JSON records need no validation (parse returns the value as-is).
        const passthrough = {
          parse: (v) => v,
          safeParse: (v) => ({ success: true, data: v }),
        }
        const domain = await storageDomain.open({
          name: 'time_stamp',
          version: 1,
          tables: { projects: { valueSchema: passthrough } },
        })
        table = domain.table('projects')
        let closed = false
        ctx.effect(() => () => {
          if (closed) return
          closed = true
          domain.close().catch(() => {})
        })
      } catch (error) {
        openError = error instanceof Error ? error.message : String(error)
        console.error('[time-stamp] config storage unavailable: ' + openError)
      }
    } else {
      openError = 'storageDomain service not mounted'
      console.error('[time-stamp] storageDomain service not mounted')
    }

    const readEnabled = (workspaceId) => {
      if (table === null) return DEFAULT_ENABLED
      const rec = table.get(workspaceId)
      if (rec !== undefined && typeof rec.enabled === 'boolean') return rec.enabled
      const def = table.get(KEY_DEFAULT)
      if (def !== undefined && typeof def.enabled === 'boolean') return def.enabled
      return DEFAULT_ENABLED
    }

    const workspaceRegistry = ctx.get('workspaceRegistry')
    const workspaceIdOf = async (agent) => {
      const meta = agent && agent.session ? agent.session.meta : undefined
      const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : undefined
      if (cwd === undefined || cwd === '' || workspaceRegistry === undefined) return undefined
      try {
        const ws = await workspaceRegistry.resolveByPath(cwd)
        return ws ? ws.id : undefined
      } catch {
        return undefined
      }
    }

    // ---- deterministic timestamp formatting (stable per instant) ----
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', timeZoneName: 'longOffset',
    })
    const zone = formatter.resolvedOptions().timeZone
    const formatTs = (now) => {
      const parts = {}
      for (const part of formatter.formatToParts(now)) parts[part.type] = part.value
      const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
      return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute + ':' + parts.second + offset + '[' + zone + ']'
    }
    const formatDuration = (ms) => {
      let s = Math.floor(Math.max(0, ms) / 1000)
      const d = Math.floor(s / 86400); s %= 86400
      const h = Math.floor(s / 3600); s %= 3600
      const m = Math.floor(s / 60); s %= 60
      const out = []
      if (d > 0) out.push(d + 'd')
      if (h > 0) out.push(h + 'h')
      if (m > 0) out.push(m + 'm')
      out.push(s + 's')
      return out.join(' ')
    }
    const previousUserMessageTime = (agent) => {
      const events = agent && agent.session ? agent.session.events : undefined
      if (!Array.isArray(events)) return undefined
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev && ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') return ev.time
      }
      return undefined
    }
    const deepFreeze = (value) => {
      const seen = new WeakSet()
      const pending = [value]
      while (pending.length > 0) {
        const node = pending.pop()
        if (node === null || typeof node !== 'object' || seen.has(node)) continue
        seen.add(node)
        Object.freeze(node)
        for (const key of Object.keys(node)) pending.push(node[key])
      }
      return value
    }

    // ---- inject one durable clock message after each user-origin message ----
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const decision = await next()
        if (!decision || decision.kind === 'reject') return decision
        const msgs = Array.isArray(decision.messages) ? decision.messages : []
        let lastUser = -1
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i] && msgs[i].source && msgs[i].source.kind === 'user') lastUser = i
        }
        if (lastUser < 0) return decision
        if (!readEnabled(await workspaceIdOf(payload.agent))) return decision
        const now = Date.now()
        const prev = previousUserMessageTime(payload.agent)
        let text = "Time the user's latest message was received: " + formatTs(now) + '.'
        if (prev !== undefined) text += ' Elapsed since the previous user message: ' + formatDuration(now - prev) + '.'
        text += ' Interpret relative time references (now, today, yesterday, 现在, 今天, 刚才) against this instant.'
        const injected = deepFreeze({
          id: 'ts-' + now + '-' + (seq++),
          role: 'user',
          content: [{ type: 'text', text: text }],
          source: {
            kind: 'plugin',
            plugin: PLUGIN,
            form: 'snapshot',
            sections: [{ name: PLUGIN, text: text }],
          },
        })
        return {
          kind: 'enter',
          messages: msgs.slice(0, lastUser + 1).concat([injected], msgs.slice(lastUser + 1)),
        }
      } catch (error) {
        console.error('[time-stamp] pre-step injection failed, passing through: ' + (error instanceof Error ? error.message : String(error)))
        return next()
      }
    }, { prepend: true })

    // ---- Client RPC: per-project state + writes ----
    harness.handle('state', async (args) => {
      const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined
      const agents = ctx.get('agents')
      const agent = sessionId !== undefined && agents !== undefined ? agents.get(sessionId) : undefined
      const workspaceId = agent ? await workspaceIdOf(agent) : undefined
      let title = null
      if (workspaceId !== undefined && workspaceRegistry !== undefined) {
        const ws = workspaceRegistry.get(workspaceId)
        if (ws) title = ws.title
      }
      return {
        ok: true,
        workspaceId: workspaceId === undefined ? null : workspaceId,
        title: title,
        enabled: readEnabled(workspaceId),
        defaultEnabled: readEnabled(undefined),
        storage: table === null ? (openError || 'unavailable') : 'ok',
      }
    })
    harness.handle('set-enabled', async (args) => {
      const workspaceId = args && typeof args.workspaceId === 'string' && args.workspaceId !== '' ? args.workspaceId : KEY_DEFAULT
      const enabled = args && typeof args.enabled === 'boolean' ? args.enabled : undefined
      if (enabled === undefined) return { ok: false, reason: 'bad args' }
      if (table === null) return { ok: false, reason: openError || 'storage unavailable' }
      await table.put(workspaceId, { enabled: enabled })
      return { ok: true, enabled: enabled }
    })
    harness.handle('get-default', async () => {
      return { ok: true, enabled: readEnabled(undefined), storage: table === null ? (openError || 'unavailable') : 'ok' }
    })
    harness.handle('set-default', async (args) => {
      const enabled = args && typeof args.enabled === 'boolean' ? args.enabled : undefined
      if (enabled === undefined) return { ok: false, reason: 'bad args' }
      if (table === null) return { ok: false, reason: openError || 'storage unavailable' }
      await table.put(KEY_DEFAULT, { enabled: enabled })
      return { ok: true, enabled: enabled }
    })
  },
}
