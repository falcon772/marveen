import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// S4.1c static/invariant guards. These complement the runtime unit tests in
// pane-tickets.test.ts (mint/consume/expiry/agent-binding) and the gate test
// in message-from-auth.test.ts (root token no longer accepted via ?token=)
// by pinning source shape for the pieces that are awkward to exercise as a
// live request in this test setup (no real http.Server / tmux session here):
// the mint endpoint's auth path, the bootstrap print, and that every other
// route's auth is untouched.

const here = dirname(fileURLToPath(import.meta.url))
const WEB_TS_SRC = readFileSync(join(here, '../web.ts'), 'utf-8')
const AGENT_TERMINAL_SRC = readFileSync(join(here, '../web/routes/agent-terminal.ts'), 'utf-8')

describe('pane/ticket mint endpoint is header-authenticated, not a new public route', () => {
  it('the mint route is dispatched through the normal route chain, not special-cased in the gate', () => {
    // isPublicApi / isSseStream / isInterAgentPost are the only three ways
    // the /api/* gate in web.ts relaxes header-DASHBOARD_TOKEN auth. None of
    // them contains a route-matching pattern for the ticket-mint path (a
    // literal `\/pane\/ticket` regex fragment) -- only plain-English mentions
    // in comments, which don't have escaped slashes. It must fall through to
    // the plain `checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)`
    // branch like every other POST route.
    expect(WEB_TS_SRC).not.toContain('\\/pane\\/ticket')

    expect(AGENT_TERMINAL_SRC).toContain(String.raw`path.match(/^\/api\/agents\/([^/]+)\/pane\/ticket$/)`)
    expect(AGENT_TERMINAL_SRC).toContain("method === 'POST'")
    expect(AGENT_TERMINAL_SRC).toContain('mintPaneTicket(name)')
  })

  it('the mint handler reads no ?token= or ?ticket= of its own -- the header IS the auth', () => {
    const ticketBlockStart = AGENT_TERMINAL_SRC.indexOf('const ticketMatch')
    const ticketBlockEnd = AGENT_TERMINAL_SRC.indexOf('const streamMatch')
    expect(ticketBlockStart).toBeGreaterThan(0)
    expect(ticketBlockEnd).toBeGreaterThan(ticketBlockStart)
    const ticketRouteSrc = AGENT_TERMINAL_SRC.slice(ticketBlockStart, ticketBlockEnd)
    expect(ticketRouteSrc).not.toMatch(/searchParams\.get\('token'\)|searchParams\.get\('ticket'\)/)
  })
})

describe('bootstrap print carries no token-bearing URL', () => {
  it('the stderr write has no ?token= and no URL is built with DASHBOARD_TOKEN interpolated in', () => {
    expect(WEB_TS_SRC).not.toMatch(/\?token=/)
    expect(WEB_TS_SRC).not.toMatch(/bootstrapUrl/)
    // The token is still printed (operators need it), just not inside a URL.
    expect(WEB_TS_SRC).toContain('Dashboard: http://127.0.0.1:${port}/')
    expect(WEB_TS_SRC).toContain('Access token (paste into the dashboard login field)')
  })
})

describe('everything else about the auth gate is untouched by S4.1c', () => {
  it('every other /api/* route still needs the header DASHBOARD_TOKEN; /api/messages per-agent auth is untouched', () => {
    expect(WEB_TS_SRC).toContain('checkBearerToken(req.headers.authorization, DASHBOARD_TOKEN)')
    expect(WEB_TS_SRC).toContain('if (!headerOk && !queryOk && authenticatedAgent === null)')
    expect(WEB_TS_SRC).toContain("isInterAgentPost = path === '/api/messages' && method === 'POST'")
    expect(WEB_TS_SRC).toContain('resolveAgentFromBearer(req.headers.authorization)')
  })

  it('the constant-time DASHBOARD_TOKEN comparison in dashboard-auth.ts is unchanged', () => {
    const DASHBOARD_AUTH_SRC = readFileSync(join(here, '../web/dashboard-auth.ts'), 'utf-8')
    expect(DASHBOARD_AUTH_SRC).toContain('timingSafeEqual(provided, wanted)')
  })

  it('the ticket comparison in pane-tickets.ts is also constant-time', () => {
    const PANE_TICKETS_SRC = readFileSync(join(here, '../web/pane-tickets.ts'), 'utf-8')
    expect(PANE_TICKETS_SRC).toContain('timingSafeEqual(bufA, bufB)')
  })

  it('no persona/template file references the new SSE ticket routes (scope guard: web.ts + agent-terminal.ts + pane-tickets.ts + app.js only)', () => {
    const TEMPLATE_SRC = readFileSync(join(here, '../../templates/CLAUDE.md.template'), 'utf-8')
    expect(TEMPLATE_SRC).not.toMatch(/\?token=|pane\/ticket|pane\/stream/)
  })
})
