import type http from 'node:http'

// Shared shape every route handler in this folder consumes. The dispatcher in
// src/web.ts builds it once per request and walks each module's tryHandle*
// function. A handler returns true once it has written a response, false to
// let the next module try.
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  // S4.1b: the agent identity proven by a per-agent bearer token, resolved
  // ONCE in the gate (src/web.ts) and only for POST /api/messages -- the one
  // route that accepts a per-agent token. null everywhere else, and null when
  // the request authenticated with the human DASHBOARD_TOKEN instead. Route
  // handlers must treat null as "no proven agent identity" and never fall
  // back to a client-asserted `from`.
  authenticatedAgent?: string | null
}

export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
