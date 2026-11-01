export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { id: string; title: string; activeForm?: string; status: StepStatus }
export type AgentState = 'running' | 'completed' | 'failed' | 'killed'
export type Agent = {
  agentId: string
  // subagentType
  type: string
  description: string
  state: AgentState
  // ms；resume 时重置
  startedAt: number
  endedAt?: number
  steps: Step[]
  // startedAt 那一刻已完成的步数（新派 0，resume 时 = 当时完成数）
  doneAtStart: number
  lastTool?: { tool: string; hint: string }
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-view': { agents: Shaped<Agent[]>; isOpen: boolean; frame: number }
  }
}
