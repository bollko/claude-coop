import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Attachment, CoopConfig, CoopEvent } from '../types'
import { isSealed, open, roomKeys, seal } from './crypto'
import type { RoomKeys } from './crypto'

const PANE = 'coop'
const USAGE =
  '/coop host <your-name> [repo-url]  |  /coop avatar <github-username|none>  |  /coop join <server-url> <room> <secret> <your-name> [repo-url]  |  /coop repo <url|none>  |  /coop ship  |  /coop leave  |  /coop'
const config = atom({ plugin: 'claude-coop', key: 'config' } as const, null)
const events = atom({ plugin: 'claude-coop', key: 'events' } as const, [])
const typing = atom({ plugin: 'claude-coop', key: 'typing' } as const, [])
// How many room events this session's Claude has already been given as context.
const fed = atom({ plugin: 'claude-coop', key: 'fed' } as const, 0)
const sent = atom({ plugin: 'claude-coop', key: 'sent' } as const, 0)
// The room's repo as this folder stands with it, and who holds the edit lock.
const workspace = atom({ plugin: 'claude-coop', key: 'workspace' } as const, null)
const lock = atom({ plugin: 'claude-coop', key: 'lock' } as const, null)
// Everyone's picture by name, opened from the relay's sealed copies.
const pictures = atom({ plugin: 'claude-coop', key: 'pictures' } as const, {})
// While hosting: the join line to hand friends, or what hosting is doing now.
const invite = atom({ plugin: 'claude-coop', key: 'invite' } as const, null)
// Screenshots and files waiting to go with the next pane message.
const shots = atom({ plugin: 'claude-coop', key: 'shots' } as const, [])

// A pane field takes no pasted images, so the button reads the clipboard through the OS.
// Each grab prints the full PNG's path, then a preview: the image shrunk to fit 48x36 pixels,
// each pixel 3 hex digits (4 bits a channel), as `pxg:<w>:<h>:<pixels>`.
const PS_GRAB =
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i = [Windows.Forms.Clipboard]::GetImage(); if (-not $i) { exit 3 }; ' +
  "$p = Join-Path $env:TEMP ('coop-shot-' + [guid]::NewGuid() + '.png'); $i.Save($p, [Drawing.Imaging.ImageFormat]::Png); $p; " +
  '$k = [Math]::Min([Math]::Min(48 / $i.Width, 36 / $i.Height), 1); $w = [Math]::Max(1, [int]($i.Width * $k)); $h = [Math]::Max(1, [int]($i.Height * $k)); ' +
  "$t = New-Object Drawing.Bitmap $w, $h; $g = [Drawing.Graphics]::FromImage($t); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($i, 0, 0, $w, $h); " +
  '$b = New-Object Text.StringBuilder; [void]$b.Append("pxg:${w}:${h}:"); ' +
  'for ($y = 0; $y -lt $h; $y++) { for ($x = 0; $x -lt $w; $x++) { $c = $t.GetPixel($x, $y); ' +
  "[void]$b.AppendFormat('{0:x}{1:x}{2:x}', [int][Math]::Floor($c.R / 16), [int][Math]::Floor($c.G / 16), [int][Math]::Floor($c.B / 16)) } }; $b.ToString()"
// macOS (pngpaste or AppleScript), then Linux (wl-paste or xclip); no preview there yet. $0 is the file to write.
const SH_GRAB =
  '(command -v pngpaste >/dev/null && pngpaste "$0") || ' +
  "osascript -e 'on run a' -e 'set f to open for access (POSIX file (item 1 of a)) with write permission' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f' -e 'end run' \"$0\" 2>/dev/null || " +
  '(command -v wl-paste >/dev/null && wl-paste --type image/png > "$0") || ' +
  'xclip -selection clipboard -t image/png -o > "$0" 2>/dev/null; [ -s "$0" ] || exit 3; echo "$0"'

// The OS file picker, several files at once; prints one path per line, nothing on cancel.
const PS_PICK =
  'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form -Property @{ TopMost = $true }; ' +
  "$d = New-Object Windows.Forms.OpenFileDialog; $d.Multiselect = $true; $d.Title = 'Attach files for Claude'; " +
  "if ($d.ShowDialog($f) -eq 'OK') { $d.FileNames }"
