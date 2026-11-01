export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export type Task = { id: string; title: string; activeForm?: string; status: TaskStatus }
// 空数组 = 无计划
export type Plan = { tasks: Task[] }
export type Subagent = { agentId: string; description: string }
export type Summary = {
  total: number
  done: number
  // pending 数
  remaining: number
  // 1 起；第一个进行中的序号，无进行中时为第一个 pending 的序号，全完成时 = total
  position: number
  // 对应 position 的任务标题
  title: string
  // 其余进行中的数量（+N）
  extraRunning: number
  // total > 0 且全部 completed
  isFinished: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { plan: Plan; subagents: Subagent[]; isOpen: boolean; frame: number }
  }
}
