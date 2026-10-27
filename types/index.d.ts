// images: small JPEG previews as data: URIs, for drawing only.
export type CoopEvent = { seq: number; from: string; kind: 'prompt' | 'answer'; text: string; at: number; images?: string[] }
export type CoopConfig = { server: string; room: string; secret: string; name: string }
// A screenshot waiting to be sent: the full PNG your Claude reads, and its preview.
export type Shot = { path: string; preview?: string }

declare module 'claude-code' {
  interface PluginState {
    'claude-coop': {
      config: CoopConfig | null
      events: CoopEvent[]
      typing: string[]
      fed: number
      sent: number
      shots: Shot[]
    }
  }
}