const SH_PICK =
  "osascript -e 'set out to \"\"' -e 'repeat with f in (choose file with multiple selections allowed)' " +
  "-e 'set out to out & POSIX path of f & linefeed' -e 'end repeat' -e 'return out' 2>/dev/null || " +
  'zenity --file-selection --multiple --separator="|" 2>/dev/null'

const pickFiles = async ($: EngineInterface) => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows ? ['powershell', '-NoProfile', '-STA', '-Command', PS_PICK] : ['sh', '-c', SH_PICK]
  // Five minutes to choose.
  const res = await $.process.run(argv, { timeoutMs: 300_000 }).catch(() => undefined)

  return (res?.stdout ?? '').split(/[\r\n|]+/).map(p => p.trim()).filter(Boolean)
}

const attachFiles = async ($: EngineInterface) => {
  const paths = await pickFiles($)
  if (paths.length) await update($, shots, list => [...list, ...paths.map(path => ({ path, name: baseName(path) }))])
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

const grabScreenshot = async ($: EngineInterface): Promise<Attachment | undefined> => {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? ['powershell', '-NoProfile', '-STA', '-Command', PS_GRAB]
    : ['sh', '-c', SH_GRAB, `/tmp/coop-shot-${Date.now()}.png`]
  const res = await $.process.run(argv, { timeoutMs: 15000 }).catch(() => undefined)
  if (res?.exitCode !== 0) return undefined
  const [path, grid] = res.stdout.trim().split(/\r?\n/)
  if (!path) return undefined
  const preview = isPreview(grid?.trim()) ? grid?.trim() : undefined

  return { path, name: 'screenshot', preview }
}

const attachScreenshot = async ($: EngineInterface) => {
  const shot = await grabScreenshot($)
  if (!shot) return $.ui.toast('No image on the clipboard. Copy a screenshot first (Win+Shift+S on Windows).')
  await update($, shots, list => [...list, shot])
}

// The text your Claude gets: the message, then each attachment's path to open with Read.
export const withShots = (text: string, paths: readonly string[]) =>
  paths.length
    ? `${text}\n\nAttached (open each with the Read tool):\n${paths.map(p => `- ${p}`).join('\n')}`.trim()
    : text

// A preview: `pxg:<w>:<h>:` then w*h pixels of 3 hex digits. Peers' arrive from the relay, so only this exact form is drawn.
export const parsePreview = (src: string | undefined) => {
  const m = src?.match(/^pxg:(\d{1,2}):(\d{1,2}):([0-9a-f]+)$/)
  const w = Number(m?.[1])
  const h = Number(m?.[2])
  if (!m || w < 1 || h < 1 || w > 48 || h > 36 || m[3]!.length !== w * h * 3) return undefined

  return { w, h, px: m[3]! }
}
const isPreview = (src: string | undefined): src is string => parsePreview(src) !== undefined

// A picture is a 16x16 grid of RRGGBB pixels: the desktop's Svg drops embedded images,
// so avatars are drawn from plain squares. Peers' grids go into markup only in this exact form.
export const isPicture = (src: unknown): src is string => typeof src === 'string' && /^px16:[0-9a-f]{1536}$/.test(src)

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')

// A person's avatar: their picture's pixels inside a circle, else their initial on a colour from their name.
export const avatarSvg = (name: string, picture?: string) => {
  if (isPicture(picture)) {
    const px = picture.slice(5)
    let rects = ''
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 64) continue
        rects += `<rect x="${x}" y="${y}" width="1.05" height="1.05" fill="#${px.slice((y * 16 + x) * 6, (y * 16 + x) * 6 + 6)}"/>`
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>`
  }
  // A hue from the name, turned into hex (the Svg scrub may drop colour functions such as hsl()).
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    return 255 * (0.45 - 0.2475 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
  }
  const fill = `#${hex(channel(0))}${hex(channel(8))}${hex(channel(4))}`
  const initial = (name.trim()[0] ?? '?').toUpperCase().replace(/[<>&"']/, '?')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="${fill}"/><text x="12" y="16.5" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="600" fill="#ffffff">${initial}</text></svg>`
}

// Claude's own mark, for the bubbles of Claude's answers.
const CLAUDE_AVATAR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#d97757"/><text x="12" y="17" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#fff">✳</text></svg>'

// Three dots that pulse in turn; SMIL animates only in an interactive Svg.
const TYPING_DOTS =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10">' +
  [0, 1, 2]
    .map(
      i =>
        `<circle cx="${5 + i * 10}" cy="5" r="3" fill="#999"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="${i * 0.2}s" repeatCount="indefinite"/></circle>`,
    )
    .join('') +
  '</svg>'

// A preview drawn from plain squares (the desktop's Svg drops embedded images): one per run of
// same-coloured pixels in a row, so a 48x36 grid stays far under an Svg's 131072-character source.
export const previewSvg = (src: string) => {
  const grid = parsePreview(src)
  if (!grid) return ''
  const at = (x: number, y: number) => grid.px.slice((y * grid.w + x) * 3, (y * grid.w + x) * 3 + 3)
  let rects = ''
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; ) {
      let run = 1
      while (x + run < grid.w && at(x + run, y) === at(x, y)) run++
      rects += `<rect x="${x}" y="${y}" width="${run + 0.05}" height="1.05" fill="#${at(x, y)}"/>`
      x += run
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid.w} ${grid.h}" shape-rendering="crispEdges">${rects}</svg>`
}

const roomUrl = (cfg: CoopConfig) => `${cfg.server.replace(/\/+$/, '')}/rooms/${encodeURIComponent(cfg.room)}`

type PostKind = 'prompt' | 'answer' | 'typing' | 'repo' | 'lock' | 'unlock' | 'profile'

let cachedKeys: { id: string; keys: Promise<RoomKeys> } | undefined
const keysFor = (cfg: CoopConfig) => {
  const id = `${cfg.room}\n${cfg.secret}`
  if (cachedKeys?.id !== id) cachedKeys = { id, keys: roomKeys(cfg.room, cfg.secret) }

  return cachedKeys.keys
}

const post = async ($: EngineInterface, kind: PostKind, text = '', images: string[] = []) => {
  const cfg = await read($, config)
  if (!cfg) return undefined
  const keys = await keysFor(cfg)
  // Messages (with their previews) and the repo URL travel sealed; names, typing and the lock don't.
  const body =
    kind === 'prompt' || kind === 'answer'
      ? { from: cfg.name, kind, text: await seal(keys, JSON.stringify({ text, images })) }
      : { from: cfg.name, kind, text: (kind === 'repo' || kind === 'profile') && text ? await seal(keys, text) : text }
  try {
    return await $.http.fetch(roomUrl(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coop-secret': keys.access },
      body: JSON.stringify(body),
    })
  } catch {
    $.ui.status('coop: relay unreachable')
    return undefined
  }
}

// --- Your picture: your GitHub avatar, fetched once and kept across sessions in $.store('avatarPx').

// `gh` signed in gives your avatar's URL; a username given to /coop avatar gives it too.
const githubAvatarUrl = async ($: EngineInterface, user?: string) => {
  if (user) return `https://github.com/${user}.png?size=64`
  const res = await $.process.run(['gh', 'api', 'user', '--jq', '.avatar_url'], { timeoutMs: 15_000 }).catch(() => undefined)
  const url = res?.exitCode === 0 ? res.stdout.trim() : ''

  return url.startsWith('https://') ? `${url}${url.includes('?') ? '&' : '?'}s=64` : undefined
}

// The module can't decode images, so the OS downloads the picture and shrinks it to 16x16 pixels.
// ponytail: Windows only (System.Drawing); elsewhere people keep their initial. Add a decoder if that matters.
const PS_PIXELS =
  'Add-Type -AssemblyName System.Drawing; $b = (Invoke-WebRequest -UseBasicParsing -Uri $env:COOP_URL).Content; ' +
  '$i = [Drawing.Image]::FromStream((New-Object IO.MemoryStream (,$b))); $t = New-Object Drawing.Bitmap 16, 16; ' +
  "$g = [Drawing.Graphics]::FromImage($t); $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($i, 0, 0, 16, 16); " +
  '$s = New-Object Text.StringBuilder; for ($y = 0; $y -lt 16; $y++) { for ($x = 0; $x -lt 16; $x++) { $c = $t.GetPixel($x, $y); ' +
  "[void]$s.AppendFormat('{0:x2}{1:x2}{2:x2}', $c.R, $c.G, $c.B) } }; $s.ToString()"

const downloadPicture = async ($: EngineInterface, url: string) => {
  if ((await $.env.get('OS')) !== 'Windows_NT') return undefined
  const res = await $.process
    .run(['powershell', '-NoProfile', '-Command', PS_PIXELS], { env: { COOP_URL: url }, timeoutMs: 20_000 })
    .catch(() => undefined)
  const picture = res?.exitCode === 0 ? `px16:${res.stdout.trim()}` : undefined

  return isPicture(picture) ? picture : undefined
}

const fetchPicture = async ($: EngineInterface, user?: string) => {
  const url = await githubAvatarUrl($, user)
  const picture = url && (await downloadPicture($, url))
  if (picture) await $.store.set('avatarPx', picture)

  return picture
}

// Tells the room your picture (or that you have none); the relay forgets on restart, so poll resends.
let lastProfilePost = 0
const shareProfile = async ($: EngineInterface) => {
  lastProfilePost = Date.now()
  const picture = (await $.store.get('avatarPx')) as string | undefined
  await post($, 'profile', isPicture(picture) ? picture : '')
}

// First time in a room with no picture kept: try gh quietly, then share whatever there is.
const setupProfile = async ($: EngineInterface) => {
  if (!(await $.store.get('avatarPx')) && !(await $.store.get('avatarTried'))) {
    await $.store.set('avatarTried', true)
    await fetchPicture($)
  }
  await shareProfile($)
}

// --- Hosting: this PC runs the relay, and a free localhost.run tunnel (over the ssh the OS ships) makes it public.

// The relay and tunnel children; ending their streams ends them.
let hosted: { relay: AsyncIterator<unknown>; tunnel?: AsyncIterator<unknown> } | undefined

const stopHosting = async ($: EngineInterface) => {
  const was = hosted
  hosted = undefined
  await was?.tunnel?.return?.()
  await was?.relay.return?.()
  await update($, invite, () => null)
}

// Reads a child's output until `match` finds what it waits for; undefined if the child ends first.
const readUntil = async (it: AsyncIterator<{ text: string }>, match: (out: string) => string | undefined) => {
  let out = ''
  for (;;) {
    const piece = await it.next()
    if (piece.done) return { found: undefined, out }
    out += piece.value.text
    const found = match(out)
    if (found) return { found, out }
  }
}

// Keeps reading a child that was started for the session, then says when it ends.
// The end can come as the module unloads, when its state calls fail: those are let go.
const drain = (it: AsyncIterator<unknown>, onEnd: () => Promise<unknown>) =>
  void (async () => {
    while (!(await it.next().catch(() => ({ done: true }))).done);
    await onEnd()
  })().catch(() => {})

export const tunnelUrl = (out: string) =>
  out.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i)?.[0] ??
  out.match(/https:\/\/(?!admin\.)[a-z0-9.-]+\.localhost\.run\b/i)?.[0]

// A secret nobody guesses: the room's messages are only as private as it.
const randomSecret = () =>
  [...crypto.getRandomValues(new Uint8Array(18))].map(b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')

const startHosting = async ($: EngineInterface, name: string, repo?: string) => {
  await stopHosting($)
  const room = `room-${randomSecret().slice(0, 6)}`
  const secret = randomSecret()
  await update($, invite, () => 'Starting your relay…')
  const relay = $.process.spawn({ argv: ['node', `${$.plugin.root}/relay/server.mjs`], env: { PORT: '0' } })[Symbol.asyncIterator]()
  const started = await readUntil(relay, out => out.match(/coop relay on :(\d+)/)?.[1]).catch(() => undefined)
  if (!started?.found) {
    await update($, invite, () => null)
    return $.ui.toast("coop: couldn't start the relay. /coop host needs Node.js installed (nodejs.org).")
  }
  hosted = { relay }
  drain(relay, async () => {
    if (hosted?.relay !== relay) return
    await stopHosting($)
    $.ui.toast('coop: your relay stopped.')
  })

  // You reach your own relay directly; friends come in through the tunnel.
  const cfg = { server: `http://localhost:${started.found}`, room, secret, name }
  await update($, config, () => cfg)
  await update($, events, () => [])
  await update($, fed, () => 0)
  await update($, workspace, () => null)
  if (repo) await post($, 'repo', repo)
  void setupProfile($)

  await update($, invite, () => 'Opening a public tunnel through localhost.run…')
  const tunnel = $.process
    .spawn({
      argv: [
        'ssh',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ExitOnForwardFailure=yes',
        '-T', '-R', `80:localhost:${started.found}`, 'nokey@localhost.run',
      ],
    })
    [Symbol.asyncIterator]()
  hosted.tunnel = tunnel
  const opened = await readUntil(tunnel, tunnelUrl).catch(() => undefined)
  if (!opened?.found) {
    await update($, invite, () => null)
    const why = opened?.out.trim().split('\n').at(-1) ?? 'ssh could not start'
    return $.ui.toast(`coop: the tunnel didn't open (${why}). Friends can't reach your relay; you can still use the room yourself.`)
  }
  drain(tunnel, async () => {
    if (hosted?.tunnel !== tunnel) return
    await update($, invite, () => null)
    $.ui.toast('coop: the tunnel closed, so friends lost the room. Run /coop host again for a new invite.')
  })
  await update($, invite, () => `/coop join ${opened.found} ${room} ${secret} <your-name>`)
  $.ui.toast('coop: your room is live. Copy the invite from the Co-op pane.')
}

// --- Shared workspace: the room's git repo, worked on a branch of the room's own.

const git = ($: EngineInterface, args: string[]) =>
  $.process
    .run(['git', ...args], { timeoutMs: 60_000 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))

// https://github.com/a/b.git, git@github.com:a/b and github.com/a/b all name one repo.
export const sameRepo = (a: string, b: string) => {
  const norm = (url: string) =>
    url
      .trim()
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, '')
      .replace(/^[^@/]+@/, '')
      .replace(':', '/')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '')

  return norm(a) === norm(b)
}

