import { describe, it, expect } from 'vitest'
import { listProfileTemplates, type ProfileTemplate } from '../web/profiles.js'

// fix/dev-profile-deny (S4.1c): closes two gaps found in recon --
// (1) some profiles didn't deny reading secret files (.env, the store
//     tokens, other agents' .agent-token), and
// (2) developer-sandbox combined web-read (WebFetch/WebSearch, a prompt
//     injection surface) with unrestricted raw egress (Bash(curl:*)).
//
// IMPORTANT, documented residual (Ákos's decision, see profile
// `_securityNote` fields and Solvian utemterv Sec.6.1): Claude Code's
// Read()/Write()/Edit() deny rules gate the Read tool family ONLY. They do
// NOT stop a Bash-tool command (`cat`, `python3 -c "open(...)"`, etc.) from
// reading the same path -- Bash rules are matched by command-string prefix,
// not by the file the command touches. Every profile below still allows
// SOME shell (`Bash(ls:*)` at minimum; the two developer profiles allow
// `cat`/`python3`/`node` broadly). So these Read() denies are defense in
// depth, not a sandbox: a compromised agent on a shell-permitting profile
// can still exfiltrate a secret via its allowed shell tools. Real
// cross-agent secret isolation requires OS-level (Hard) isolation, which is
// deferred pre-scale. Do NOT read a green run of this suite as "secrets are
// unreadable" -- it only asserts the Read-tool deny surface is complete and
// that the documented shell residual didn't regress.

const STRICT_DRAFT_PROFILES = ['analyst-draft', 'content-draft', 'visual-production', 'distribution-velocity']
const DEVELOPER_PROFILES = ['developer-sandbox', 'developer-trusted']

function byId(id: string): ProfileTemplate {
  const p = listProfileTemplates().find(p => p.id === id)
  if (!p) throw new Error(`profile not found in templates/profiles: ${id}`)
  return p
}

function deniesEnv(p: ProfileTemplate): boolean {
  return p.filesystem.deny.includes('Read(${HOME}/.env)') && p.filesystem.deny.includes('Read(**/.env)')
}

function deniesStoreTokens(p: ProfileTemplate): boolean {
  return (
    p.filesystem.deny.includes('Read(**/store/.dashboard-token)') &&
    p.filesystem.deny.includes('Read(**/store/.main-agent-token)')
  )
}

// S4.4 (B6-SEC-4): on Linux, store/.vault-key is a plaintext file sitting
// next to the encrypted store/vault.json it protects -- one Read away from
// unlocking every vaulted secret. Same Read-tool-only, shell-bypassable
// residual as deniesStoreTokens above (see docs/vault.md's Linux posture
// section and the developer profiles' _securityNote fields).
function deniesVaultKey(p: ProfileTemplate): boolean {
  return (
    p.filesystem.deny.includes('Read(**/store/.vault-key)') &&
    p.filesystem.deny.includes('Read(**/store/vault.json)')
  )
}

// Deny-always-wins (confirmed in Step 0 recon) means a blanket
// `Read(**/.agent-token)` deny would also block an agent's own
// `${AGENT_DIR}/.agent-token`, breaking delegation. Per Ákos's decision, no
// per-sibling deny was built (Read-tool-only, shell bypasses it anyway --
// not worth the staleness complexity of enumerating siblings at write
// time). So no profile should deny anything matching `.agent-token`; this
// simultaneously proves the agent's own token stays reachable AND documents
// that a sibling's token is not Read-tool-blocked.
function deniesAnyAgentToken(p: ProfileTemplate): boolean {
  return p.filesystem.deny.some(d => d.includes('.agent-token'))
}

function allowsCat(p: ProfileTemplate): boolean {
  return p.filesystem.allow.includes('Bash(cat:*)')
}

function allowsWebRead(p: ProfileTemplate): boolean {
  // Permissive mode = allow-all-except-deny, so WebFetch/WebSearch are
  // reachable unless a deny rule says otherwise (none currently deny them).
  if (p.permissionMode === 'permissive') return true
  return p.filesystem.allow.some(a => a.startsWith('WebFetch(') || a.startsWith('WebSearch('))
}

// "Unrestricted raw egress" here means a POST (the exfiltration-shaped
// request) is not specifically blocked. A blanket `Bash(curl:*)` deny also
// counts, since that forecloses POST along with everything else.
function deniesRawPost(p: ProfileTemplate): boolean {
  return p.filesystem.deny.some(
    d => d === 'Bash(curl:*)' || /curl.*(-x\s*post|--request\s*post|-xpost)/i.test(d)
  )
}

describe('every profile: secret Read-denies', () => {
  for (const id of listProfileTemplates().map(p => p.id)) {
    it(`${id} denies .env`, () => {
      expect(deniesEnv(byId(id))).toBe(true)
    })

    it(`${id} denies the store tokens (.dashboard-token, .main-agent-token)`, () => {
      expect(deniesStoreTokens(byId(id))).toBe(true)
    })

    it(`${id} denies the vault master key and store (.vault-key, vault.json)`, () => {
      expect(deniesVaultKey(byId(id))).toBe(true)
    })

    it(`${id} never denies .agent-token (own token stays reachable; sibling-token isolation is a documented residual, not enforced here)`, () => {
      expect(deniesAnyAgentToken(byId(id))).toBe(false)
    })
  }
})

describe('strict draft/research/distribution profiles: shell-read narrowed', () => {
  for (const id of STRICT_DRAFT_PROFILES) {
    it(`${id} no longer allows Bash(cat:*) -- Read tool is the only read path, so the secret denies actually bite`, () => {
      expect(allowsCat(byId(id))).toBe(false)
    })

    it(`${id} still allows reading its own agent directory via the Read tool`, () => {
      const p = byId(id)
      expect(p.filesystem.allow).toContain('Read(${AGENT_DIR}/**)')
    })
  }
})

describe('developer profiles: broad shell kept, egress narrowed, residual documented', () => {
  for (const id of DEVELOPER_PROFILES) {
    it(`${id} keeps broad shell (cat) -- documented residual, not narrowed`, () => {
      expect(allowsCat(byId(id))).toBe(true)
    })

    it(`${id} denies raw POST (breaks the web-read + unrestricted-egress combo)`, () => {
      expect(deniesRawPost(byId(id))).toBe(true)
    })

    it(`${id} carries a security note documenting the shell-read residual`, () => {
      const note = (byId(id) as unknown as { _securityNote?: string })._securityNote
      expect(typeof note).toBe('string')
      expect(note!.length).toBeGreaterThan(0)
    })
  }

  it('developer-trusted own ${AGENT_DIR}/.agent-token stays reachable (permissive mode, nothing denies it)', () => {
    const p = byId('developer-trusted')
    expect(p.permissionMode).toBe('permissive')
    expect(deniesAnyAgentToken(p)).toBe(false)
  })
})

describe('no profile combines web-read with unrestricted raw egress', () => {
  for (const id of listProfileTemplates().map(p => p.id)) {
    it(`${id}: if it can read the web, raw POST must be blocked`, () => {
      const p = byId(id)
      if (allowsWebRead(p)) {
        expect(deniesRawPost(p)).toBe(true)
      }
    })
  }
})
