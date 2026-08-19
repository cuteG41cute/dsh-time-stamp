// dsh-time-stamp — Host half (static / composition plugin)
//
// A regular DSH plugin loaded from the composition (cordis.patch.yml row),
// so it survives process restarts — unlike the dynamic form in ../plugin.
//
// Responsibilities:
//  1. Register the 'time-stamp' settings namespace (schemastery schema,
//     persisted in DSH_HOME/settings.yaml) holding the global default and
//     per-workspace overrides.
//  2. Listen on agent/pre-step (prepend) and append ONE durable plugin-source
//     clock message after every user-origin message, exactly like the
//     dynamic version: written to the session log once, replayed
//     byte-identically on every later request (provider prefix cache keeps
//     hitting), never touching the user's own text.
//  3. Expose the same wiring the client half reads through the settings
//     transport (ctx.settingsScope on the browser).
//
// The listener never throws: on any unexpected failure it passes the
// original decision through so the agent loop is never disturbed.
import { Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const SETTINGS_NS = 'time-stamp'
/** Source plugin name stamped into injected messages. */
export const PLUGIN = 'time-stamp'

/** Monotonic suffix so two injections in the same millisecond never collide. */
let messageSeq = 0

/** Resolved per-project configuration. */
export const timeStampSettingsSchema = s.object({
  defaultEnabled: s.boolean().default(true),
  projects: s.dict(s.boolean()).default({}),
})

/** Format an epoch millisecond value as a stable ISO-shaped local timestamp. */
function formatTs(now, formatter, zone) {
  const parts = {}
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}[${zone}]`
}

/** Format a non-negative elapsed millisecond count as compact whole-second units. */
function formatDuration(ms) {
  let seconds = Math.floor(Math.max(0, ms) / 1000)
  const days = Math.floor(seconds / 86400); seconds %= 86400
  const hours = Math.floor(seconds / 3600); seconds %= 3600
  const minutes = Math.floor(seconds / 60); seconds %= 60
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
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
  static inject = ['settings', 'workspaceRegistry', 'agents']

  constructor(ctx) {
    super(ctx, 'timeStamp')
  }

  async [Service.init]() {
    this.ctx.settings.register(SETTINGS_NS, timeStampSettingsSchema)
    this.ctx.effect(() => this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next), { prepend: true }))
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

      const formatter = new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23', timeZoneName: 'longOffset',
      })
      const zone = formatter.resolvedOptions().timeZone
      const now = Date.now()
      const prev = this.previousUserMessageTime(payload.agent)
      let text = `Time the user's latest message was received: ${formatTs(now, formatter, zone)}.`
      if (prev !== undefined) text += ` Elapsed since the previous user message: ${formatDuration(now - prev)}.`
      text += ' Interpret relative time references (now, today, yesterday, 现在, 今天, 刚才) against this instant.'
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
}

export default TimeStampService
