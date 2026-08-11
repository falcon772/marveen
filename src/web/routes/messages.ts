import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  markMessageDone, markMessageFailed,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// S4.1b: the `from` a message is inserted with when the request authenticated
// with the human DASHBOARD_TOKEN rather than a per-agent token -- the dashboard
// compose UI and the heartbeat delivery script. A fixed server-side constant,
// never the body's `from`, so an operator-origin message cannot claim an agent
// identity. It is deliberately NOT a registered agent id, so isTrustedPeer's
// isKnownAgent check fails and the router always frames these as <untrusted>
// (which is exactly how they are already framed today).
export const DASHBOARD_SENDER_ID = 'dashboard-operator'

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content } = JSON.parse(body.toString()) as { from: string; to: string; content: string }
    // `from` is NO LONGER accepted from the client -- it is set server-side
    // from the authenticated identity below, so it is not a required field.
    if (!to?.trim() || !content?.trim()) {
      json(res, { error: 'to and content are required' }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // The sender is the identity proven by the per-agent token in the gate --
    // NEVER the body's `from`. Without a per-agent token the request got here
    // on the human dashboard token, so it is attributed to the fixed operator
    // sentinel. Either way the client cannot choose who it claims to be, which
    // is what closes the forged-`from` -> <trusted-peer> escalation.
    const senderId = ctx.authenticatedAgent ?? DASHBOARD_SENDER_ID
    // Warn ONLY on the authenticated path: an agent that proved one identity
    // while claiming another is a forging signal worth surfacing. The dashboard
    // UI still sends a (now ignored) `from` on every operator message, so
    // warning there would be pure noise, not a security event.
    if (ctx.authenticatedAgent && from?.trim() && from.trim() !== senderId) {
      logger.warn(
        { claimed: from.trim(), actual: senderId, to: to.trim() },
        'Ignoring client-asserted from on /api/messages (server uses the authenticated identity)',
      )
    }
    const msg = createAgentMessage(senderId, to.trim(), content.trim())
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent }, 'Agent message created')
    json(res, msg)
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  if (path === '/api/messages/threads' && method === 'GET') {
    json(res, getAgentConversationThreads())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined)
    } else {
      messages = listAgentMessages(limit)
    }

    json(res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result } = JSON.parse(body.toString()) as { status: string; result?: string }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) { json(res, { ok: true }); return true }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
