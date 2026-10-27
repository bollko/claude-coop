// Claude Coop relay: rooms of chat events plus who is typing.
// Run: node relay/server.mjs   (PORT env var, default 8787)
import { createServer } from 'node:http'

const TYPING_MS = 4000
const KINDS = new Set(['prompt', 'answer', 'typing'])
// ponytail: in-memory rooms, lost on restart; add a JSON file or SQLite when rooms must persist.
const rooms = new Map()

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay')
  const name = url.pathname.match(/^\/rooms\/([\w-]{1,64})$/)?.[1]
  if (!name) return send(res, 404, { error: 'use /rooms/<room>' })

  const secret = req.headers['x-coop-secret']
  if (!secret) return send(res, 401, { error: 'missing x-coop-secret' })
  // The first person to reach a room sets its secret.
  let room = rooms.get(name)
  if (!room) rooms.set(name, (room = { secret, events: [], typing: new Map() }))
  if (secret !== room.secret) return send(res, 403, { error: 'wrong secret' })

  if (req.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0)
    const now = Date.now()
    const typing = [...room.typing].filter(([, at]) => now - at < TYPING_MS).map(([who]) => who)
    return send(res, 200, { events: room.events.slice(since), typing })
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' })
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1_000_000) return send(res, 413, { error: 'too large' })
  }
  let event
  try {
    event = JSON.parse(body)
  } catch {
    return send(res, 400, { error: 'bad JSON' })
  }
  const { from, kind, text = '' } = event
  if (typeof from !== 'string' || !from || from.length > 40 || !KINDS.has(kind) || typeof text !== 'string') {
    return send(res, 400, { error: 'need from, kind (prompt|answer|typing), text' })
  }

  if (kind === 'typing') {
    room.typing.set(from, Date.now())
    return send(res, 200, {})
  }
  room.typing.delete(from)
  room.events.push({ seq: room.events.length + 1, from, kind, text, at: Date.now() })
  send(res, 200, { seq: room.events.length })
}).listen(Number(process.env.PORT) || 8787, () => console.log(`coop relay on :${Number(process.env.PORT) || 8787}`))
