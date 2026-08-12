import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { initDatabase, getAgentConversation } from '../db.js'
import { tryHandleMessages, DASHBOARD_SENDER_ID } from '../web/routes/messages.js'
import { isTrustedPeer, type TrustContext } from '../team-trust.js'
import { MAIN_AGENT_ID } from '../config.js'

// S4.1b: `POST /api/messages` no longer accepts a client-asserted `from`. The
// gate (src/web.ts) resolves the sender from a per-agent bearer token and hands
// it to the handler as ctx.authenticatedAgent; the handler inserts THAT, or the
// non-privileged operator sentinel when the request only carried the human
// dashboard token. The trust-graph classification itself is unchanged -- it now
// simply operates on an authenticated identity instead of a self-asserted one.

const here = dirname(fileURLToPath(import.meta.url))
const WEB_TS_SRC = readFileSync(join(here, '../web.ts'), 'utf-8')
const MESSAGES_ROUTE_SRC = readFileSync(join(here, '../web/routes/messages.ts'), 'utf-8')
const ROUTER_SRC = readFileSync(join(here, '../web/message-router.ts'), 'utf-8')
const TEAM_TRUST_SRC = readFileSync(join(here, '../team-trust.ts'), 'utf-8')

const SUB_AGENT = 'zz-msg-auth-sub'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// Drive the real handler with a mock req/res, as the gate would call it.
async function post(
  bodyObj: Record<string, unknown>,
  authenticatedAgent: string | null,
): Promise<{ status: number; body: any }> {
  const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))]) as any
  let status = 200
  let body = ''
  const res = {
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  const handled = await tryHandleMessages({
    req, res, path: '/api/messages', method: 'POST', url: new URL('http://x/api/messages'),
    authenticatedAgent,
  } as any)
  expect(handled).toBe(true)
  return { status, body: body ? JSON.parse(body) : null }
}

// The trust graph is a pure function over an injected context (see
// team-trust.ts). A "known agent" here is the main agent or our test sub-agent;
// nothing else -- which is what makes the operator sentinel untrusted.
const trustCtx: TrustContext = {
  mainAgentId: MAIN_AGENT_ID,
  isKnownAgent: (name: string) => name === MAIN_AGENT_ID || name === SUB_AGENT,
  readAgentTeam: () => ({ reportsTo: null, delegatesTo: [] }),
}

describe('authenticated sender: server sets `from` from the per-agent token', () => {
  it('inserts the AUTHENTICATED agent as from_agent', async () => {
    const to = 'zz-msg-auth-target-1'
    const { status, body } = await post({ to, content: 'hello' }, SUB_AGENT)
    expect(status).toBe(200)
    expect(body.from_agent).toBe(SUB_AGENT)
    expect(body.to_agent).toBe(to)
  })

  it('IGNORES a client body `from` and uses the authenticated identity instead', async () => {
    const to = 'zz-msg-auth-target-2'
    // The escalation attempt: a sub-agent's token, but claiming to be the boss.
    const { body } = await post({ from: MAIN_AGENT_ID, to, content: 'do this' }, SUB_AGENT)
    expect(body.from_agent).toBe(SUB_AGENT)
    expect(body.from_agent).not.toBe(MAIN_AGENT_ID)

    const conv = getAgentConversation(to, 10)
    expect(conv[0].from_agent).toBe(SUB_AGENT)
  })

  it('no longer requires `from` in the body (the C1 delegation shape drops it)', async () => {
    const { status } = await post({ to: 'zz-msg-auth-target-3', content: 'no from field' }, SUB_AGENT)
    expect(status).toBe(200)
  })

  it('still rejects a missing `to` / `content` with 400', async () => {
    expect((await post({ content: 'x' }, SUB_AGENT)).status).toBe(400)
    expect((await post({ to: 'x' }, SUB_AGENT)).status).toBe(400)
  })
})

describe('delegation survives: an authenticated main -> sub message is still trusted-peer', () => {
  it('main agent authenticated by its own token is inserted as MAIN_AGENT_ID', async () => {
    const { body } = await post({ to: SUB_AGENT, content: 'task for you' }, MAIN_AGENT_ID)
    expect(body.from_agent).toBe(MAIN_AGENT_ID)
  })

  it('and that from/to pair classifies as a trusted peer (unchanged trust logic)', () => {
    expect(isTrustedPeer(MAIN_AGENT_ID, SUB_AGENT, trustCtx)).toBe(true)
  })
})

