// images: small pixel-grid previews (pxg:...), for drawing only. A note carries ref: the seq of the message it's on.
export type CoopEvent = {
  seq: number
  from: string
  kind: 'prompt' | 'answer' | 'note'
  text: string
  at: number
  images?: string[]
  ref?: number
}
export type CoopConfig = { server: string; room: string; secret: string; name: string }
// A screenshot or file waiting to be sent: the path your Claude reads, a name for the room, a screenshot's preview.
export type Attachment = { path: string; name: string; preview?: string }

// The room's repo and whether this session's folder is on its branch (note says why not).
export type Workspace = { repo: string; ok: boolean; note: string }

// A saved room as /coop history lists it, and one opened to read.
export type SavedRoom = { file: string; room: string; savedAt: number; count: number }
export type HistoryView = { mode: 'list'; rooms: SavedRoom[] } | { mode: 'room'; room: string; me: string; events: CoopEvent[] }

// The status line's figures: context fill, the plan's rate-limit windows, the session's cost.
export type UsageView = {
  percent?: number
  tokens?: number
  window: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'claude-coop': {
      config: CoopConfig | null
      events: CoopEvent[]
      typing: string[]
      fed: number
      sent: number
      shots: Attachment[]
      workspace: Workspace | null
      lock: string | null
      invite: string | null
      pictures: Record<string, string>
      noteFor: number | null
      history: HistoryView | null
      usage: UsageView | null
    }
  }
}
