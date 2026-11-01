// diff 的一行：'+' 加、'-' 删、' ' 上下文、'~' 省略号（⋯）。
export type DiffLine = { op: '+' | '-' | ' ' | '~'; t: string }
// 回放的一步：一次 Edit / Write，或 MultiEdit 里的一处 edit。
export type Step = { tool: 'Edit' | 'Write' | 'MultiEdit'; file: string; diff: DiffLine[]; note: string }
