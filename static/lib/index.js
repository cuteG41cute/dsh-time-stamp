// dsh-time-stamp — Host half (static / composition plugin)
//
// A regular DSH plugin loaded from the composition (cordis.patch.yml row),
// so it survives process restarts — unlike the dynamic form in ../plugin.
//
// Responsibilities:
//  1. Register the 'time-stamp' settings namespace (schemastery schema,
//     persisted in DSH_HOME/settings.yaml) holding the global default and
//     per-workspace overrides. The namespace is used HOST-side only: the
//     apiProxy settings allowlist is hardcoded in @deepseek-ai/dsh-host-apiproxy
//     (WEB_SETTINGS_NAMESPACES / PRODUCT_SETTINGS_NAMESPACES), so third-party
//     namespaces are intentionally NOT served to configuration clients.
//  2. Listen on agent/pre-step (prepend) and append ONE durable plugin-source
//     clock message after every user-origin message, exactly like the
//     dynamic version: written to the session log once, replayed
//     byte-identically on every later request (provider prefix cache keeps
//     hitting), never touching the user's own text.
//  3. Serve a small JSON API on an exact webServer route
//     (POST /dsh-time-stamp/api, body { method, args }) that the client half
//     calls with fetch — the browser-side channel that bypasses the settings
//     allowlist and needs no typert/zod machinery.
//
// The pre-step listener never throws: on any unexpected failure it passes the
// original decision through so the agent loop is never disturbed.
import { Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'time-stamp'
/** Source plugin name stamped into injected messages. */
export const PLUGIN = 'time-stamp'
/** Exact webServer route serving the client JSON API. */
export const ROUTE_PATH = '/dsh-time-stamp/api'

/** Monotonic suffix so two injections in the same millisecond never collide. */
let messageSeq = 0

/** Resolved per-project configuration. */
export const timeStampSettingsSchema = s.object({
  defaultEnabled: s.boolean().default(true),
  projects: s.dict(s.boolean()).default({}),
})

/**
 * One process-local formatter. The fixed locale and numeric pattern keep a
 * given instant byte-identical across calls, which is what lets the injected
 * reading sit in the provider prefix cache unchanged.
 */
const CLOCK_FORMATTER = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset',
})
/** Canonical zone label carried in brackets. */
const CLOCK_ZONE = CLOCK_FORMATTER.resolvedOptions().timeZone

/** Format an epoch millisecond value as a stable ISO-shaped local timestamp. */
function formatTs(now) {
  const parts = {}
  for (const part of CLOCK_FORMATTER.formatToParts(now)) parts[part.type] = part.value
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${CLOCK_ZONE}]`
}

/** Format a non-negative elapsed millisecond count as compact Chinese units. */
function formatDuration(ms) {
  let seconds = Math.floor(Math.max(0, ms) / 1000)
  const days = Math.floor(seconds / 86400); seconds %= 86400
  const hours = Math.floor(seconds / 3600); seconds %= 3600
  const minutes = Math.floor(seconds / 60); seconds %= 60
  const parts = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分`)
  parts.push(`${seconds} 秒`)
  return parts.join(' ')
}

/**
 * Render the injected clock reading — Chinese prose, with the instant kept in
 * ISO form (locale-independent and unambiguous) and the zone in brackets.
 * @param now - epoch milliseconds the user's latest message was received.
 * @param prev - epoch milliseconds of the previous user message, when known.
 * @returns the complete injected text.
 */
export function renderClockText(now, prev) {
  let text = `【系统时钟】最新一条用户消息的接收时间：${formatTs(now)}。`
  if (prev !== undefined) text += `距上一条用户消息：${formatDuration(now - prev)}。`
  text += '请以该时刻为基准理解相对时间表述（如「现在、今天、昨天、刚才」）。'
  return text
}

