import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

/**
 * The plugin talks to three dsh surfaces: `ctx.on('agent/created')`,
 * `ctx.get('agentPresets').composedPreset()`, `ctx.tools.definitions(agent)` and
 * `agent.ctx.tools.restrict()`. The fakes below stand in for exactly those, so a
 * regression in the filtering logic fails here instead of on a live subagent.
 */
function makeContext({ preset = undefined, visible = [], restrictThrows = false } = {}) {
  const calls = { restrict: [], warn: [], info: [] }
  const listeners = new Map()

  const ctx = {
    logger: {
      warn: message => calls.warn.push(message),
      info: message => calls.info.push(message),
    },
    tools: {
      // The scope key must be the Agent itself; the fake records what it got.
      definitions: scope => {
        calls.definitionsScope = scope
        return visible.map(toolName => ({ name: toolName }))
      },
    },
    get: service => (service === 'agentPresets'
      ? { composedPreset: () => preset }
      : undefined),
    on: (event, handler) => { listeners.set(event, handler) },
  }

  const agent = {
    ctx: {
      effect: fn => { fn() },
      tools: {
        restrict: filter => {
          if (restrictThrows) throw new Error('tools.restrict() names unknown global tool "ghost"')
          calls.restrict.push(filter)
          return () => {}
        },
      },
    },
  }

  return {
    ctx,
    agent,
    calls,
    emitted: () => listeners.size,
    emit: () => listeners.get('agent/created')({ agent }),
  }
}

test('declares the package name and the tools service dependency', () => {
  assert.equal(name, 'dsh-tool-scope')
  assert.deepEqual(inject, ['tools'])
})

test('does nothing when no roles are configured', () => {
  const { ctx, emitted } = makeContext()
  apply(ctx, { roles: {} })
  assert.equal(emitted(), 0)
  apply(ctx, undefined)
  assert.equal(emitted(), 0)
})

test('restricts a matched preset to the allowed inherited tools', () => {
  const { ctx, agent, calls, emit } = makeContext({
    preset: 'code-reviewer',
    visible: ['read', 'glob', 'write', 'bash'],
  })
  apply(ctx, { roles: { 'code-reviewer': { allow: ['read', 'glob'] } } })
  emit()
  assert.deepEqual(calls.restrict, [{ allow: ['read', 'glob'] }])
  assert.equal(calls.definitionsScope, agent, 'the visible set is read for the Agent, not for agent.ctx')
  assert.ok(calls.info.some(line => line.includes('code-reviewer')), 'info line names the role')
})

test('drops allowed names that are not visible and reports them', () => {
  const { ctx, calls, emit } = makeContext({
    preset: 'memory-scout',
    visible: ['read', 'grep'],
  })
  apply(ctx, { roles: { 'memory-scout': { allow: ['read', 'mcp__codebase-memory__search_graph'] } } })
  emit()
  assert.deepEqual(calls.restrict, [{ allow: ['read'] }])
  assert.ok(calls.warn.some(line => line.includes('mcp__codebase-memory__search_graph')), 'dropped name reported')
})

test('does not restrict when no allowed tool is visible', () => {
  const { ctx, calls, emit } = makeContext({ preset: 'plan-writer', visible: ['read'] })
  apply(ctx, { roles: { 'plan-writer': { allow: ['write'] } } })
  emit()
  assert.equal(calls.restrict.length, 0)
  assert.ok(calls.warn.some(line => line.includes('не совпал')), 'total miss is reported')
})

test('supports deny-only rules', () => {
  const { ctx, calls, emit } = makeContext({
    preset: 'design-critic',
    visible: ['read', 'bash', 'write'],
  })
  apply(ctx, { roles: { 'design-critic': { deny: ['bash', 'write'] } } })
  emit()
  assert.deepEqual(calls.restrict, [{ deny: ['bash', 'write'] }])
})

test('ignores a preset without a rule', () => {
  const { ctx, calls, emit } = makeContext({ preset: 'root', visible: ['read'] })
  apply(ctx, { roles: { 'code-reviewer': { allow: ['read'] } } })
  emit()
  assert.equal(calls.restrict.length, 0)
  assert.equal(calls.warn.length, 0)
})

test('survives a rejected restriction instead of breaking the child', () => {
  const { ctx, calls, emit } = makeContext({
    preset: 'code-reviewer',
    visible: ['read'],
    restrictThrows: true,
  })
  apply(ctx, { roles: { 'code-reviewer': { allow: ['read'] } } })
  assert.doesNotThrow(() => emit())
  assert.ok(calls.warn.some(line => line.includes('restrict не применён')), 'failure is logged')
})

test('treats malformed rule values as empty', () => {
  const { ctx, calls, emit } = makeContext({ preset: 'code-reviewer', visible: ['read'] })
  apply(ctx, { roles: { 'code-reviewer': { allow: 'read', deny: [1, 2] } } })
  emit()
  assert.equal(calls.restrict.length, 0)
})
