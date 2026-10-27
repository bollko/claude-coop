// images: small JPEG previews as data: URIs, for drawing only.
export type CoopEvent = { seq: number; from: string; kind: 'prompt' | 'answer'; text: string; at: number; images?: string[] }
export type CoopConfig = { server: string; room: string; secret: string; name: string }
// A screenshot or file waiting to be sent: the path your Claude reads, a name for the room, a screenshot's preview.
export type Attachment = { path: string; name: string; preview?: string }

declare module 'claude-code' {
  interface PluginState {
    'claude-coop': {
      config: CoopConfig | null
      events: CoopEvent[]
      typing: string[]
      fed: number
      sent: number
      shots: Attachment[]
    }
  }
}
