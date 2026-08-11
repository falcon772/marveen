import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, CHAT_SYSTEM_AGENTS } from '../db.js'
import { isReservedAgentId, reservedAgentIds } from '../web/reserved-agent-ids.js'
import { DASHBOARD_SENDER_ID } from '../web/routes/messages.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { MAIN_AGENT_ID } from '../config.js'

// S4.1b Phase 2: every delegation caller now authenticates /api/messages with
// its OWN per-agent token and no longer self-asserts `from`. The surgical rule:
// ONLY the /api/messages call switches tokens -- memory / daily-log / kanban /
// agents calls still need the dashboard token and would 401 on a per-agent one.

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../..')
const read = (rel: string) => readFileSync(join(repo, rel), 'utf-8')

const TEMPLATE = read('templates/CLAUDE.md.template')
const SCAFFOLD = read('src/web/agent-scaffold.ts')
const HANDOFF = read('seed-skills/handoff/SKILL.md')
const FLEET_PY = read('seed-skills/fleet-helper/scripts/fleet.py')
const HEARTBEAT = read('src/web/heartbeat-agent-scaffold.ts')
const WEB_TS = read('src/web.ts')
const AGENTS_ROUTE = read('src/web/routes/agents.ts')
const MESSAGES_ROUTE = read('src/web/routes/messages.ts')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// Pull the single `curl ... /api/messages ...` block out of a doc/source file
// so assertions target THAT call rather than the file as a whole.
function messagesCall(src: string): string {
  const idx = src.indexOf('/api/messages')
  expect(idx).toBeGreaterThan(0)
  // A generous window: the curl continuation lines that follow the URL.
  return src.slice(Math.max(0, idx - 200), idx + 500)
}

describe('#3 reserved-name guard', () => {
  it('reserves all six server-side identities', () => {
    const ids = reservedAgentIds()
    expect(ids).toContain(DASHBOARD_SENDER_ID)
    expect(ids).toContain(MAIN_AGENT_ID)
    expect(ids).toContain(COORDINATOR_AGENT_ID)
    for (const sys of CHAT_SYSTEM_AGENTS) expect(ids).toContain(sys)
  })

  it('rejects each reserved id as an agent name', () => {
    for (const id of reservedAgentIds()) {
      expect(isReservedAgentId(id), `${id} must be reserved`).toBe(true)
    }
  })

  it('rejects the sentinel specifically -- the isKnownAgent escalation', () => {
    expect(isReservedAgentId('dashboard-operator')).toBe(true)
    // Sanitization-equivalent spellings must not slip past.
    expect(isReservedAgentId('Dashboard Operator')).toBe(true)
    expect(isReservedAgentId('dashboard-operator!')).toBe(true)
    expect(isReservedAgentId('  DASHBOARD-OPERATOR  ')).toBe(true)
  })

  it('still allows ordinary agent names', () => {
    expect(isReservedAgentId('zara')).toBe(false)
    expect(isReservedAgentId('dev3')).toBe(false)
    expect(isReservedAgentId('')).toBe(false)
  })

  it('the create route enforces it before scaffolding, not via the dir-409', () => {
    const guardIdx = AGENTS_ROUTE.indexOf('isReservedAgentId(name)')
    const scaffoldIdx = AGENTS_ROUTE.indexOf('scaffoldAgentDir(name)')
    expect(guardIdx).toBeGreaterThan(0)
    expect(guardIdx).toBeLessThan(scaffoldIdx)
  })
})

describe('#1 warn-log narrowing', () => {
  it('only warns on the authenticated path (dashboard sends stay silent)', () => {
    expect(MESSAGES_ROUTE).toMatch(
      /if \(ctx\.authenticatedAgent && from\?\.trim\(\) && from\.trim\(\) !== senderId\)/,
    )
  })
})

