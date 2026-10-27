export type CoopEvent = { seq: number; from: string; kind: 'prompt' | 'answer'; text: string; at: number }
export type CoopConfig = { server: string; room: string; secret: string; name: string }

declare module 'claude-code' {
  interface PluginState {
    'claude-coop': {
      config: CoopConfig | null
      events: CoopEvent[]
      typing: string[]
      fed: number
      sent: number
    }
  }
}