export const branchFor = (room: string) => `coop/${room}`

// Puts this session's folder on the room branch, if the folder is a clone of the room's repo.
const setupWorkspace = async ($: EngineInterface, repo: string, room: string) => {
  const branch = branchFor(room)
  const set = (ok: boolean, note: string) => update($, workspace, () => ({ repo, ok, note }))
  const origin = await git($, ['remote', 'get-url', 'origin'])
  if (origin.exitCode !== 0) return set(false, `This folder isn't a git repo. Clone ${repo} and open Claude in it.`)
  if (!sameRepo(origin.stdout, repo)) return set(false, `This folder is a clone of ${origin.stdout.trim()}, not ${repo}.`)
  await git($, ['fetch', 'origin'])
  const current = (await git($, ['branch', '--show-current'])).stdout.trim()
  if (current !== branch) {
    const hasLocal = (await git($, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0
    const hasRemote = (await git($, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).exitCode === 0
    const args = hasLocal ? ['switch', branch] : hasRemote ? ['switch', '--track', `origin/${branch}`] : ['switch', '-c', branch]
    const res = await git($, args)
    if (res.exitCode !== 0) return set(false, `Couldn't switch to ${branch}: ${res.stderr.trim().split('\n')[0]}`)
    if (!hasLocal && !hasRemote) await git($, ['push', '-u', 'origin', branch])
  }

  return set(true, `Shared files on ${branch}`)
}

// Follows the room's repo: set up when it appears or changes, forgotten when it is cleared.
let isSyncing = false
const syncWorkspace = async ($: EngineInterface, repo: string | null, room: string) => {
  const ws = await read($, workspace)
  if (isSyncing || (ws?.repo ?? null) === repo) return
  isSyncing = true
  try {
    if (repo) await setupWorkspace($, repo, room)
    else await update($, workspace, () => null)
  } finally {
    isSyncing = false
  }
}

// The edit lock this session holds, so the turn's end knows to commit and release it.
let holding: { prompt: string; at: number } | undefined
let lastLockAt = 0

// Before a turn: take the edit lock and pull peers' changes. Returns why not, when a peer holds it.
const beginTurn = async ($: EngineInterface, prompt: string) => {
  const ws = await read($, workspace)
  const cfg = await read($, config)
  if (!ws?.ok || !cfg) return undefined
  const res = await post($, 'lock')
  if (res?.status === 409) {
    const holder = (JSON.parse(res.text) as { holder?: string }).holder ?? 'Someone'
    return `${holder}'s Claude is editing the shared files. Send again when it finishes.`
  }
  // A turn of ours is already under way (or this is the desktop host's twin of its prompt): no pull mid-turn.
  // ponytail: a prompt queued mid-turn has its changes committed with the next turn's.
  if (holding) return undefined
  holding = { prompt, at: Date.now() }
  lastLockAt = Date.now()
  const pulled = await git($, ['pull', '--rebase', '--autostash', 'origin', branchFor(cfg.room)])
  if (pulled.exitCode !== 0) $.ui.toast(`coop: couldn't pull peers' changes: ${pulled.stderr.trim().split('\n')[0]}`)

  return undefined
}

// After a turn: commit what changed, push it to the room branch, release the lock.
const endTurn = async ($: EngineInterface) => {
  const cfg = await read($, config)
  if (!holding || !cfg) return
  const { prompt } = holding
  holding = undefined
  const branch = branchFor(cfg.room)
  await git($, ['add', '-A'])
  const hasChanges = (await git($, ['diff', '--cached', '--quiet'])).exitCode === 1
  if (hasChanges) {
    const subject = prompt.split('\n')[0]?.slice(0, 60) || 'changes'
    await git($, ['commit', '-m', `coop(${cfg.name}): ${subject}`])
    let pushed = await git($, ['push', 'origin', branch])
    if (pushed.exitCode !== 0) {
      // A peer pushed first: replay ours on theirs, or stop and leave it to the person.
      const rebased = await git($, ['pull', '--rebase', 'origin', branch])
      if (rebased.exitCode !== 0) {
        await git($, ['rebase', '--abort'])
        $.ui.toast(`coop: your changes clash with a peer's on ${branch}. Resolve with git pull, then push.`)
      } else pushed = await git($, ['push', 'origin', branch])
    }
    if (pushed.exitCode === 0) $.ui.toast(`coop: pushed your Claude's changes to ${branch}`)
  }
  await post($, 'unlock')
}

let lastTypingPost = 0
const markTyping = ($: EngineInterface) => {
  if (Date.now() - lastTypingPost < 2000) return
  lastTypingPost = Date.now()
  void post($, 'typing')
}

// Opens the room's pictures when the relay's set changes; resends ours when the relay lacks it.
let lastProfiles = ''
const syncPictures = async ($: EngineInterface, keys: RoomKeys, profiles: Record<string, string>, me: string) => {
  if (!(me in profiles) && Date.now() - lastProfilePost > 30_000) void shareProfile($)
  const raw = JSON.stringify(profiles)
  if (raw === lastProfiles) return
  lastProfiles = raw
  const opened: Record<string, string> = {}
  for (const [name, sealed] of Object.entries(profiles)) {
    const picture = await open(keys, sealed)
    if (isPicture(picture)) opened[name] = picture
  }
  await update($, pictures, () => opened)
}

// A sealed message back to its text and previews; one that won't open says so rather than vanish.
const openEvent = async (keys: RoomKeys, m: CoopEvent): Promise<CoopEvent> => {
  if (!isSealed(m.text)) return m
  const plain = await open(keys, m.text)
  if (plain === undefined) return { ...m, text: "[couldn't decrypt: a different room secret?]" }
  const { text, images } = JSON.parse(plain) as { text: string; images?: string[] }

  return images?.length ? { ...m, text, images } : { ...m, text }
}

let isPolling = false
// ponytail: 1 s polling; switch the relay to SSE or WebSocket if the lag or request count matters.
const poll = async ($: EngineInterface) => {
  const cfg = await read($, config)
  if (!cfg || isPolling) return
  isPolling = true
  try {
    const since = (await read($, events)).length
    const keys = await keysFor(cfg)
    const res = await $.http.fetch(`${roomUrl(cfg)}?since=${since}`, { headers: { 'x-coop-secret': keys.access } })
    if (!res.ok) return $.ui.status(`coop: relay said ${res.status}`)
    $.ui.status(`coop: ${cfg.room}`)
    const body = JSON.parse(res.text) as {
      events: CoopEvent[]
      typing: string[]
      total?: number
      repo?: string | null
      lock?: string | null
      profiles?: Record<string, string>
    }
    await syncPictures($, keys, body.profiles ?? {}, cfg.name)
    const repo = body.repo && isSealed(body.repo) ? ((await open(keys, body.repo)) ?? null) : (body.repo ?? null)
    await syncWorkspace($, repo, cfg.room)
    const holder = body.lock ?? null
    if (holder !== (await read($, lock))) await update($, lock, () => holder)
    // Keep the lock alive through a long turn; the relay frees one left for 15 minutes.
    // An hour on, assume the turn's end was missed and stop holding peers off.
    if (holding && Date.now() - holding.at > 60 * 60_000) holding = undefined
    if (holding && Date.now() - lastLockAt > 5 * 60_000) {
      lastLockAt = Date.now()
      void post($, 'lock')
    }
    // Fewer events than we hold: the relay restarted and the room is new.
    if (body.total !== undefined && body.total < since) {
      await update($, events, () => [])
      await update($, fed, () => 0)
      return
    }
    if (body.events.length) {
      const opened = await Promise.all(body.events.map(m => openEvent(keys, m)))
      await update($, events, list => (list.length === since ? [...list, ...opened] : list))
    }
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
  const attached = await read($, shots)
  // A peer editing the shared files: keep the draft's attachments and say so.
  const busy = await beginTurn($, text || attached.map(a => a.name).join(', '))
  if (busy) return $.ui.toast(busy)
  await update($, sent, n => n + 1)
  await update($, shots, () => [])
  const note = await catchUp($, text)
  const name = (await read($, config))?.name ?? 'Your user'
  // The marker stays in the text for surfaces that draw no previews, and for peers' Claudes.
  const marker = attached.length ? `📎 ${attached.map(a => a.name).join(', ')}` : ''
  paneText = [text.trim(), marker].filter(Boolean).join('\n')
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
    const [verb, server, room, secret, name, repo] = e.args.trim().split(/\s+/)
    if (verb === 'host') {
      // `/coop host <your-name> [repo-url]`: the words after host land in server and room.
      const [hostName, hostRepo] = [server, room]
      if (!hostName) return { text: `Usage: /coop host <your-name> [repo-url]` }
      // Setting up takes a while (the tunnel especially), so it runs on after this answer.
      void startHosting($, hostName, hostRepo)
      await $.ui.open({ id: PANE, title: 'Co-op: hosting' })

      return { text: 'Starting your relay and a free public tunnel. The invite to send friends appears in the Co-op pane.' }
    }
    if (verb === 'leave') {
      await stopHosting($)
      await $.store.delete('config')
      await update($, config, () => null)
      await update($, events, () => [])
      await update($, typing, () => [])
      await update($, fed, () => 0)
      await update($, workspace, () => null)
      await update($, lock, () => null)
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
      await update($, workspace, () => null)
      // Joining with a repo sets the room's; the next poll puts this folder on its branch.
      if (repo) await post($, 'repo', repo)
      void setupProfile($)
      await $.ui.open({ id: PANE, title: `Co-op: ${room}` })

      return { text: `Joined co-op room ${room} as ${name}.${repo ? ` Shared repo: ${repo}` : ''}` }
    }
    const cfg = await read($, config)
    if (!cfg) return { text: `Not in a room. ${USAGE}` }
    if (verb === 'avatar') {
      // `/coop avatar <github-username>` uses that account's picture; `none` goes back to initials.
      const user = server
      if (user === 'none') {
        await $.store.delete('avatarPx')
        await shareProfile($)

        return { text: 'Avatar cleared: your initial shows instead.' }
      }
      if (user && !/^[A-Za-z0-9-]{1,39}$/.test(user)) return { text: 'Usage: /coop avatar <github-username> | none' }
      const picture = await fetchPicture($, user)
      if (!picture) {
        return { text: user ? `Couldn't download ${user}'s GitHub picture.` : 'No GitHub sign-in found (gh). Try /coop avatar <github-username>.' }
      }
      await shareProfile($)

      return { text: 'Avatar set: the room now shows your GitHub picture.' }
    }
    if (verb === 'repo') {
      // `/coop repo <url>` sets the room's shared repo; `/coop repo none` clears it.
      const url = server && server !== 'none' ? server : ''
      await post($, 'repo', url)

      return { text: url ? `Room repo set to ${url}. Everyone's folder moves to ${branchFor(cfg.room)}.` : 'Room repo cleared.' }
    }
    if (verb === 'ship') {
      const ws = await read($, workspace)
      if (!ws?.ok) return { text: `No shared repo to ship from. ${ws?.note ?? 'Set one with /coop repo <url>.'}` }
      // Your Claude finds and runs the project's tests; only a green run becomes a pull request.
      await $.prompt.submit({
        text: `Ship the co-op room's work: run this project's tests on branch ${branchFor(cfg.room)}. If they pass, open a pull request from ${branchFor(cfg.room)} into the default branch with gh pr create, summarising the room's changes. If any fail, report them and do not open a pull request.`,
      })

      return { text: 'Asked your Claude to test the room branch and open a pull request if the tests pass.' }
    }
    await $.ui.open({ id: PANE, title: `Co-op: ${cfg.room}` })

    return { text: `Co-op pane opened for room ${cfg.room}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !(await read($, config))) return next(e)
    const busy = await beginTurn($, e.text)
    if (busy) return { drop: busy }
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
    if (e.agentId) return result
    if (e.reason === 'answer' && e.answer) await post($, 'answer', e.answer)
    // Whatever the turn changed goes to the room branch, interrupted or not.
    await endTurn($)

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
    // Attachments alone are worth sending; an empty field alone is not.
    else if (e.value.trim() || (await read($, shots)).length) await sendFromPane($, e.value)

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'attach' }, async ($, e) => {
    await attachFiles($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'paste' }, async ($, e) => {
    await attachScreenshot($)

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'copy-invite' }, async ($, e) => {
    const line = await read($, invite)
    if (line?.startsWith('/coop join')) {
      const copied = await $.ui.copy({ text: line, surface: e.surface })
      $.ui.toast(copied.isCopied ? 'Invite copied. Send it to your friends.' : "Couldn't copy; select the invite text instead.")
    }

    return { element: e.element }
  })

  on('ui.press', { plugin: 'claude-coop', element: 'clear-shots' }, async ($, e) => {
    await update($, shots, () => [])

    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = await read($, config)
    if (!cfg) {
      const starting = await read($, invite)

      return <Text dimColor>{starting ?? `Not in a room. ${USAGE}`}</Text>
    }
    const list = await read($, events)
    const who = await read($, typing)
    const pics = await read($, pictures)
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
            <Svg
              alt="screenshot"
              width={width}
              height={Math.round((width * (parsePreview(src)?.h ?? 3)) / (parsePreview(src)?.w ?? 4))}
              isInteractive
              source={previewSvg(src)}
            />
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
            <Button key="attach" label="📄 Attach files" onPress={() => {}} />
            {attached.length > 0 && (
              <Button key="clear-shots" plain label={`${attached.map(a => a.name).join(', ')} ✕`} onPress={() => {}} />
            )}
          </Box>
        </Box>
      )

    const ws = await read($, workspace)
    const holder = await read($, lock)
    const hosting = await read($, invite)

    return (
      <Box flexDirection="column" gap={1}>
        {hosting && (
          <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
            {hosting.startsWith('/coop join') ? (
              <>
                <Text bold>You're hosting. Send friends this, with their own name at the end:</Text>
                <Text>{hosting}</Text>
                <Button key="copy-invite" label="Copy invite" onPress={() => {}} />
              </>
            ) : (
              <Text dimColor>{hosting}</Text>
            )}
          </Box>
        )}
        {ws && (
          <Text dimColor={ws.ok} color={ws.ok ? undefined : 'yellow'}>
            📁 {ws.repo} · {ws.note}
          </Text>
        )}
        {holder && (
          <Text color="yellow">🔒 {holder === cfg.name ? 'Your' : `${holder}'s`} Claude is editing the shared files</Text>
        )}
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
              <Box flexDirection="row" alignItems="center" gap={1}>
                {Svg && (
                  <Svg alt="avatar" width={18} height={18} isInteractive source={m.kind === 'prompt' ? avatarSvg(m.from, pics[m.from]) : CLAUDE_AVATAR} />
                )}
                <Text bold color={isMine ? 'green' : 'blue'}>
                  {label}
                </Text>
              </Box>
              <Text>{m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text}</Text>
              {m.images?.length ? previews(m.images, 240) : null}
            </Box>
          )
        })}
        {who.length > 0 &&
          (Svg ? (
            <Box flexDirection="row" alignItems="center" gap={1}>
              {who.map(name => (
                <Svg alt={name} width={18} height={18} isInteractive source={avatarSvg(name, pics[name])} />
              ))}
              <Text dimColor italic>
                {who.join(', ')} {who.length > 1 ? 'are' : 'is'} typing
              </Text>
              <Svg alt="…" width={24} height={8} isInteractive source={TYPING_DOTS} />
            </Box>
          ) : (
            <Text dimColor italic>
              ●●● {who.join(', ')} {who.length > 1 ? 'are' : 'is'} typing...
            </Text>
          ))}
        {box}
      </Box>
    )
  })
}
