import { MAIN_AGENT_ID } from '../config.js'
import { CHAT_SYSTEM_AGENTS } from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import { DASHBOARD_SENDER_ID } from './routes/messages.js'
import { sanitizeAgentName } from './sanitize.js'

// Identities the server assigns to itself. None of them may become a real
// agent directory, because several trust decisions key off "is this a known
// agent" or off the id being unforgeable:
//
//   - DASHBOARD_SENDER_ID: the sentinel every dashboard-token-only message is
//     attributed to. Its whole security value is that isKnownAgent() is false
//     for it, so the router can never frame it as a trusted peer. Creating an
//     agent by that name would flip isKnownAgent() to true and make operator
//     messages trusted-eligible.
//   - MAIN_AGENT_ID: the implicit peer of every agent (team-trust rule 4).
//   - COORDINATOR_AGENT_ID: grants channel-inbound (reply-expected) framing.
//   - CHAT_SYSTEM_AGENTS: system participants excluded from the chat sidebar
//     (heartbeat / channel-coordinator / system).
//
// MAIN_AGENT_ID is read from config at import time rather than hardcoded, so
// a non-"marveen" install reserves its own main-agent id.
export function reservedAgentIds(): string[] {
  return [
    DASHBOARD_SENDER_ID,
    MAIN_AGENT_ID,
    COORDINATOR_AGENT_ID,
    ...CHAT_SYSTEM_AGENTS,
  ]
}

// Compared on the SANITIZED name, because that is what the create endpoint
// actually writes to disk: "Dashboard Operator" and "dashboard-operator!" both
// sanitize to the reserved id and must be rejected the same way.
export function isReservedAgentId(rawName: string): boolean {
  const candidate = sanitizeAgentName(rawName)
  if (!candidate) return false
  return reservedAgentIds().some(id => sanitizeAgentName(id) === candidate)
}
