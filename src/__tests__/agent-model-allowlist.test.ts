import { describe, it, expect } from 'vitest'
import { isAllowedModel, availableModelIds, DEFAULT_MODEL } from '../web/agent-config.js'

describe('availableModelIds', () => {
  it('always includes the 4 Claude ids, [1m] suffix intact', () => {
    const ids = availableModelIds()
    expect(ids).toContain('claude-fable-5')
    expect(ids).toContain('claude-opus-4-8[1m]')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-haiku-4-5-20251001')
    expect(ids).toContain(DEFAULT_MODEL)
  })
})

describe('isAllowedModel', () => {
  it('accepts a [1m] list id (the default model)', () => {
    expect(isAllowedModel('claude-opus-4-8[1m]')).toBe(true)
  })

  it('accepts a non-[1m] list id', () => {
    expect(isAllowedModel('claude-sonnet-4-6')).toBe(true)
  })

  it('accepts a known alias, resolved before the allowlist check', () => {
    expect(isAllowedModel('sonnet')).toBe(true)
    expect(isAllowedModel('opus')).toBe(true)
  })

  it('rejects a value with shell metacharacters', () => {
    expect(isAllowedModel("x' ; touch /tmp/pwn ; '")).toBe(false)
  })

  it('rejects a model id that is not on the allowlist', () => {
    expect(isAllowedModel('gpt-4')).toBe(false)
  })

  it('rejects a made-up [1m] variant of a real id (no suffix-stripping)', () => {
    expect(isAllowedModel('claude-sonnet-4-6[1m]')).toBe(false)
  })

  it('rejects empty/non-string input', () => {
    expect(isAllowedModel('')).toBe(false)
  })
})
