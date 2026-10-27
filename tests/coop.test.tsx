import { expect, mock, test } from 'claude-code/testing'

import { isSealed, open, roomKeys } from '../hooks/crypto'

// What the relay was sent, opened as a room member would; raw keeps what it actually saw.
const raw: string[] = []
const opened = async (body: string, room: string, secret: string) => {
  raw.push(body)
  const ev = JSON.parse(body) as { from: string; kind: string; text: string }
  if (!isSealed(ev.text)) return body
  const plain = JSON.parse((await open(await roomKeys(room, secret), ev.text)) ?? '{}') as { text: string; images: string[] }

  return JSON.stringify(plain.images.length ? { ...ev, text: plain.text, images: plain.images } : { ...ev, text: plain.text })
}

const PANE = {
  plugin: 'claude-coop',
  component: 'Pane',
  requestId: 'coop',
  props: { title: 'Co-op', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const ROOM = {
  events: [
    { seq: 1, from: 'Euan', kind: 'prompt', text: 'add a login page', at: 1 },
    { seq: 2, from: 'Jason', kind: 'answer', text: 'Done, see login.tsx', at: 2 },
  ],
  typing: ['Jason', 'Euan'],
}

test("pane shows bubbles and who is typing; peers' turns reach your Claude once", async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const posts: string[] = []
  on('command.register', () => ({ value: { command: 'coop' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', async (_, e) => {
    if (e.init?.method === 'POST') posts.push(await opened(e.init.body ?? '', 'room', 's3cret'))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.init?.method === 'POST' ? {} : ROOM) } }
  })
  let context: readonly string[] | undefined
  let submitted = ''
  on('prompt.submit', (_, e) => ((context = e.context), (submitted = e.text), { text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const promptPosts = (text: string) => posts.filter(p => p.includes('"kind":"prompt"') && p.includes(text))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'coop',
    args: 'join http://relay room s3cret Euan',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  await clock.advance(1100)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^You$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Jason's Claude/ })).toBeDefined()
    // Your own typing is not shown back to you.
    expect((await ui.find({ type: 'Text', text: /typing/ }))?.text).toContain('Jason is typing')
    await ui.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.input({ key: 'ask-0', text: 'hello from the pane' })
  expect(submitted).toContain('hello from the pane')
  expect(submitted).toContain("Jason's Claude answered:\nDone, see login.tsx")
  expect(submitted).not.toContain('add a login page')
  await $.turn.start({ text: submitted, turnId: 't1' })
  // The room gets the clean text, not the catch-up note ahead of it.
  expect(promptPosts('hello from the pane')).toEqual([JSON.stringify({ from: 'Euan', kind: 'prompt', text: 'hello from the pane' })])
  await pane.unmount()

  // The desktop host can raise one prompt twice; the room still hears it once.
  await $.prompt.submit({ text: 'now add logout', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'now add logout', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'now add logout', turnId: 't2' })
  // The pane send already caught this Claude up.
  expect(context).toBeUndefined()
  expect(promptPosts('now add logout')).toHaveLength(1)
  // The relay itself only ever saw ciphertext.
  expect(raw.some(body => body.includes('hello from the pane') || body.includes('now add logout'))).toBe(false)
})

test('a large room update reaches your Claude condensed by Haiku', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const big = { seq: 1, from: 'Jason', kind: 'answer', text: 'x'.repeat(6000), at: 1 }
  on('command.register', () => ({ value: { command: 'coop' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', (_, e) => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.init?.method === 'POST' ? {} : { events: [big], typing: [] }) },
  }))
  let asked = ''
  on('model.complete', (_, e) => {
    asked = e.model
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

    return { value: { isAnswered: true as const, text: '- Jason rewrote auth.ts', usage } }
  })
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => (contexts.push(e.context), { text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coop', args: 'join http://relay room s Euan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.advance(1100)
  // The same prompt twice, as the desktop host sends it: both get the summary.
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })

  expect(asked).toBe('haiku')
  for (const context of contexts) {
    expect(context?.join()).toContain('- Jason rewrote auth.ts')
    expect(context?.join()).not.toContain('xxxx')
  }
})

test('screenshots and picked files go to your Claude as paths, and the room hears their names', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const posts: string[] = []
  on('command.register', () => ({ value: { command: 'coop' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'Windows_NT' }))
  const shot = 'C:/Temp/coop-shot-1.png'
  const picked = ['C:/Work/notes.txt', 'C:/Work/log.csv']
  // The file picker answers two files; the clipboard grab answers a screenshot and its preview.
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.join(' ').includes('OpenFileDialog') ? picked.join('\r\n') : `${shot}\r\n/9j/4AAQ\r\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('http.fetch', async (_, e) => {
    if (e.init?.method === 'POST') posts.push(await opened(e.init.body ?? '', 'room', 's'))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.init?.method === 'POST' ? {} : { events: [], typing: [] }) } }
  })
  let submitted = ''
  on('prompt.submit', (_, e) => ((submitted = e.text), { text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coop', args: 'join http://relay room s Euan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.advance(1100)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'paste' })
  expect(await pane.find({ type: 'Button', text: /screenshot ✕/ })).toBeDefined()
  // The preview shows in the composer before sending.
  expect(await pane.find({ type: 'Svg' })).toBeDefined()
  await pane.input({ key: 'ask-0', text: 'what is wrong here?' })
  // A fresh field replaces the one that was sent from, so the text clears.
  expect(await pane.find({ key: 'ask-0' })).toBeUndefined()
  expect(await pane.find({ key: 'ask-1' })).toBeDefined()
  expect(submitted).toContain('what is wrong here?')
  expect(submitted).toContain(`- ${shot}`)
  await $.turn.start({ text: submitted, turnId: 't1' })
  const prompts = posts.map(p => JSON.parse(p) as { kind: string; text: string; images?: string[] }).filter(p => p.kind === 'prompt')
  expect(prompts.map(p => p.text)).toEqual(['what is wrong here?\n📎 screenshot'])
  expect(prompts[0]?.images).toEqual(['data:image/jpeg;base64,/9j/4AAQ'])
  // Sent once: the next message carries none.
  expect(await pane.find({ type: 'Button', text: /✕/ })).toBeUndefined()

  // Files from the picker go without any text.
  await pane.press({ key: 'attach' })
  await pane.input({ key: 'ask-1', text: '' })
  expect(submitted).toBe(`Attached (open each with the Read tool):
- ${picked[0]}
- ${picked[1]}`)
  await $.turn.start({ text: submitted, turnId: 't2' })
  expect(JSON.parse(posts.at(-1) ?? '{}').text).toBe('📎 notes.txt, log.csv')
  await pane.unmount()
})

test('with a room repo: the folder moves to the room branch, turns pull then push, a peer holding the lock waits', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const repo = 'https://github.com/team/app'
  const gitCalls: string[] = []
  let lockHolder: string | null = null
  on('command.register', () => ({ value: { command: 'coop' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const cmd = e.argv.slice(1).join(' ')
    gitCalls.push(cmd)
    const out = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'remote get-url origin') return out(0, 'git@github.com:team/app.git\n')
    if (cmd === 'branch --show-current') return out(0, 'main\n')
    if (cmd.startsWith('rev-parse')) return out(1)
    // Something changed this turn.
    if (cmd === 'diff --cached --quiet') return out(1)
    return out(0)
  })
  on('http.fetch', (_, e) => {
    const ok = (text: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(text) } })
    if (e.init?.method !== 'POST') return ok({ events: [], typing: [], total: 0, repo, lock: lockHolder })
    const body = JSON.parse(e.init.body ?? '{}') as { kind: string }
    if (body.kind === 'lock' && lockHolder && lockHolder !== 'Euan') return ok({ holder: lockHolder }, 409)
    if (body.kind === 'lock') lockHolder = 'Euan'
    if (body.kind === 'unlock') lockHolder = null
    return ok({})
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coop', args: 'join http://relay room s Euan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.advance(1100)
  expect(gitCalls).toContain('switch -c coop/room')
  expect(gitCalls).toContain('push -u origin coop/room')

  gitCalls.length = 0
  await $.prompt.submit({ text: 'add a logout button', wait: false, origin: { kind: 'composer' } })
  expect(lockHolder).toBe('Euan')
  expect(gitCalls).toEqual(['pull --rebase --autostash origin coop/room'])
  await $.turn.complete({ answer: 'Done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(gitCalls.slice(1)).toEqual([
    'add -A',
    'diff --cached --quiet',
    'commit -m coop(Euan): add a logout button',
    'push origin coop/room',
  ])
  expect(lockHolder).toBeNull()

  // Jason's Claude is editing: Euan's prompt is held back with a reason.
  lockHolder = 'Jason'
  const res = await $.prompt.submit({ text: 'rename the button', wait: false, origin: { kind: 'composer' } })
  expect(res).toEqual({ drop: "Jason's Claude is editing the shared files. Send again when it finishes." })
})

test('/coop host starts the relay and a tunnel, then offers an invite to copy', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: string[] = []
  let copied = ''
  let finish = () => {}
  const running = new Promise<void>(resolve => (finish = resolve))
  on('command.register', () => ({ value: { command: 'coop' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => ((copied = e.text), { value: { isCopied: true as const } }))
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ events: [], typing: [], total: 0 }) } }
  })
  // Both children stay up until the test ends, as real ones would.
  on('process.spawn', async function* (_, e) {
    if (e.argv[0] === 'node') yield { stream: 'stdout' as const, text: 'coop relay on :5555\n' }
    else {
      yield { stream: 'stdout' as const, text: '\r\n===\r\nabc123.lhr.life tunneled with tls termination, ' }
      yield { stream: 'stdout' as const, text: 'https://abc123.lhr.life\r\n' }
    }
    await running

    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'coop', args: 'host Euan', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await clock.advance(1100)

  // The host talks to its own relay directly.
  expect(fetched.some(url => url.startsWith('http://localhost:5555/rooms/room-'))).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await pane.find({ type: 'Text', text: /^\/coop join https:\/\/abc123\.lhr\.life room-\w+ \w{18} <your-name>$/ })
  expect(line).toBeDefined()
  await pane.press({ key: 'copy-invite' })
  expect(copied).toBe(line?.text ?? 'missing')
  await pane.unmount()
  finish()
})
