// diff 的一行：'+' 加、'-' 删、' ' 上下文、'~' 省略号（⋯）。
export type DiffLine = { op: '+' | '-' | ' ' | '~'; t: string }
// 回放的一步：一次 Edit / Write，或 MultiEdit 里的一处 edit。
export type Step = { tool: 'Edit' | 'Write' | 'MultiEdit'; file: string; diff: DiffLine[]; note: string }

declare module 'claude-code' {
  interface PluginState {
    // index：当前步（0 起）；isOpen：回放开着；inBand：放不下 pane，回放画在 band 里。
    'replay-theater': { index: number; isOpen: boolean; inBand: boolean }
  }
}
