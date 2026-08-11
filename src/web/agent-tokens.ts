import { randomBytes, createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir } from './agent-config.js'
import { findAgentByTokenHash, getAgentTokenHash, setAgentTokenHash } from '../db.js'
import { logger } from '../logger.js'

// S4.1a: per-agent bearer token, provisioned here but NOT YET read by any
// auth path (enforcement is a separate follow-up, S4.1b). Merging this file
// changes no runtime behavior.

export const AGENT_TOKEN_FILENAME = '.agent-token'
export const MAIN_AGENT_TOKEN_FILENAME = '.main-agent-token'

// Sub-agents get a file inside their own directory. The main agent has no
// `agents/<name>/` directory -- agentDir(MAIN_AGENT_ID) is a known dead path
// (see agents-skills.ts's skillsRootFor for the same branch) -- so its token
// lives beside the dashboard token under store/ instead, not PROJECT_ROOT
// (a repo-root file risks being committed).
export function agentTokenPath(name: string): string {
  return name === MAIN_AGENT_ID
    ? join(STORE_DIR, MAIN_AGENT_TOKEN_FILENAME)
    : join(agentDir(name), AGENT_TOKEN_FILENAME)
}

// Idempotent: if the token file AND its hash row already exist, this is a
// no-op -- no silent re-issue that would swap out a token once something
// downstream (S4.1b) starts relying on it. Otherwise a fresh token is
// generated and both sides are (re)written together.
export function issueAgentToken(name: string): void {
  const path = agentTokenPath(name)
  if (existsSync(path) && getAgentTokenHash(name) !== null) return

  const token = randomBytes(32).toString('hex')
  atomicWriteFileSync(path, token, { mode: 0o600 })
  const hash = createHash('sha256').update(token).digest('hex')
  setAgentTokenHash(name, hash)
  logger.info({ name }, 'Agent token issued')
}

// S4.1b: resolve an `Authorization: Bearer <token>` header to the agent that
// owns the token, or null when the header is absent/malformed or the token is
// not a per-agent token (e.g. it is the human DASHBOARD_TOKEN).
//
// The lookup is by sha256 of the presented value against the stored hash, so
// no plaintext token is ever held server-side. Unlike checkBearerToken -- which
// compares against ONE known secret and so must be constant-time -- this is an
// indexed equality lookup over a 64-hex-char digest of a 32-byte random token:
// there is no low-entropy candidate set for a timing oracle to walk.
export function resolveAgentFromBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/.exec(header)
  if (!m) return null
  const hash = createHash('sha256').update(m[1].trim()).digest('hex')
  return findAgentByTokenHash(hash)
}