/** Recursively freeze one owned plain-data value. */
function deepFreeze(value) {
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

export class TimeStampService extends Service {
  static inject = ['settings', 'workspaceRegistry', 'agents', 'webServer']

  constructor(ctx) {
    super(ctx, 'timeStamp')
  }

  async [Service.init]() {
    this.ctx.settings.register(SETTINGS_NS, timeStampSettingsSchema)
    this.ctx.effect(() => this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next), { prepend: true }))
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => this.handleApi(req, res),
    }))
  }

  /** Resolve the workspace owning one agent's session cwd. */
  async workspaceIdOf(agent) {
    const meta = agent && agent.session ? agent.session.meta : undefined
    const cwd = meta && typeof meta.cwd === 'string' ? meta.cwd : undefined
    if (cwd === undefined || cwd === '') return undefined
    try {
      const ws = await this.ctx.workspaceRegistry.resolveByPath(cwd)
      return ws ? ws.id : undefined
    } catch {
      return undefined
    }
  }

  /** Whether injection is enabled for one workspace id (undefined = global default). */
  enabledFor(workspaceId) {
    const config = this.ctx.settings.get(SETTINGS_NS)
    const projects = config && typeof config.projects === 'object' && config.projects !== null ? config.projects : {}
    if (workspaceId !== undefined && typeof projects[workspaceId] === 'boolean') return projects[workspaceId]
    return config && typeof config.defaultEnabled === 'boolean' ? config.defaultEnabled : true
  }

  /** Time of the most recent user-origin message before the current step. */
  previousUserMessageTime(agent) {
    const events = agent && agent.session ? agent.session.events : undefined
    if (!Array.isArray(events)) return undefined
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') return ev.time
    }
    return undefined
  }

  /** Waterfall listener: append one clock message after each user-origin message. */
  async onPreStep(payload, next) {
    try {
      const decision = await next()
      if (!decision || decision.kind === 'reject') return decision
      const msgs = Array.isArray(decision.messages) ? decision.messages : []
      let lastUser = -1
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i] && msgs[i].source && msgs[i].source.kind === 'user') lastUser = i
      }
      if (lastUser < 0) return decision
      if (!this.enabledFor(await this.workspaceIdOf(payload.agent))) return decision

      const now = Date.now()
      const prev = this.previousUserMessageTime(payload.agent)
      const text = renderClockText(now, prev)
      const injected = deepFreeze({
        id: `ts-${now}-${messageSeq++}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: PLUGIN,
          form: 'snapshot',
          sections: [{ name: PLUGIN, text }],
        },
      })
      return {
        kind: 'enter',
        messages: msgs.slice(0, lastUser + 1).concat([injected], msgs.slice(lastUser + 1)),
      }
    } catch (error) {
      console.error(`[time-stamp] pre-step injection failed, passing through: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  }

  // ── client JSON API over the webServer route ──

  /** HTTP entry: one JSON request per call. */
  async handleApi(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, reason: 'method-not-allowed' })
      return
    }
    let raw = ''
    try {
      for await (const chunk of req) raw += chunk
    } catch {
      send(400, { ok: false, reason: 'read-failed' })
      return
    }
    let request
    try {
      request = JSON.parse(raw)
    } catch {
      send(400, { ok: false, reason: 'bad-json' })
      return
    }
    const method = request && typeof request.method === 'string' ? request.method : ''
    const args = request && typeof request.args === 'object' && request.args !== null ? request.args : {}
    try {
      send(200, await this.dispatch(method, args))
    } catch (error) {
      send(200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Dispatch one JSON-RPC-style call. */
  async dispatch(method, args) {
    switch (method) {
      case 'state': {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
        const agent = sessionId !== undefined ? this.ctx.agents.get(sessionId) : undefined
        const workspaceId = agent ? await this.workspaceIdOf(agent) : undefined
        let title = null
        if (workspaceId !== undefined) {
          const ws = this.ctx.workspaceRegistry.get(workspaceId)
          if (ws) title = ws.title
        }
        return {
          ok: true,
          workspaceId: workspaceId === undefined ? null : workspaceId,
          title,
          enabled: this.enabledFor(workspaceId),
          defaultEnabled: this.enabledFor(undefined),
        }
      }
      case 'set-enabled': {
        const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId !== '' ? args.workspaceId : undefined
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined
        if (enabled === undefined) return { ok: false, reason: 'bad args' }
        if (workspaceId === undefined) await this.writeDefault(enabled)
        else await this.writeProject(workspaceId, enabled)
        return { ok: true, enabled }
      }
      case 'get-default':
        return { ok: true, enabled: this.enabledFor(undefined) }
      case 'set-default': {
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined
        if (enabled === undefined) return { ok: false, reason: 'bad args' }
        await this.writeDefault(enabled)
        return { ok: true, enabled }
      }
      default:
        return { ok: false, reason: `unknown method: ${method}` }
    }
  }

  /** Set one workspace override via a path-addressed settings mutation. */
  async writeProject(workspaceId, enabled) {
    await this.ctx.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['projects', workspaceId], value: enabled }])
  }

  /** Set the global default via a path-addressed settings mutation. */
  async writeDefault(enabled) {
    await this.ctx.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['defaultEnabled'], value: enabled }])
  }
}

export default TimeStampService
