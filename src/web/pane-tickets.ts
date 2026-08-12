import { randomBytes, timingSafeEqual } from 'node:crypto'

// S4.1c: short-lived single-use ticket for the live-pane SSE stream.
// EventSource cannot set an Authorization header, so instead of putting the
// root DASHBOARD_TOKEN in the query string (the leak this closes -- see
// web.ts's SSE auth gate and agent-terminal.ts's mint endpoint), the client
// mints a random ticket over a header-authenticated POST and passes only
// that -- bound to one agent, burned on first use, dead after 20s -- in the
// SSE URL.
//
// In-memory only, deliberately: this is a single loopback dashboard process,
// not a multi-process deployment, and a ticket has nothing in common with the
// durable, hash-at-rest agent_tokens row (see agent-tokens.ts) it lives next
// to in the codebase -- different lifetime, different store. Persisting a
// 20-second credential to SQLite would be pure overhead.
const TICKET_TTL_MS = 20_000

interface TicketEntry {
  agent: string
  expiresAt: number
  used: boolean
}

const tickets = new Map<string, TicketEntry>()

function sweepExpired(now: number): void {
  for (const [t, entry] of tickets) {
    if (entry.used || entry.expiresAt <= now) tickets.delete(t)
  }
}

export function mintPaneTicket(agent: string): string {
  const now = Date.now()
  sweepExpired(now)
  const ticket = randomBytes(32).toString('hex')
  tickets.set(ticket, { agent, expiresAt: now + TICKET_TTL_MS, used: false })
  return ticket
}

// Constant-time compare of the presented ticket against each live candidate,
// mirroring checkBearerToken's approach for the same reason: don't lean on
// ordinary string/Map-key equality for a secret, even one this short-lived.
function ticketsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Returns true and burns the ticket iff it exists, is unexpired, unused, and
// was minted for exactly this agent. Any mismatch (wrong agent, wrong/garbled
// ticket, expired, already used) returns false without revealing which.
export function consumePaneTicket(agent: string, ticket: string): boolean {
  const now = Date.now()
  sweepExpired(now)
  if (!ticket) return false
  for (const [t, entry] of tickets) {
    if (entry.used || entry.expiresAt <= now) continue
    if (entry.agent !== agent) continue
    if (!ticketsEqual(t, ticket)) continue
    entry.used = true
    tickets.delete(t)
    return true
  }
  return false
}
