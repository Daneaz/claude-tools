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
  // 累计工具调用次数（被 deny 的不计）；resume 后接着累加
  toolCalls: number
  lastTool?: { tool: string; hint: string }
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-view': { agents: Shaped<Agent[]>; isOpen: boolean; frame: number }
  }
}
