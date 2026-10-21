export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-rings': { usage: Usage | null; now: number }
  }
}
