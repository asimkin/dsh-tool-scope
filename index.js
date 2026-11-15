/**
 * paiw-tool-scope — per-agent tool restriction for dsh role subagents.
 *
 * Why it exists: a subagent inherits the host tool layer (MCP servers, fs,
 * bash, ...) on top of its own preset, so a read-only role still paid for
 * ~28k tokens of tool schema on every call (measured 2026-11-14 on 0.2.2-rc.3:
 * root 36 044 tokens, code_reviewer child 28 101). Upstream keeps the seam
 * (`ctx.tools.restrict`) but `tool-subagent` rejects its `toolFilter` config, so
 * the restriction is applied here instead of patching the harness.
 *
 * Where it must live: the restriction has to be applied to the *agent's* scope.
 * A preset-mounted plugin restricts the preset scope, where the preset's own
 * rows are exempt and therefore also unreachable by name — a first attempt
 * inside `preset-code-reviewer` left the child with `working_directory` only.
 * So this plugin mounts once at the host layer and reacts to `agent/created`,
 * the same pattern the upstream browser-use runtime uses for its masks.
 *
 * Config:
 *   roles:
 *     <preset-id>: { allow?: string[], deny?: string[] }
 *
 * Robustness: `restrict()` throws on names that are not inherited tools, and an
 * MCP server disabled by an overlay makes its tool names unknown. A failed
 * restriction must not break the child, so unknown entries are dropped with a
 * warning and a hard failure is logged and skipped.
 */

export const name = 'dsh-tool-scope'

export const inject = ['tools']

const isStringArray = value => Array.isArray(value) && value.every(entry => typeof entry === 'string')

export function apply(ctx, config) {
  const roles = config?.roles ?? {}
  const presetIds = Object.keys(roles)
  if (presetIds.length === 0) return

  const restrictAgent = (agent) => {
    const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
    const rule = preset === undefined ? undefined : roles[preset]
    if (rule === undefined) return
    const allow = isStringArray(rule.allow) ? rule.allow : []
    const deny = isStringArray(rule.deny) ? rule.deny : []
    if (allow.length === 0 && deny.length === 0) return

    // Pre-restriction visible set of that agent: host layer plus preset layers.
    // The scope key is the Agent itself (`ctx.tools.schemas(agent)` upstream);
    // passing `agent.ctx` yields an empty view and silently empties the mask.
    const visible = new Set(ctx.tools.definitions(agent).map(definition => definition.name))
    const kept = allow.filter(toolName => visible.has(toolName))
    const dropped = allow.filter(toolName => !visible.has(toolName))
    if (dropped.length > 0) {
      ctx.logger?.warn?.(`paiw-tool-scope(${preset}): нет таких тулов, пропущены: ${dropped.join(', ')}`)
    }
    if (kept.length === 0 && deny.length === 0) {
      ctx.logger?.warn?.(`paiw-tool-scope(${preset}): allow-список не совпал ни с одним тулом — фильтр не наложен`)
      return
    }
    const filter = {
      ...(kept.length > 0 ? { allow: kept } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    }
    try {
      agent.ctx.effect(() => agent.ctx.tools.restrict(filter))
      ctx.logger?.info?.(`paiw-tool-scope(${preset}): allow=[${kept.join(', ')}] deny=[${deny.join(', ')}]`)
    } catch (error) {
      ctx.logger?.warn?.(`paiw-tool-scope(${preset}): restrict не применён: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => { restrictAgent(agent) })
}
