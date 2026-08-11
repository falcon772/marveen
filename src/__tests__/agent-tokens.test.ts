import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getAgentTokenHash, findAgentByTokenHash } from '../db.js'
import { agentDir } from '../web/agent-config.js'
import {
  agentTokenPath, issueAgentToken, AGENT_TOKEN_FILENAME, MAIN_AGENT_TOKEN_FILENAME,
} from '../web/agent-tokens.js'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'

// S4.1a: per-agent token PROVISIONING only. Nothing here exercises auth --
// that lands in S4.1b. These tests cover issuance, idempotency, hash
// lookup, and (statically) that the auth gate / router / trust graph are
// untouched by this change.

const TEST_AGENT = 'zz-agent-tokens-test-tmp'
const OTHER_AGENT = 'zz-agent-tokens-test-tmp-2'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('agentTokenPath', () => {
  it('sub-agent -> agentDir(name)/.agent-token', () => {
    expect(agentTokenPath(TEST_AGENT)).toBe(join(agentDir(TEST_AGENT), AGENT_TOKEN_FILENAME))
  })

  it('main agent -> store/.main-agent-token, NOT the dead agentDir(MAIN_AGENT_ID) path', () => {
    const p = agentTokenPath(MAIN_AGENT_ID)
    expect(p).toBe(join(STORE_DIR, MAIN_AGENT_TOKEN_FILENAME))
    expect(p).not.toBe(join(agentDir(MAIN_AGENT_ID), AGENT_TOKEN_FILENAME))
  })
})

describe('issueAgentToken', () => {
  beforeEach(() => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
  })
  afterEach(() => {
    rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
  })

  it('writes the token file at mode 0600 and stores its sha256 hash', () => {
    issueAgentToken(TEST_AGENT)
    const path = agentTokenPath(TEST_AGENT)
    expect(existsSync(path)).toBe(true)

    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    const token = readFileSync(path, 'utf-8')
    const expectedHash = createHash('sha256').update(token).digest('hex')
    expect(getAgentTokenHash(TEST_AGENT)).toBe(expectedHash)
  })

  it('is idempotent: a second call does not overwrite the token or its stored hash', () => {
    issueAgentToken(TEST_AGENT)
    const path = agentTokenPath(TEST_AGENT)
    const firstToken = readFileSync(path, 'utf-8')
    const firstHash = getAgentTokenHash(TEST_AGENT)

    issueAgentToken(TEST_AGENT)
    const secondToken = readFileSync(path, 'utf-8')
    const secondHash = getAgentTokenHash(TEST_AGENT)

    expect(secondToken).toBe(firstToken)
    expect(secondHash).toBe(firstHash)
  })
})

describe('findAgentByTokenHash', () => {
  beforeEach(() => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    issueAgentToken(TEST_AGENT)
  })
  afterEach(() => {
    rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
  })

  it('resolves the presented token hash back to the agent name', () => {
    const token = readFileSync(agentTokenPath(TEST_AGENT), 'utf-8')
    const hash = createHash('sha256').update(token).digest('hex')
    expect(findAgentByTokenHash(hash)).toBe(TEST_AGENT)
  })

  it('returns null for an unknown hash', () => {
    expect(findAgentByTokenHash('0'.repeat(64))).toBeNull()
  })
})

describe('boot-time backfill semantics (listAgentNames loop + explicit main call)', () => {
  beforeEach(() => {
    mkdirSync(agentDir(TEST_AGENT), { recursive: true })
    mkdirSync(agentDir(OTHER_AGENT), { recursive: true })
  })
  afterEach(() => {
    rmSync(agentDir(TEST_AGENT), { recursive: true, force: true })
    rmSync(agentDir(OTHER_AGENT), { recursive: true, force: true })
  })

  it('an agent dir without a token gets one', () => {
    expect(existsSync(agentTokenPath(TEST_AGENT))).toBe(false)
    issueAgentToken(TEST_AGENT)
    expect(existsSync(agentTokenPath(TEST_AGENT))).toBe(true)
  })

  it('an agent that already has a token is untouched by a repeat backfill pass, a sibling without one still gets issued', () => {
    issueAgentToken(TEST_AGENT)
    const before = readFileSync(agentTokenPath(TEST_AGENT), 'utf-8')

    // Mirror web.ts's boot-time loop: `for (const name of listAgentNames()) issueAgentToken(name)`.
    for (const name of [TEST_AGENT, OTHER_AGENT]) issueAgentToken(name)

    expect(readFileSync(agentTokenPath(TEST_AGENT), 'utf-8')).toBe(before)
    expect(existsSync(agentTokenPath(OTHER_AGENT))).toBe(true)
  })
})

describe('additive-safety: S4.1a provisions only, nothing enforces yet', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const WEB_TS_SRC = readFileSync(join(here, '../web.ts'), 'utf-8')
  const MESSAGE_ROUTER_SRC = readFileSync(join(here, '../web/message-router.ts'), 'utf-8')
  const TEAM_TRUST_SRC = readFileSync(join(here, '../team-trust.ts'), 'utf-8')
  const MESSAGES_ROUTE_SRC = readFileSync(join(here, '../web/routes/messages.ts'), 'utf-8')

  it('web.ts provisions tokens at boot but the auth gate does not check them', () => {
    expect(WEB_TS_SRC).toMatch(/issueAgentToken/)
    // The existing single auth gate still only compares against DASHBOARD_TOKEN.
    expect(WEB_TS_SRC).toMatch(/checkBearerToken\(req\.headers\.authorization, DASHBOARD_TOKEN\)/)
    expect(WEB_TS_SRC).not.toMatch(/findAgentByTokenHash|getAgentTokenHash/)
  })

  it('message-router.ts / team-trust.ts / messages.ts route are untouched by token logic (S4.1b territory)', () => {
    for (const src of [MESSAGE_ROUTER_SRC, TEAM_TRUST_SRC, MESSAGES_ROUTE_SRC]) {
      expect(src).not.toMatch(/agent-tokens\.js|agentTokenPath|issueAgentToken|findAgentByTokenHash/)
    }
  })

  it('the coordinator-id 403 guard in messages.ts is still present, byte-intact', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/sanitizeAgentIdent\(from\)\s*===\s*COORDINATOR_AGENT_ID/)
    expect(MESSAGES_ROUTE_SRC).toMatch(/403/)
  })
})
