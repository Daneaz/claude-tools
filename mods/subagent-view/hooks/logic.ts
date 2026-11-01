// 纯逻辑：维护每个 subagent 的状态与计划，算进度、预计剩余时间、总览，以及按列宽截断。

import type { Agent, AgentState, Step, StepStatus } from '../types'

// 类型写在 types/index.d.ts（contract 须自包含），这里转出，供 register 与测试使用。
export type { Agent, AgentState, Step, StepStatus }

type EndState = Exclude<AgentState, 'running'>

// 按 agent 类型（小写）查 avatar 与短名称；加 agent 时改一行即可。
const AVATARS: Record<string, { avatar: string; name: string }> = {
  'general-purpose': { avatar: '🧰', name: 'General' },
  explore: { avatar: '🔭', name: 'Explore' },
  plan: { avatar: '🧭', name: 'Plan' },
  'claude-code-guide': { avatar: '📖', name: 'Guide' },
  'statusline-setup': { avatar: '📟', name: 'Statusline' },
  claude: { avatar: '🤖', name: 'Claude' },
  designer: { avatar: '🎨', name: 'Designer' },
  'combat-designer': { avatar: '🥊', name: 'Combat' },
  'motion-director': { avatar: '🎬', name: 'Motion' },
}

// 表里没有的类型按关键词猜，先中先得；🔒 代替带 VS16 的 🛡️，便于对齐。
const GUESSES: [keywords: string[], avatar: string][] = [
  [['review'], '🔍'],
  [['test'], '🧪'],
  [['debug'], '🐛'],
  [['doc', 'writer'], '📝'],
  [['security'], '🔒'],
  [['data'], '📊'],
]

export function avatarFor(fullType: string): { avatar: string; name: string } {
  // plugin 带的 agent 形如 `superpowers:code-reviewer`：只看最后一个 `:` 之后。
  const type = fullType.slice(fullType.lastIndexOf(':') + 1)
  const key = type.toLowerCase()
  const known = AVATARS[key]
  if (known) return known
  const avatar = GUESSES.find(([words]) => words.some(w => key.includes(w)))?.[1] ?? '🧩'
  const name = type
    .split(/[-_]/)
    .filter(Boolean)
    .map(s => s[0]!.toUpperCase() + s.slice(1))
    .join('')
  return { avatar, name: truncate(name, 10) }
}

// 只改 agentId 对应的那条；找不到时原样返回同一引用。
function updateAgent(list: Agent[], agentId: string, fn: (a: Agent) => Agent): Agent[] {
  const index = list.findIndex(a => a.agentId === agentId)
  if (index < 0) return list
  return list.map((a, i) => (i === index ? fn(a) : a))
}

function doneCount(steps: Step[]): number {
  return steps.filter(s => s.status === 'completed').length
}

export function spawnAgent(
  list: Agent[],
  a: { agentId: string; type: string; description: string; now: number },
): Agent[] {
  if (list.some(x => x.agentId === a.agentId)) return list
  return [
    ...list,
    {
      agentId: a.agentId,
      type: a.type,
      description: a.description,
      state: 'running',
      startedAt: a.now,
      steps: [],
      doneAtStart: 0,
    },
  ]
}

// 叫醒：重新计时，ETA 只看叫醒之后完成的步数。
export function resumeAgent(list: Agent[], agentId: string, now: number): Agent[] {
  return updateAgent(list, agentId, ({ endedAt: _, ...a }) => ({
    ...a,
    state: 'running',
    startedAt: now,
    doneAtStart: doneCount(a.steps),
  }))
}

export function endAgent(list: Agent[], agentId: string, state: EndState, now: number): Agent[] {
  const target = list.find(a => a.agentId === agentId)
  if (target?.state !== 'running') return list
  return updateAgent(list, agentId, a => ({ ...a, state, endedAt: now }))
}

export function endStateOf(reason: 'answer' | 'aborted' | 'refusal' | 'error'): EndState {
  if (reason === 'answer') return 'completed'
  if (reason === 'aborted') return 'killed'
  return 'failed'
}

// TodoWrite 每次给整张表：整表替换；id 带 `todo-` 前缀，不会和 TaskCreate 的 id 撞上。
export function applyTodoWrite(
  list: Agent[],
  agentId: string,
  todos: { content: string; status: StepStatus; activeForm: string }[],
): Agent[] {
  return updateAgent(list, agentId, a => ({
    ...a,
    steps: todos.map((t, i) => ({
      id: `todo-${i}`,
      title: t.content,
      activeForm: t.activeForm,
      status: t.status,
    })),
  }))
}

export function applyTaskCreate(
  list: Agent[],
  agentId: string,
  id: string,
  subject: string,
  activeForm?: string,
): Agent[] {
  const step: Step = { id, title: subject, status: 'pending' }
  if (activeForm !== undefined) step.activeForm = activeForm
  return updateAgent(list, agentId, a => ({ ...a, steps: [...a.steps, step] }))
}