describe('main-agent delegation (CLAUDE.md.template)', () => {
  const call = messagesCall(TEMPLATE)

  it('authenticates with the main agent token', () => {
    expect(call).toContain('store/.main-agent-token')
  })

  it('no longer self-asserts a `from`', () => {
    expect(call).not.toMatch(/"from"\s*:/)
  })

  it('keeps the Bearer header', () => {
    expect(call).toMatch(/Authorization: Bearer/)
  })

  it('leaves every OTHER api call on the dashboard token', () => {
    // The memory / daily-log / agents examples are untouched: each still names
    // the dashboard token, and the /api/agents one-liner keeps it inline.
    expect(TEMPLATE).toContain('Bearer $(cat store/.dashboard-token)')
    expect(TEMPLATE).toMatch(/store\/\.dashboard-token\)" http:\/\/localhost:3420\/api\/agents/)
    expect(TEMPLATE).toContain('/api/memories')
    expect(TEMPLATE).toContain('/api/daily-log')
  })

  it('the main token is referenced only in the inter-agent delegation section', () => {
    const hits = TEMPLATE.split('store/.main-agent-token').length - 1
    expect(hits).toBeGreaterThan(0)
    // It must never appear on a non-message endpoint line, which would 401.
    for (const line of TEMPLATE.split(/\r?\n/)) {
      if (!line.includes('store/.main-agent-token')) continue
      expect(line).not.toMatch(/\/api\/(memories|daily-log|schedules|agents|kanban)/)
    }
  })
})

describe('sub-agent generated CLAUDE.md (agent-scaffold.ts)', () => {
  it('uses the bare .agent-token (cwd is agents/<name>), never $AGENT_ID', () => {
    expect(SCAFFOLD).toContain('Bearer $(cat .agent-token)')
    expect(SCAFFOLD).not.toContain('agents/$AGENT_ID/.agent-token')
  })

  it('drops the self-asserted from on the messages call', () => {
    const call = messagesCall(SCAFFOLD)
    expect(call).not.toContain('\\"from\\":\\"AGENT_NAME\\"')
  })

  it('keeps memory / daily-log / schedules on the dashboard token', () => {
    expect(SCAFFOLD).toContain('/api/memories -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)"')
    expect(SCAFFOLD).toContain('/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)"')
    expect(SCAFFOLD).toContain('/api/schedules -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)"')
  })
})

describe('handoff skill', () => {
  const call = messagesCall(HANDOFF)

  it('sends with the caller\'s own token and no `from`', () => {
    expect(call).toContain('Bearer $(cat .agent-token)')
    expect(call).not.toContain('\\"from\\":\\"$AGENT_ID\\"')
  })

  it('leaves the read-only memory/daily-log curls on the dashboard token', () => {
    expect(HANDOFF).toContain('curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)"')
  })
})

describe('fleet.py send_message', () => {
  it('uses a per-agent token for /api/messages only', () => {
    expect(FLEET_PY).toMatch(/def send_message\(to_agent, content\)/)
    expect(FLEET_PY).toMatch(/api\("POST", "\/api\/messages", \{"to": to_agent, "content": content\},\s*\n?\s*auth_token=agent_token\(\)\)/)
  })

  it('no longer passes a client `from`', () => {
    expect(FLEET_PY).not.toMatch(/"from": from_agent/)
  })

  it('resolves the sub-agent token from cwd and the main token from store/', () => {
    expect(FLEET_PY).toContain('.agent-token')
    expect(FLEET_PY).toContain('.main-agent-token')
  })

  it('every other helper still uses the shared dashboard token', () => {
    // api() defaults to token() (the dashboard token) unless auth_token is set,
    // and only send_message sets it.
    expect(FLEET_PY).toMatch(/Bearer " \+ \(auth_token or token\(\)\)/)
    expect(FLEET_PY.match(/auth_token=agent_token\(\)/g) ?? []).toHaveLength(1)
  })
})

describe('heartbeat delivery', () => {
  it('authenticates as itself via its own agent-dir token', () => {
    expect(HEARTBEAT).toContain('TOKEN=$(cat ${id.agentDir}/.agent-token)')
  })

  it('no longer self-asserts from:"heartbeat"', () => {
    expect(HEARTBEAT).not.toContain('"from":"heartbeat"')
  })

  it('keeps the store dir for the DB (not repurposed as the token path)', () => {
    expect(HEARTBEAT).toContain('${id.storeDir}/claudeclaw.db')
  })
})

describe('boot backfill covers dashboard-hidden agents', () => {
  it('web.ts enumerates ALL agent dirs, not the UI-filtered list', () => {
    expect(WEB_TS).toMatch(/for \(const name of listAllAgentDirNames\(\)\) issueAgentToken\(name\)/)
    expect(WEB_TS).not.toMatch(/for \(const name of listAgentNames\(\)\) issueAgentToken\(name\)/)
    // The main agent is still issued explicitly (it has no agents/ dir).
    expect(WEB_TS).toMatch(/issueAgentToken\(MAIN_AGENT_ID\)/)
  })
})
