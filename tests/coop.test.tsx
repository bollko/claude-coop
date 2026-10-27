import { expect, mock, test } from 'claude-code/testing'

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
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'POST') posts.push(e.init.body ?? '')
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
  await pane.input({ key: 'ask', text: 'hello from the pane' })
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
})
