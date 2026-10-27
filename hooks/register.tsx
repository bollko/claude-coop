import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CoopConfig, CoopEvent, Shot } from '../types'

const PANE = 'coop'
const USAGE = '/coop join <server-url> <room> <secret> <your-name>  |  /coop leave  |  /coop'
const config = atom({ plugin: 'claude-coop', key: 'config' } as const, null)
const events = atom({ plugin: 'claude-coop', key: 'events' } as const, [])
const typing = atom({ plugin: 'claude-coop', key: 'typing' } as const, [])
// How many room events this session's Claude has already been given as context.
const fed = atom({ plugin: 'claude-coop', key: 'fed' } as const, 0)
const sent = atom({ plugin: 'claude-coop', key: 'sent' } as const, 0)
// Screenshot files waiting to go with the next pane message.
const shots = atom({ plugin: 'claude-coop', key: 'shots' } as const, [])

// A pane field takes no pasted images, so the button reads the clipboard through the OS.
// Each grab prints the full PNG's path, then a small JPEG preview as base64.
const PS_GRAB =
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i = [Windows.Forms.Clipboard]::GetImage(); if (-not $i) { exit 3 }; ' +
  "$p = Join-Path $env:TEMP ('coop-shot-' + [guid]::NewGuid() + '.png'); $i.Save($p, [Drawing.Imaging.ImageFormat]::Png); $p; " +
  '$w = [Math]::Min(480, $i.Width); $t = New-Object Drawing.Bitmap $i, $w, ([int]($i.Height * $w / $i.Width)); ' +
  '$m = New-Object IO.MemoryStream; $t.Save($m, [Drawing.Imaging.ImageFormat]::Jpeg); [Convert]::ToBase64String($m.ToArray())'
// macOS (pngpaste or AppleScript, sips for the preview), then Linux (wl-paste or xclip, no preview); $0 is the file to write.
const SH_GRAB =
  '(command -v pngpaste >/dev/null && pngpaste "$0") || ' +
  "osascript -e 'on run a' -e 'set f to open for access (POSIX file (item 1 of a)) with write permission' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f' -e 'end run' \"$0\" 2>/dev/null || " +
  '(command -v wl-paste >/dev/null && wl-paste --type image/png > "$0") || ' +
  'xclip -selection clipboard -t image/png -o > "$0" 2>/dev/null; [ -s "$0" ] || exit 3; echo "$0"; ' +
  'command -v sips >/dev/null && sips -s format jpeg -Z 480 "$0" --out "$0.jpg" >/dev/null && base64 < "$0.jpg" | tr -d "\\n"'

const grabScreenshot = async ($: EngineInterface): Promise<Shot | undefined> => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-STA', '-Command', PS_GRAB]
    : ['sh', '-c', SH_GRAB, `/tmp/coop-shot-${Date.now()}.png`]
  const res = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => undefined)
  if (res?.exitCode !== 0) return undefined
  const [path, base64] = res.stdout.trim().split(/\r?\n/)
  if (!path) return undefined
  // ponytail: previews over ~90 KB are dropped to fit an Svg's 131072-character source.
  const preview = base64 && base64.length < 90_000 ? `data:image/jpeg;base64,${base64.trim()}` : undefined

  return { path, preview }
}

const attachScreenshot = async ($: EngineInterface) => {
  const shot = await grabScreenshot($)
  if (!shot) return $.ui.toast('No image on the clipboard. Copy a screenshot first (Win+Shift+S on Windows).')
  await update($, shots, list => [...list, shot])
}

// The text your Claude gets: the message, then each screenshot's path to open with Read.
export const withShots = (text: string, paths: readonly string[]) =>
  paths.length ? `${text}\n\nScreenshots attached (open each with the Read tool):\n${paths.map(p => `- ${p}`).join('\n')}` : text

// Peers' previews arrive from the relay: only a plain base64 JPEG goes into the SVG markup.
const isPreview = (src: string | undefined): src is string =>
  !!src && src.length < 120_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(src)

// A preview as an SVG image, letterboxed into a fixed 480x300 box.
const previewSvg = (src: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><image href="${src}" width="480" height="300" preserveAspectRatio="xMidYMid meet"/></svg>`

const roomUrl = (cfg: CoopConfig) => `${cfg.server.replace(/\/+$/, '')}/rooms/${encodeURIComponent(cfg.room)}`

const post = async ($: EngineInterface, kind: 'prompt' | 'answer' | 'typing', text = '', images: string[] = []) => {
  const cfg = await read($, config)
  if (!cfg) return
  try {
    await $.http.fetch(roomUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coop-secret': cfg.secret },
      body: JSON.stringify(images.length ? { from: cfg.name, kind, text, images } : { from: cfg.name, kind, text }),
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

// Updates over this many characters are condensed by Haiku before your Claude reads them.
const SUMMARY_OVER = 4000
const SUMMARY_RULES =
  "You condense a log of what other people's Claude Code sessions did in a shared co-op room, for another Claude working on the same project. Keep who asked for what, which files changed and how, decisions, commands, errors, open questions, and exact names and paths. Drop pleasantries and repetition. Plain bullet points, under 250 words."

const condense = async ($: EngineInterface, note: string, room: string) => {
  if (note.length <= SUMMARY_OVER) return note
  // A refused request rejects; fall through to the cut note rather than lose the update.
  const res = await $.model
    .complete({ model: 'haiku', system: SUMMARY_RULES, prompt: note, maxTokens: 800, timeoutMs: 20000 })
    .catch(() => undefined)
  if (res?.isAnswered && res.text.trim()) {
    return `Co-op room "${room}": what peers' Claude sessions did since your last turn, condensed:\n\n${res.text.trim()}`
  }

  return `${note.slice(0, SUMMARY_OVER)}\n\n…(room update cut short)`
}

