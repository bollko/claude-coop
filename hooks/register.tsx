import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CoopConfig, CoopEvent } from '../types'

const PANE = 'coop'
const USAGE = '/coop join <server-url> <room> <secret> <your-name>  |  /coop leave  |  /coop'
const config = atom({ plugin: 'claude-coop', key: 'config' } as const, null)
const events = atom({ plugin: 'claude-coop', key: 'events' } as const, [])
const typing = atom({ plugin: 'claude-coop', key: 'typing' } as const, [])
// How many room events this session's Claude has already been given as context.
const fed = atom({ plugin: 'claude-coop', key: 'fed' } as const, 0)
const sent = atom({ plugin: 'claude-coop', key: 'sent' } as const, 0)

const roomUrl = (cfg: CoopConfig) => `${cfg.server.replace(/\/+$/, '')}/rooms/${encodeURIComponent(cfg.room)}`

const post = async ($: EngineInterface, kind: 'prompt' | 'answer' | 'typing', text = '') => {
  const cfg = await read($, config)
  if (!cfg) return
  try {
    await $.http.fetch(roomUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coop-secret': cfg.secret },
      body: JSON.stringify({ from: cfg.name, kind, text }),
    })
  } catch {
    $.ui.status('coop: relay unreachable')
  }
}

let lastTypingPost = 0
const markTyping = ($: EngineInterface) => {
  if (Date.now() - lastTypingPost < 2000) return
  lastTypingPost = Date.now()
  void post($, 'typing')
}

let isPolling = false
// ponytail: 1 s polling; switch the relay to SSE or WebSocket if the lag or request count matters.
const poll = async ($: EngineInterface) => {
  const cfg = await read($, config)
  if (!cfg || isPolling) return
  isPolling = true
  try {
    const since = (await read($, events)).length
    const res = await $.http.fetch(`${roomUrl(cfg)}?since=${since}`, { headers: { 'x-coop-secret': cfg.secret } })
    if (!res.ok) return $.ui.status(`coop: relay said ${res.status}`)
    $.ui.status(`coop: ${cfg.room}`)
    const body = JSON.parse(res.text) as { events: CoopEvent[]; typing: string[] }
    if (body.events.length) await update($, events, list => (list.length === since ? [...list, ...body.events] : list))
    const who = body.typing.filter(name => name !== cfg.name)
    if (who.join() !== (await read($, typing)).join()) await update($, typing, () => who)
  } catch {
    $.ui.status('coop: relay unreachable')
  } finally {
    isPolling = false
  }
}

// What peers did since this Claude last heard, as context for the next prompt.
export const missedContext = (list: CoopEvent[], from: number, me: string, room: string) => {
  const missed = list.slice(from).filter(m => m.from !== me).slice(-40)
  if (!missed.length) return undefined
  const lines = missed.map(m =>
    m.kind === 'prompt' ? `${m.from} asked their Claude:\n${m.text}` : `${m.from}'s Claude answered:\n${m.text}`,
  )

  return `Co-op room "${room}". Your user ${me} shares this chat with peers who run their own Claude sessions. What happened in the room since your last turn:\n\n${lines.join('\n\n---\n\n')}`
}

// The desktop host can raise prompt.submit twice for one prompt, so the same
// text within a few seconds gets the same note back instead of an empty one.
let lastCatchUp = { text: '', at: 0, note: undefined as string | undefined }

// What peers did since this Claude last heard; marks it as heard.
const catchUp = async ($: EngineInterface, text: string) => {
  const cfg = await read($, config)
  if (!cfg) return undefined
  if (text === lastCatchUp.text && Date.now() - lastCatchUp.at < 5000) return lastCatchUp.note
  const list = await read($, events)
  const note = missedContext(list, await read($, fed), cfg.name, cfg.room)
  await update($, fed, () => list.length)
  lastCatchUp = { text, at: Date.now(), note }

  return note
}

// The room is told of a prompt once, at its turn's start; a pane send names its clean text here.
let paneText: string | undefined
let lastTurnId = ''

