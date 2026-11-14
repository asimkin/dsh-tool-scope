# dsh-tool-scope

Per-agent tool restriction for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) role subagents.

A subagent in dsh inherits the host tool layer — MCP servers, filesystem tools, shell — on top of its
own Agent Preset. A read-only reviewer therefore still pays for the whole tool schema on every call.
Measured on dsh `0.2.2-rc.3` (2026-11-14): the root session carries **36 044** tokens of tool schemas,
a `code_reviewer` child **28 101** — although the child only needs four tools.

`dsh-tool-scope` narrows that inherited set per preset. With the four roles of a typical deployment:

| preset | before | after | tools the child can see |
|---|---|---|---|
| `code-reviewer` | 28 101 | **568** | `read`, `glob`, `grep`, `working_directory` |
| `plan-writer` | 28 101 | **996** | + `write`, `todo_write` |
| `design-critic` | 28 101 | **1 422** | + `read_mcp_resource` and 4 Confluence tools |
| `memory-scout` | 28 101 | **2 382** | + 7 `codebase-memory` tools |

## Install

```sh
dsh plugin --profile web add dsh-tool-scope
```

The package is a bundle: it inserts the `tool-scope` row automatically. It does nothing until you
configure roles.

Or from a Git checkout:

```sh
dsh plugin --profile web add git+https://github.com/<owner>/dsh-tool-scope.git#<commit>
```

## Configure

The row config maps an Agent Preset id to the tools that preset's agent keeps:

```yaml
- id: tool-scope
  config:
    roles:
      code-reviewer:
        allow: [read, glob, grep, working_directory]
      plan-writer:
        allow: [read, glob, grep, write, working_directory, todo_write]
      memory-scout:
        allow:
          - read
          - grep
          - glob
          - working_directory
          - mcp__codebase-memory__search_graph
          - mcp__codebase-memory__trace_path
```

`allow` keeps only the named tools; `deny` removes the named ones. An empty or missing rule leaves the
agent untouched, so the root agent and every preset you did not list keep their full toolset.

## How it works

Upstream keeps the seam (`ctx.tools.restrict`) but `tool-subagent` rejects its `toolFilter` config, so
the restriction is applied from a host-layer plugin instead of a harness patch:

1. the plugin mounts once for the whole deployment;
2. on `agent/created` it reads the child's preset via `ctx.agentPresets.composedPreset(agent.ctx)`;
3. a configured preset gets `agent.ctx.tools.restrict({ allow })`, which dies with the agent's fiber.

The pattern is the same one the upstream `browser-use-runtime` uses for its MCP masks.

## Gotchas

- **The scope key is the Agent, not `agent.ctx`.** Use `ctx.tools.definitions(agent)`; passing
  `agent.ctx` yields an empty view, the allow-list collapses, and the child ends up with a single tool.
- **A plugin mounted inside an Agent Preset restricts the wrong scope.** There the preset's own rows
  become the exempt "own layer" and are also unreachable by name, so a preset-mounted filter leaves the
  child with almost nothing.
- **The preset's own tools are inherited by the agent**, so `todo_write` or a preset-declared MCP server's
  tools must be named in `allow` as well; otherwise they silently disappear.
- **Unknown names are not fatal.** `restrict()` throws on names that are not inherited tools (a disabled
  MCP server makes its names unknown), so the list is intersected with the visible set, unknown entries
  are reported on stderr, and a total miss skips the filter instead of breaking the child.

## Limits

- Restrictions are per Agent Preset id, not per session or per turn.
- Reapplying after a preset changes requires a new child; existing children keep the filter they got.
- The root agent cannot be scoped this way (dsh has no root-level switch), which is why only children
  are configured.

## License

MIT.
