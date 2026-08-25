import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, writeAgentModel, readAgentModel, resolveModelId } from '../web/agent-config.js'

// S4.7 / B6-SEC-9: writeAgentModel must re-validate the model against the
// allowlist itself, not just trust the route layer that calls it -- so a
// future caller that skips the route's isAllowedModel check can't persist an
// unvalidated string into agent-config.json (audit #2's shell-injection sink).

const TEST_AGENT = 'zz-write-agent-model-revalidate-tmp'

function configPath(): string {
  return join(agentDir(TEST_AGENT), 'agent-config.json')
}

beforeEach(() => {
  mkdirSync(agentDir(TEST_AGENT), { recursive: true })
})
afterEach(() => {
  rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
})

describe('writeAgentModel', () => {
  it('throws on a model not on the allowlist, and writes nothing', () => {
    expect(existsSync(configPath())).toBe(false)
    expect(() => writeAgentModel(TEST_AGENT, 'gpt-4')).toThrow()
    expect(existsSync(configPath())).toBe(false)
  })

  it('throws on a value with shell metacharacters, and leaves an existing config unchanged', () => {
    writeAgentModel(TEST_AGENT, 'opus')
    const before = readFileSync(configPath(), 'utf-8')
    const beforeMtime = statSync(configPath()).mtimeMs

    expect(() => writeAgentModel(TEST_AGENT, "x' ; touch /tmp/pwn ; '")).toThrow()

    expect(readFileSync(configPath(), 'utf-8')).toBe(before)
    expect(statSync(configPath()).mtimeMs).toBe(beforeMtime)
  })

  it('throws on a made-up [1m] variant of a real id (no suffix-stripping)', () => {
    expect(() => writeAgentModel(TEST_AGENT, 'claude-sonnet-4-6[1m]')).toThrow()
  })

  it('accepts a known alias and stores the resolved canonical id, not the alias', () => {
    writeAgentModel(TEST_AGENT, 'opus')
    const config = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(config.model).toBe('claude-opus-4-8[1m]')
    expect(config.model).not.toBe('opus')
    expect(readAgentModel(TEST_AGENT)).toBe('claude-opus-4-8[1m]')
  })

  it('accepts an already-resolved canonical id unchanged (idempotent resolveModelId)', () => {
    writeAgentModel(TEST_AGENT, 'claude-sonnet-4-6')
    const config = JSON.parse(readFileSync(configPath(), 'utf-8'))
    expect(config.model).toBe('claude-sonnet-4-6')
  })

  it('regression: succeeds for both existing call-site shapes with a valid model', () => {
    // POST /api/agents (routes/agents.ts ~525/551): writeAgentModel(name, resolveModelId(requestedModel))
    writeAgentModel(TEST_AGENT, resolveModelId('sonnet'))
    expect(readAgentModel(TEST_AGENT)).toBe('claude-sonnet-4-6')

    // PUT /api/agents/:name (routes/agents.ts ~1374): writeAgentModel(name, resolveModelId(data.model))
    writeAgentModel(TEST_AGENT, resolveModelId('claude-haiku-4-5-20251001'))
    expect(readAgentModel(TEST_AGENT)).toBe('claude-haiku-4-5-20251001')
  })
})
