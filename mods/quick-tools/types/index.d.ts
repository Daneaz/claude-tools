export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type Status = { model: ModelKey | null; effort: Effort | null; ultracode: boolean }

declare module 'claude-code' {
  interface PluginState {
    'quick-tools': { status: Status; isOpen: boolean }
  }
}