// The desktop host can raise prompt.submit twice for one prompt, so the same
// text within a few seconds gets the same note back instead of an empty one.
// The promise is cached before any await, so a twin arriving mid-summary waits on it.
let lastCatchUp = { text: '', at: 0, note: Promise.resolve(undefined as string | undefined) }

// What peers did since this Claude last heard; marks it as heard.
const catchUp = ($: EngineInterface, text: string) => {
  if (text === lastCatchUp.text && Date.now() - lastCatchUp.at < 5000) return lastCatchUp.note
  const note = (async () => {
    const cfg = await read($, config)
    if (!cfg) return undefined
    const list = await read($, events)
    const raw = missedContext(list, await read($, fed), cfg.name, cfg.room)
    await update($, fed, () => list.length)

    return raw && (await condense($, raw, cfg.room))
  })()
  lastCatchUp = { text, at: Date.now(), note }

  return note
}

// The room is told of a prompt once, at its turn's start; a pane send names its clean text and previews here.
let paneText: string | undefined
let paneImages: string[] = []
let lastTurnId = ''

// The engine skips this plugin's own prompt.submit hook for a prompt it submits,
// so the pane puts the peers' turns ahead of the text itself.
// ponytail: inline note shows in the transcript; move it to $.session.append once this build ships it.
const sendFromPane = async ($: EngineInterface, text: string) => {
  await update($, sent, n => n + 1)
  const attached = await read($, shots)
  await update($, shots, () => [])
  const note = await catchUp($, text)
  const name = (await read($, config))?.name ?? 'Your user'
  // The marker stays in the text for surfaces that draw no previews, and for peers' Claudes.
  const n = attached.length
  paneText = n ? `${text}\n📎 ${n} screenshot${n > 1 ? 's' : ''}` : text
  paneImages = attached.flatMap(s => (s.preview ? [s.preview] : []))
  const full = withShots(text, attached.map(s => s.path))
  await $.prompt.submit(note ? { text: `${note}\n\n---\n\n${name} says:\n${full}` } : { text: full, asUser: true })
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
    const images = paneImages
    paneText = undefined
    paneImages = []
    await post($, 'prompt', text, images)

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
  // These hooks answer for themselves: their writes redraw the pane, which drops
  // the element's own (empty) handler, so passing on to it would throw.
  on('ui.input', { plugin: 'claude-coop', element: /^ask-/ }, async ($, e) => {
    if (e.kind !== 'submit') markTyping($)
    else if (e.value.trim()) await sendFromPane($, e.value)

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'paste' }, async ($, e) => {
    await attachScreenshot($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'clear-shots' }, async ($, e) => {
    await update($, shots, () => [])

    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = await read($, config)
    if (!cfg) return <Text dimColor>Not in a room. {USAGE}</Text>
    const list = await read($, events)
    const who = await read($, typing)
    // A new key per send draws a fresh, empty field; the same key keeps what was typed.
    const field = `ask-${await read($, sent)}`
    // Mobile draws no Input; there the main prompt box still works.
    const { Input } = e.surface === 'mobile' ? { Input: undefined } : $.ui.resolve(e)
    // The terminal draws no Svg; there the 📎 line in the text stands in.
    const { Svg } = e.surface === 'terminal' ? { Svg: undefined } : $.ui.resolve(e)
    const previews = (images: readonly (string | undefined)[], width: number) =>
      Svg && (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {images.filter(isPreview).map(src => (
            <Svg alt="screenshot" width={width} source={previewSvg(src)} />
          ))}
        </Box>
      )
    const bubble = Math.max(20, Math.floor(e.props.bodyColumns * 0.8))
    const attached = await read($, shots)
    // Centred and as wide as a bubble, like Claude's own prompt box.
    const box =
      Input && (
        <Box flexDirection="column" alignSelf="center" width={bubble} borderStyle="round" borderDimColor paddingX={1}>
          {attached.length > 0 && previews(attached.map(s => s.preview), 120)}
          <Input key={field} value="" rows={3} placeholder="Message your Claude…" submitLabel="send" onSubmit={() => {}} />
          <Box flexDirection="row" gap={1}>
            <Button key="paste" label="📎 Paste screenshot" onPress={() => {}} />
            {attached.length > 0 && (
              <Button key="clear-shots" plain label={`${attached.length} attached ✕`} onPress={() => {}} />
            )}
          </Box>
        </Box>
      )

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
              {m.images?.length ? previews(m.images, 240) : null}
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