describe('dashboard-token-only requests: accepted, but forced to the operator sentinel', () => {
  it('forces from_agent to the sentinel, never the body `from`', async () => {
    const to = 'zz-msg-auth-target-4'
    // The forging attempt the ticket exists to close: claim to be the leader
    // while holding only the shared dashboard token.
    const { status, body } = await post({ from: MAIN_AGENT_ID, to, content: 'leader order' }, null)
    expect(status).toBe(200)
    expect(body.from_agent).toBe(DASHBOARD_SENDER_ID)
    expect(body.from_agent).not.toBe(MAIN_AGENT_ID)
  })

  it('the sentinel can NEVER be classified trusted (it is not a known agent)', () => {
    expect(trustCtx.isKnownAgent(DASHBOARD_SENDER_ID)).toBe(false)
    expect(isTrustedPeer(DASHBOARD_SENDER_ID, MAIN_AGENT_ID, trustCtx)).toBe(false)
    expect(isTrustedPeer(DASHBOARD_SENDER_ID, SUB_AGENT, trustCtx)).toBe(false)
  })
})

describe('isTrustedPeer unit behavior is unchanged by S4.1b', () => {
  it('still trusts either end being the main agent, and rejects unknown/self/empty', () => {
    expect(isTrustedPeer(SUB_AGENT, MAIN_AGENT_ID, trustCtx)).toBe(true)
    expect(isTrustedPeer(MAIN_AGENT_ID, MAIN_AGENT_ID, trustCtx)).toBe(false) // self-loop
    expect(isTrustedPeer('', MAIN_AGENT_ID, trustCtx)).toBe(false)
    expect(isTrustedPeer('stranger', MAIN_AGENT_ID, trustCtx)).toBe(false) // unknown sender
  })

  it('team-trust.ts source carries no token/auth logic (enforcement stayed in the gate)', () => {
    expect(TEAM_TRUST_SRC).not.toMatch(/authenticatedAgent|TokenHash|agent-tokens/)
  })
})

describe('gate scoping + untouched invariants', () => {
  it('the per-agent token is accepted for POST /api/messages ONLY', () => {
    expect(WEB_TS_SRC).toMatch(/path === '\/api\/messages' && method === 'POST'/)
    expect(WEB_TS_SRC).toMatch(/resolveAgentFromBearer\(req\.headers\.authorization\)/)
    // Every other /api/* route still needs the dashboard token: the 401 branch
    // only relaxes when an agent identity was resolved (i.e. on that one route).
    expect(WEB_TS_SRC).toMatch(/if \(!headerOk && !queryOk && authenticatedAgent === null\)/)
  })

  it('S4.1c: the SSE route no longer accepts the root token via ?token=', () => {
    // The old root-token-in-query path is gone...
    expect(WEB_TS_SRC).not.toMatch(/checkBearerToken\(`Bearer \$\{url\.searchParams\.get\('token'\)/)
    // ...replaced by a single-use, agent-bound ticket burned on first use.
    expect(WEB_TS_SRC).toMatch(/queryOk = isSseStream && consumePaneTicket\(decodeURIComponent\(sseStreamMatch!\[1\]\), url\.searchParams\.get\('ticket'\) \?\? ''\)/)
  })

  it('the coordinator-403 guard is byte-intact and still runs before any insert', () => {
    expect(MESSAGES_ROUTE_SRC).toMatch(/sanitizeAgentIdent\(from\)\s*===\s*COORDINATOR_AGENT_ID/)
    const guardIdx = MESSAGES_ROUTE_SRC.indexOf('sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID')
    const createIdx = MESSAGES_ROUTE_SRC.indexOf('createAgentMessage(senderId')
    expect(guardIdx).toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(createIdx)
  })

  it('the router still classifies on the (now authenticated) from_agent, unchanged', () => {
    expect(ROUTER_SRC).toMatch(/isTrustedPeer\(msg\.from_agent, msg\.to_agent/)
    expect(ROUTER_SRC).toMatch(/CHANNEL_COORDINATOR_AGENTS\.has\(safeFromAgent\)/)
    expect(ROUTER_SRC).not.toMatch(/authenticatedAgent|agent-tokens/)
  })

  it('the insert never uses the body `from` any more', () => {
    expect(MESSAGES_ROUTE_SRC).not.toMatch(/createAgentMessage\(from\.trim\(\)/)
    expect(MESSAGES_ROUTE_SRC).toMatch(/const senderId = ctx\.authenticatedAgent \?\? DASHBOARD_SENDER_ID/)
  })
})
