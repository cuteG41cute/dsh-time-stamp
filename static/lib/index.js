// dsh-time-stamp — Host half (static / composition plugin)
//
// A regular DSH plugin loaded from the composition (cordis.patch.yml row),
// so it survives process restarts — unlike the dynamic form in ../plugin.
//
// Supported dsh generations (feature-detected at runtime, one code path):
//
//   legacy  (dsh <= 0.1.6, @deepseek-ai/dsh-settings without volatile configs)
//     · settings.register(ns, schema) registers the namespace + its form
//     · settings.get(ns) reads the resolved value
//     · settings.mutate(ns, ops) writes, ns = the registered namespace
//
//   config  (dsh >= 0.1.7, incl. 0.2.x)
//     · `static Config` (schemastery, volatile fields) is the settings form;
//       the Settings service reads it from the entry's fiber runtime
//     · the plugin reads its own Config reference — volatile fields are
//       `Volatile<T>` wrappers updated in place, so `value.get()` is live
//     · settings.mutate(entryId, ops) writes, ns = the PROFILE ENTRY ID
//       (e.g. `dsh-time-stamp`) and only volatile paths are accepted
//
// Responsibilities:
//  1. Register/expose the plugin configuration (global default + per-workspace
//     overrides).
//  2. Listen on agent/pre-step (prepend) and append ONE durable plugin-source
//     clock message after every user-origin message: written to the session log
//     once, replayed byte-identically on every later request (provider prefix
//     cache keeps hitting), never touching the user's own text.
//  3. Serve a small JSON API on an exact webServer route
//     (POST /dsh-time-stamp/api, body { method, args }) that the client half
//     calls with fetch — a browser-side channel that bypasses the apiProxy
//     settings allowlist and needs no typert/zod machinery.
//
// The pre-step listener never throws: on any unexpected failure it passes the
// original decision through so the agent loop is never disturbed.
import { Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

/** Legacy settings namespace (dsh <= 0.1.6). */
export const SETTINGS_NS = 'time-stamp'
/** Source plugin name stamped into injected messages. */
export const PLUGIN = 'time-stamp'
/**
 * Producer-owned source kind. dsh 0.2.x session format v4 rejects
 * `kind: 'plugin'` ("format v4 message requires a producer-owned source kind");
 * the migrator's equivalent for a third-party plugin is `plugin:<name>` with
 * the `plugin` field dropped. Older dsh renders any non-`user` kind as a
 * context-injection row, so the same value works on both generations.
 */
export const PLUGIN_KIND = 'plugin:' + PLUGIN
/** Exact webServer route serving the client JSON API. */
export const ROUTE_PATH = '/dsh-time-stamp/api'
/** Fallback profile entry id (dsh >= 0.1.7 addresses settings by entry id). */
export const DEFAULT_ENTRY_ID = 'dsh-time-stamp'

/** Monotonic suffix so two injections in the same millisecond never collide. */
let messageSeq = 0

/**
 * Mark a config field volatile when the installed schemastery supports it.
 * Volatile fields are the only ones the Settings service lets a form edit live
 * (`dsh-settings` >= 0.1.7); older schemastery has no `.volatile()`.
 * @param schema - one schemastery field.
 * @returns the same field, volatile-marked when supported.
 */
function volatileField(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

/**
 * Read the current value of a config field: volatile fields are wrappers whose
 * `get()` is updated in place, plain fields are the value itself.
 * @param value - a resolved config field.
 * @returns the plain current value.
 */
export function currentValue(value) {
  return value !== null && value !== undefined && typeof value.get === 'function' ? value.get() : value
}

/**
 * Effective injection flag for one workspace (or the global default).
 * Pure helper so the decision can be verified without a live service.
 * @param config - resolved plugin config (plain or volatile-wrapped).
 * @param workspaceId - owning workspace id, or undefined for the global default.
 * @returns whether the clock reading should be injected.
 */
export function enabledFromConfig(config, workspaceId) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const projects = currentValue(source.projects)
  const map = projects !== null && typeof projects === 'object' ? projects : {}
  if (workspaceId !== undefined && typeof map[workspaceId] === 'boolean') return map[workspaceId]
  const fallback = currentValue(source.defaultEnabled)
  return typeof fallback === 'boolean' ? fallback : true
}

/**
 * Resolved plugin configuration. `volatile` fields carry the live value, so the
 * same object can be read before and after a settings write.
 */
export const timeStampSettingsSchema = s.object({
  defaultEnabled: volatileField(s.boolean().default(true)),
  projects: volatileField(s.dict(s.boolean()).default({})),
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

/**
 * Build the durable clock message appended after one user-origin message.
 * Pure and exported so the exact logged shape can be checked against the
 * session format validators without a live service.
 * @param now - epoch milliseconds the user's latest message was received.
 * @param prev - epoch milliseconds of the previous user message, when known.
 * @param id - stable message id for this injection.
 * @returns the frozen user message carrying the clock reading.
 */
export function buildInjectedMessage(now, prev, id) {
  const text = renderClockText(now, prev)
  return deepFreeze({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: PLUGIN_KIND,
      form: 'snapshot',
      sections: [{ name: PLUGIN, text }],
    },
  })
}

export class TimeStampService extends Service {
  static inject = ['settings', 'workspaceRegistry', 'agents', 'webServer']
  static Config = timeStampSettingsSchema

  constructor(ctx, config) {
    super(ctx, 'timeStamp')
    /** Validated config reference (dsh >= 0.1.7: volatile fields stay live). */
    this.config = config
    /** Cached profile entry id used as the settings namespace on dsh >= 0.1.7. */
    this.entryId = undefined
  }

  /** Whether the installed dsh still exposes the legacy register()/get() API. */
  get legacySettings() {
    try {
      return typeof this.ctx.settings.register === 'function'
    } catch {
      return false
    }
  }

  async [Service.init]() {
    if (this.legacySettings) {
      // dsh <= 0.1.6: the namespace must be registered to be writable/readable.
      this.ctx.settings.register(SETTINGS_NS, timeStampSettingsSchema)
    }
    this.ctx.effect(() => this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next), { prepend: true }))
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => this.handleApi(req, res),
    }))
  }

  /** Current resolved config, preferring the fiber's live validated config. */
  readConfig() {
    if (this.legacySettings) {
      try {
        const value = this.ctx.settings.get(SETTINGS_NS)
        if (value !== undefined) return value
      } catch {
        // fall through to the constructor config
      }
    }
    const fiberConfig = this.ctx.fiber === undefined || this.ctx.fiber === null ? undefined : this.ctx.fiber.config
    return fiberConfig !== undefined && fiberConfig !== null ? fiberConfig : this.config
  }

  /** Resolve the profile entry id this plugin is mounted under (dsh >= 0.1.7). */
  resolveEntryId() {
    if (this.entryId !== undefined) return this.entryId
    const editor = this.ctx.get('configEditor')
    if (editor !== undefined && typeof editor.entries === 'function') {
      try {
        const rows = Array.from(editor.entries() ?? [])
        const row = rows.find((candidate) => candidate !== null && candidate !== undefined && candidate.fiber === this.ctx.fiber)
        const id = row === undefined ? undefined : row.options && row.options.id
        if (typeof id === 'string' && id !== '') {
          this.entryId = id
          return this.entryId
        }
      } catch {
        // fall through to the documented default
      }
    }
    const fromEnv = typeof process !== 'undefined' && process.env !== undefined ? process.env.DSH_TIME_STAMP_ENTRY_ID : undefined
    this.entryId = typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : DEFAULT_ENTRY_ID
    return this.entryId
  }

  /** Resolve the workspace owning one agent's session cwd. */
  async workspaceIdOf(agent) {
    const session = agent && agent.session ? agent.session : undefined
    const header = session ? (session.header ?? session.meta) : undefined
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : undefined
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
    return enabledFromConfig(this.readConfig(), workspaceId)
  }

  /** Time of the most recent user-origin message before the current step. */
  previousUserMessageTime(agent) {
    const session = agent && agent.session ? agent.session : undefined
    if (session === undefined || session === null) return undefined
    let events
    // dsh >= 0.2: the log is only reachable through snapshotEvents()/eventAt().
    if (typeof session.snapshotEvents === 'function') {
      try {
        events = session.snapshotEvents()
      } catch {
        events = undefined
      }
    }
    // dsh <= 0.1.6 exposed the live log array directly.
    if (!Array.isArray(events)) events = Array.isArray(session.events) ? session.events : []
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
      const injected = buildInjectedMessage(now, prev, `ts-${now}-${messageSeq++}`)
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
          settings: this.legacySettings ? 'legacy' : 'config',
          entryId: this.legacySettings ? SETTINGS_NS : this.resolveEntryId(),
        }
      }
      case 'set-enabled': {
        const workspaceId = typeof args.workspaceId === 'string' && args.workspaceId !== '' ? args.workspaceId : undefined
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined
        if (enabled === undefined) return { ok: false, reason: 'bad args' }
        if (workspaceId === undefined) await this.writeOps([{ op: 'set', path: ['defaultEnabled'], value: enabled }])
        else await this.writeOps([{ op: 'set', path: ['projects', workspaceId], value: enabled }])
        return { ok: true, enabled }
      }
      case 'get-default':
        return { ok: true, enabled: this.enabledFor(undefined) }
      case 'set-default': {
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined
        if (enabled === undefined) return { ok: false, reason: 'bad args' }
        await this.writeOps([{ op: 'set', path: ['defaultEnabled'], value: enabled }])
        return { ok: true, enabled }
      }
      default:
        return { ok: false, reason: `unknown method: ${method}` }
    }
  }

  /**
   * Persist config edits. Legacy dsh writes through the registered namespace;
   * newer dsh addresses the profile entry id and only accepts volatile paths.
   */
  async writeOps(ops) {
    if (this.legacySettings) {
      await this.ctx.settings.mutate(SETTINGS_NS, ops)
      return
    }
    await this.ctx.settings.mutate(this.resolveEntryId(), ops)
  }
}

export default TimeStampService