// The engine skips this plugin's own prompt.submit hook for a prompt it submits,
// so the pane puts the peers' turns ahead of the text itself.
// ponytail: inline note shows in the transcript; move it to $.session.append once this build ships it.
const sendFromPane = async ($: EngineInterface, text: string) => {
  await update($, sent, n => n + 1)
  const note = await catchUp($, text)
  const name = (await read($, config))?.name ?? 'Your user'
  paneText = text
  await $.prompt.submit(note ? { text: `${note}\n\n---\n\n${name} says:\n${text}` } : { text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'coop', description: 'Join or show a shared Claude co-op room', argumentHint: 'join <server-url> <room> <secret> <name> | leave' })
    const saved = (await $.store.get('config')) as CoopConfig | undefined
    if (saved && !(await read($, config))) await update($, config, () => saved)
    if (saved) void $.ui.open({ id: PANE, title: `Co-op: ${saved.room}` })
    $.clock.every(1000, () => void poll($))

    return next(e)
  })

  on('command.run', { command: 'coop' }, async ($, e) => {
    const [verb, server, room, secret, name] = e.args.trim().split(/\s+/)
    if (verb === 'leave') {
      await $.store.delete('config')
      await update($, config, () => null)
      await update($, events, () => [])
      await update($, typing, () => [])
      await update($, fed, () => 0)
      $.ui.status(undefined)

      return { text: 'Left the co-op room.' }
    }
    if (verb === 'join') {
      if (!server || !room || !secret || !name || !/^https?:\/\//.test(server)) return { text: `Usage: ${USAGE}` }
      const cfg = { server, room, secret, name }
      await $.store.set('config', cfg)
      await update($, config, () => cfg)
      await update($, events, () => [])
      await update($, fed, () => 0)
      await $.ui.open({ id: PANE, title: `Co-op: ${room}` })

      return { text: `Joined co-op room ${room} as ${name}.` }
    }
    const cfg = await read($, config)
    if (!cfg) return { text: `Not in a room. ${USAGE}` }
    await $.ui.open({ id: PANE, title: `Co-op: ${cfg.room}` })

    return { text: `Co-op pane opened for room ${cfg.room}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !(await read($, config))) return next(e)
    const note = await catchUp($, e.text)

    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId || !e.text || e.turnId === lastTurnId) return next(e)
    lastTurnId = e.turnId
    const text = paneText ?? e.text
    paneText = undefined
    await post($, 'prompt', text)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.reason === 'answer' && e.answer) await post($, 'answer', e.answer)

    return result
  })

  on('prompt.edit', async ($, e, next) => {
    markTyping($)

    return next(e)
  })

  // The pane's message box: typing marks you as typing, Enter sends to your Claude.
  on('ui.input', { plugin: 'claude-coop', element: 'ask' }, async ($, e, next) => {
    if (e.kind !== 'submit') markTyping($)
    else if (e.value.trim()) await sendFromPane($, e.value)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const cfg = await read($, config)
    if (!cfg) return <Text dimColor>Not in a room. {USAGE}</Text>
    const list = await read($, events)
    const who = await read($, typing)
    // Read so each send redraws the field empty.
    await read($, sent)
    // Mobile draws no Input; there the main prompt box still works.
    const { Input } = e.surface === 'mobile' ? { Input: undefined } : $.ui.resolve(e)
    const box =
      Input && (
        <Input
          key="ask"
          value=""
          placeholder="Message your Claude…"
          submitLabel="send"
          onSubmit={() => {}}
        />
      )
    const bubble = Math.max(20, Math.floor(e.props.bodyColumns * 0.8))

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>Room is empty. Send a prompt to start.</Text>}
        {list.slice(-30).map(m => {
          const isMine = m.from === cfg.name
          const owner = isMine ? 'You' : m.from
          const label = m.kind === 'prompt' ? owner : isMine ? 'Your Claude' : `${m.from}'s Claude`

          return (
            <Box
              key={`m${m.seq}`}
              flexDirection="column"
              alignSelf={isMine ? 'flex-start' : 'flex-end'}
              width={bubble}
              borderStyle="round"
              borderColor={isMine ? 'green' : 'blue'}
              paddingX={1}
            >
              <Text bold color={isMine ? 'green' : 'blue'}>{label}</Text>
              <Text>{m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text}</Text>
            </Box>
          )
        })}
        {who.length > 0 && (
          <Text dimColor italic>
            ●●● {who.join(', ')} {who.length > 1 ? 'are' : 'is'} typing...
          </Text>
        )}
        {box}
      </Box>
    )
  })
}
