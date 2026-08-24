import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

// fix/vault-bind-explicit-targets (S4.5): the manual "assign secret ->
// server" bind used to auto-fan-out on serverName alone -- any .mcp.json
// with a same-named server silently got the vault:ID reference. This closes
// that footgun: POST /api/vault/bindings now writes ONLY to an explicit
// `targets` array (fail-closed, 400 if empty/missing), and a new read-only
// GET /api/vault/bindings/resolve lets the UI show candidates for the
// operator to confirm before any write happens.

const TEST_ROOT = join('/tmp', `vault-bind-explicit-${randomUUID()}`)

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: TEST_ROOT }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { tryHandleConnectors } from '../web/routes/connectors.js'
import { resolveBindingCandidates, getBindings } from '../web/vault-bindings.js'
import { setSecret } from '../web/vault.js'

// Unique per test run so this can never collide with a real server name that
// might happen to live in the developer's actual ~/.claude.json (collectAllMcpFilePaths
// also walks the real OS homedir, which this test does not control).
const SERVER_NAME = `zz-vault-bind-test-${randomUUID().slice(0, 8)}`
const OTHER_SERVER_NAME = `zz-vault-bind-other-${randomUUID().slice(0, 8)}`

const PROJECT_MCP = join(TEST_ROOT, '.mcp.json')
const AGENT_NAME = 'zz-vault-bind-agent'
const AGENT_MCP = join(TEST_ROOT, 'agents', AGENT_NAME, '.mcp.json')

function writeMcp(path: string, serverName: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    mcpServers: { [serverName]: { command: 'echo', args: ['hi'], env: {} } },
  }, null, 2))
}

beforeAll(() => {
  mkdirSync(join(TEST_ROOT, 'store'), { recursive: true })
  writeMcp(PROJECT_MCP, SERVER_NAME)
  writeMcp(AGENT_MCP, SERVER_NAME)
  setSecret('zz-test-secret', 'test secret', 'sw0rdfish')
})

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

async function callRoute(
  pathAndQuery: string,
  method: string,
  bodyObj?: Record<string, unknown>,
): Promise<{ status: number, body: any }> {
  const req = (bodyObj !== undefined
    ? Readable.from([Buffer.from(JSON.stringify(bodyObj))])
    : Readable.from([])) as any
  let status = 200
  let body = ''
  const res = {
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  // Mirror src/web.ts: `path` is url.pathname (no query string), `url` is the
  // full parsed URL that route handlers read searchParams off of.
  const url = new URL('http://x' + pathAndQuery)
  const handled = await tryHandleConnectors({
    req, res, path: url.pathname, method, url,
    authenticatedAgent: null,
  } as any)
  expect(handled).toBe(true)
  return { status, body: body ? JSON.parse(body) : null }
}

describe('GET /api/vault/bindings/resolve: read-only candidate discovery', () => {
  it('returns candidates for every .mcp.json with a matching server, without writing anything', async () => {
    const beforeProjectMtime = statSync(PROJECT_MCP).mtimeMs
    const beforeAgentMtime = statSync(AGENT_MCP).mtimeMs

    const { status, body } = await callRoute(
      `/api/vault/bindings/resolve?serverName=${encodeURIComponent(SERVER_NAME)}`,
      'GET',
    )

    expect(status).toBe(200)
    const paths = body.candidates.map((c: any) => c.mcpFilePath)
    expect(paths).toContain(PROJECT_MCP)
    expect(paths).toContain(AGENT_MCP)
    expect(body.candidates.length).toBe(2)
    // Every candidate carries a human-readable label for the UI checklist.
    for (const c of body.candidates) {
      expect(typeof c.agentLabel).toBe('string')
      expect(c.agentLabel.length).toBeGreaterThan(0)
    }

    // The defining property: a resolve call must not touch any file.
    expect(statSync(PROJECT_MCP).mtimeMs).toBe(beforeProjectMtime)
    expect(statSync(AGENT_MCP).mtimeMs).toBe(beforeAgentMtime)
  })

  it('returns an empty list for a server name nothing has', async () => {
    const { status, body } = await callRoute(
      `/api/vault/bindings/resolve?serverName=${encodeURIComponent(OTHER_SERVER_NAME)}`,
      'GET',
    )
    expect(status).toBe(200)
    expect(body.candidates).toEqual([])
  })

  it('400s when serverName is missing', async () => {
    const { status, body } = await callRoute('/api/vault/bindings/resolve', 'GET')
    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
  })

  it('resolveBindingCandidates is the same function the route calls (unit-level check)', () => {
    const candidates = resolveBindingCandidates(SERVER_NAME)
    expect(candidates.map(c => c.mcpFilePath).sort()).toEqual([AGENT_MCP, PROJECT_MCP].sort())
  })
})

describe('POST /api/vault/bindings: fail-closed, explicit targets only', () => {
  it('writes nothing and returns 400 when targets is missing', async () => {
    const beforeMtime = statSync(PROJECT_MCP).mtimeMs
    const { status, body } = await callRoute('/api/vault/bindings', 'POST', {
      vaultSecretId: 'zz-test-secret',
      envVar: 'ZZ_API_KEY',
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/targets/i)
    expect(statSync(PROJECT_MCP).mtimeMs).toBe(beforeMtime)
    expect(getBindings().find(b => b.envVar === 'ZZ_API_KEY')).toBeUndefined()
  })

  it('writes nothing and returns 400 when targets is an empty array (no more serverName auto-fan-out)', async () => {
    const beforeMtime = statSync(AGENT_MCP).mtimeMs
    const { status, body } = await callRoute('/api/vault/bindings', 'POST', {
      vaultSecretId: 'zz-test-secret',
      envVar: 'ZZ_API_KEY',
      serverName: SERVER_NAME, // present, but must NOT trigger fan-out any more
      targets: [],
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(statSync(AGENT_MCP).mtimeMs).toBe(beforeMtime)
  })

  it('with one explicit target, only that file is written -- the other candidate stays untouched', async () => {
    const agentMtimeBefore = statSync(AGENT_MCP).mtimeMs

    const { status, body } = await callRoute('/api/vault/bindings', 'POST', {
      vaultSecretId: 'zz-test-secret',
      envVar: 'ZZ_API_KEY',
      targets: [{ mcpFilePath: PROJECT_MCP, serverName: SERVER_NAME }],
    })

    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.synced).toBe(1)

    const projectCfg = JSON.parse(readFileSync(PROJECT_MCP, 'utf-8'))
    expect(projectCfg.mcpServers[SERVER_NAME].env.ZZ_API_KEY).toBe('vault:zz-test-secret')

    // The agent's .mcp.json was a resolve candidate but was never ticked --
    // it must be byte-for-byte untouched.
    expect(statSync(AGENT_MCP).mtimeMs).toBe(agentMtimeBefore)
    const agentCfg = JSON.parse(readFileSync(AGENT_MCP, 'utf-8'))
    expect(agentCfg.mcpServers[SERVER_NAME].env.ZZ_API_KEY).toBeUndefined()
  })
})