// 任务列表是共享的：update 落在持有该 taskId 的 agent 上，不看是谁调的。
export function applyTaskUpdate(
  list: Agent[],
  input: { taskId: string; subject?: string; activeForm?: string; status?: StepStatus | 'deleted' },
): Agent[] {
  const owner = list.find(a => a.steps.some(s => s.id === input.taskId))
  if (!owner) return list
  const { status } = input
  return updateAgent(list, owner.agentId, a => {
    if (status === 'deleted') return { ...a, steps: a.steps.filter(s => s.id !== input.taskId) }
    return {
      ...a,
      steps: a.steps.map(s =>
        s.id !== input.taskId
          ? s
          : {
              ...s,
              ...(input.subject !== undefined ? { title: input.subject } : {}),
              ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
              ...(status !== undefined ? { status } : {}),
            },
      ),
    }
  })
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// 取这次调用最能说明意图的字段，供「没有计划」时的「最近：」一行。
export function toolHint(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Grep':
      return `"${str(input.pattern)}"`
    case 'Glob':
      return str(input.pattern)
    case 'Read':
    case 'Edit':
    case 'Write':
      return str(input.file_path).split('/').pop() ?? ''
    case 'Bash':
      return str(input.description) || truncate(str(input.command), 30)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    default:
      return ''
  }
}

// 计划类工具本身就体现在进度里，不算「最近」。
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

export function recordTool(
  list: Agent[],
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
): Agent[] {
  if (PLAN_TOOLS.has(tool)) return list
  return updateAgent(list, agentId, a => ({ ...a, lastTool: { tool, hint: toolHint(tool, input) } }))
}

export function progressOf(a: Agent): {
  total: number
  done: number
  remaining: number
  current?: { text: string; isActive: boolean }
} {
  const total = a.steps.length
  const done = doneCount(a.steps)
  const result: ReturnType<typeof progressOf> = { total, done, remaining: total - done }
  const active = a.steps.find(s => s.status === 'in_progress')
  const next = a.steps.find(s => s.status === 'pending')
  if (active) result.current = { text: active.activeForm ?? active.title, isActive: true }
  else if (next) result.current = { text: next.title, isActive: false }
  return result
}

// 按本次开跑以来的平均每步耗时外推剩余时间（ms）。
export function etaOf(a: Agent, now: number): number | 'estimating' | null {
  const { total, done, remaining } = progressOf(a)
  if (total === 0) return null
  const doneSince = done - a.doneAtStart
  if (doneSince <= 0) return 'estimating'
  return ((now - a.startedAt) / doneSince) * remaining
}

export function overviewOf(
  list: Agent[],
  now: number,
): { running: number; completed: number; failed: number; remainingSteps: number; etaMs: number | null } {
  const running = list.filter(a => a.state === 'running')
  let remainingSteps = 0
  let etaMs: number | null = null
  for (const a of running) {
    remainingSteps += progressOf(a).remaining
    const eta = etaOf(a, now)
    if (typeof eta === 'number') etaMs = Math.max(etaMs ?? 0, eta)
  }
  return {
    running: running.length,
    completed: list.filter(a => a.state === 'completed').length,
    failed: list.filter(a => a.state === 'failed' || a.state === 'killed').length,
    remainingSteps,
    etaMs,
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${pad2(totalSec % 60)}s`
  return `${Math.floor(totalSec / 3600)}h${pad2(Math.floor((totalSec % 3600) / 60))}m`
}

export function formatEta(ms: number): string {
  return ms < 60000 ? '<1m' : `${Math.round(ms / 60000)}m`
}

// 总览用：拼成「剩余时间约 6 分钟」或「剩余时间不到 1 分钟」。
export function formatEtaLong(ms: number): string {
  return ms < 60000 ? '不到 1 分钟' : `约 ${Math.round(ms / 60000)} 分钟`
}

export function ordered(list: Agent[]): { running: Agent[]; ended: Agent[] } {
  return {
    running: list.filter(a => a.state === 'running'),
    ended: list.filter(a => a.state !== 'running').sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0)),
  }
}

// 东亚全角字符与常用 emoji 占 2 列；其余按 1 列。
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  return wide ? 2 : 1
}

// 文本在终端里占的列数。
export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

// 按终端列宽截断：放得下原样返回，否则末尾补 `…`（1 列），总宽 ≤ columns。
export function truncate(text: string, columns: number): string {
  if (textWidth(text) <= columns) return text
  if (columns <= 0) return ''

  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > columns - 1) break
    out += ch
    used += w
  }
  return out + '…'
}

// 截断到 columns 列后右补空格，正好占 columns 列：用于列对齐（按显示宽度，不按字符数）。
export function fit(text: string, columns: number): string {
  const cut = truncate(text, columns)
  return cut + ' '.repeat(Math.max(0, columns - textWidth(cut)))
}
