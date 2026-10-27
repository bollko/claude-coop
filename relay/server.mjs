// Claude Coop relay: rooms of chat events, who is typing, the room's repo and its edit lock.
// Run: node relay/server.mjs   (PORT env var, default 8787)
import { createServer } from 'node:http'

const TYPING_MS = 4000
// A Claude editing the shared files holds the lock; one that vanishes loses it after this.
const LOCK_MS = 15 * 60_000
const KINDS = new Set(['prompt', 'answer', 'typing', 'repo', 'lock', 'unlock'])
// ponytail: in-memory rooms, lost on restart; add a JSON file or SQLite when rooms must persist.
const rooms = new Map()

const isPreview = src => typeof src === 'string' && src.length < 120_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src)

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
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
    const lock = room.lock && now - room.lock.at < LOCK_MS ? room.lock.holder : null
    // total lets a client notice the relay restarted under it and start over.
    return send(res, 200, { events: room.events.slice(since), typing, total: room.events.length, repo: room.repo ?? null, lock })
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
  const { from, kind, text = '', images = [] } = event
  if (typeof from !== 'string' || !from || from.length > 40 || !KINDS.has(kind) || typeof text !== 'string') {
    return send(res, 400, { error: `need from, kind (${[...KINDS].join('|')}), text` })
  }
  // Screenshot previews: up to 4 small base64 JPEGs.
  if (!Array.isArray(images) || images.length > 4 || !images.every(isPreview)) {
    return send(res, 400, { error: 'images must be up to 4 data:image/jpeg;base64 previews' })
  }

  if (kind === 'typing') {
    room.typing.set(from, Date.now())
    return send(res, 200, {})
  }
  // The room's shared workspace: a git URL everyone works from.
  if (kind === 'repo') {
    if (text.length > 4000) return send(res, 400, { error: 'repo URL too long' })
    room.repo = text || undefined
    return send(res, 200, {})
  }
  // Taking the lock again (to keep it) is fine; taking someone else's live lock is not.
  if (kind === 'lock') {
    const held = room.lock && Date.now() - room.lock.at < LOCK_MS && room.lock.holder !== from
    if (held) return send(res, 409, { holder: room.lock.holder })
    room.lock = { holder: from, at: Date.now() }
    return send(res, 200, {})
  }
  if (kind === 'unlock') {
    if (room.lock?.holder === from) room.lock = undefined
    return send(res, 200, {})
  }
  room.typing.delete(from)
  room.events.push({ seq: room.events.length + 1, from, kind, text, at: Date.now(), ...(images.length && { images }) })
  send(res, 200, { seq: room.events.length })
})
// PORT=0 picks a free port; the line printed names the one taken (`/coop host` reads it).
server.listen(process.env.PORT === undefined ? 8787 : Number(process.env.PORT), () =>
  console.log(`coop relay on :${server.address().port}`),
)

