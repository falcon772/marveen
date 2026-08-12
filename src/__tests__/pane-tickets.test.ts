import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mintPaneTicket, consumePaneTicket } from '../web/pane-tickets.js'

// S4.1c: the SSE pane stream's root-token-in-URL replacement. A ticket is
// in-memory, single-use, agent-bound, and dies after a short TTL -- these
// tests cover exactly those four properties plus the "wrong ticket string"
// rejection path, since that is what closes the actual leak (item 0 of the
// recon: DASHBOARD_TOKEN must never ride in the SSE URL).

const AGENT_A = 'zz-pane-ticket-agent-a'
const AGENT_B = 'zz-pane-ticket-agent-b'

describe('mintPaneTicket / consumePaneTicket', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a freshly minted ticket authorizes its own agent', () => {
    const t = mintPaneTicket(AGENT_A)
    expect(consumePaneTicket(AGENT_A, t)).toBe(true)
  })

  it('is single-use: the same ticket cannot be consumed twice', () => {
    const t = mintPaneTicket(AGENT_A)
    expect(consumePaneTicket(AGENT_A, t)).toBe(true)
    expect(consumePaneTicket(AGENT_A, t)).toBe(false)
  })

  it('is agent-bound: a ticket minted for A does not authorize B', () => {
    const t = mintPaneTicket(AGENT_A)
    expect(consumePaneTicket(AGENT_B, t)).toBe(false)
    // and remains unburned for its rightful owner after the wrong-agent attempt
    expect(consumePaneTicket(AGENT_A, t)).toBe(true)
  })

  it('rejects an empty, garbled, or unknown ticket string', () => {
    mintPaneTicket(AGENT_A)
    expect(consumePaneTicket(AGENT_A, '')).toBe(false)
    expect(consumePaneTicket(AGENT_A, 'not-a-real-ticket')).toBe(false)
    expect(consumePaneTicket(AGENT_A, '0'.repeat(64))).toBe(false)
  })

  it('expires after its TTL (20s) and is then rejected', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const t = mintPaneTicket(AGENT_A)
    vi.setSystemTime(20_001)
    expect(consumePaneTicket(AGENT_A, t)).toBe(false)
  })

  it('is still valid a moment before expiry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const t = mintPaneTicket(AGENT_A)
    vi.setSystemTime(19_999)
    expect(consumePaneTicket(AGENT_A, t)).toBe(true)
  })

  it('each mint is independent: consuming one ticket does not burn a sibling for the same agent', () => {
    const t1 = mintPaneTicket(AGENT_A)
    const t2 = mintPaneTicket(AGENT_A)
    expect(consumePaneTicket(AGENT_A, t1)).toBe(true)
    expect(consumePaneTicket(AGENT_A, t2)).toBe(true)
  })
})
