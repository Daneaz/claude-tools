// 纯逻辑：维护每个 subagent 的状态、最近工具与调用次数，算总览、工作条，以及按列宽截断。

import type { Agent, AgentState } from '../types'

// 类型写在 types/index.d.ts（contract 须自包含），这里转出，供 register 与测试使用。
export type { Agent, AgentState }

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
      toolCalls: 0,
    },
  ]
}

// 叫醒：重新计时，调用次数接着累加。
export function resumeAgent(list: Agent[], agentId: string, now: number): Agent[] {
  return updateAgent(list, agentId, ({ endedAt: _, ...a }) => ({ ...a, state: 'running', startedAt: now }))
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

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// 取这次调用最能说明意图的字段，供第 2 行「› 工具 参数」用。
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

// 记下最近一次工具并计数；计划类工具也是普通工具。
export function recordTool(
  list: Agent[],
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
): Agent[] {
  return updateAgent(list, agentId, a => ({
    ...a,
    toolCalls: a.toolCalls + 1,
    lastTool: { tool, hint: toolHint(tool, input) },
  }))
}

export function overviewOf(list: Agent[]): { running: number; completed: number; failed: number } {
  return {
    running: list.filter(a => a.state === 'running').length,
    completed: list.filter(a => a.state === 'completed').length,
    failed: list.filter(a => a.state === 'failed' || a.state === 'killed').length,
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m${pad2(totalSec % 60)}s`
  return `${Math.floor(totalSec / 3600)}h${pad2(Math.floor((totalSec % 3600) / 60))}m`
}

// 亮光在 width 格里来回弹：起点 0→(width-len)→0，周期 2*(width-len) 帧。（与 task-progress 同一算法，各 mod 独立打包）
export function sweep(frame: number, width = 10, len = 3): boolean[] {
  const span = width - len
  const period = span * 2
  const phase = period > 0 ? ((frame % period) + period) % period : 0
  const start = phase <= span ? phase : period - phase
  return Array.from({ length: width }, (_, i) => i >= start && i < start + len)
}

// 界面语言：settings 的 `language` 是中文（中文 / Chinese / zh…）就用中文，其余（含未设置）用英文。与 task-progress 同一规则。
export type Lang = 'zh' | 'en'

export function pickLang(language: unknown): Lang {
  return typeof language === 'string' && /中文|汉语|漢語|chinese|^zh\b/i.test(language.trim()) ? 'zh' : 'en'
}

// pane 上的文案；标题 SubAgent View、avatar 短名称、工具名两种语言都一样。
export type Strings = {
  running: (n: number) => string
  done: (n: number) => string
  failed: (n: number) => string
  toolCalls: (n: number) => string
  calls: (n: number) => string
  starting: string
  ended: string
  killed: string
  failedEnd: string
  empty1: string
  empty2: string
}

const ZH: Strings = {
  running: n => `${n} 在跑`,
  done: n => `${n} 完成`,
  failed: n => `${n} 失败`,
  toolCalls: n => `${n} 次工具`,
  calls: n => `${n} 次`,
  starting: '启动中',
  ended: '已结束',
  killed: '已停止',
  failedEnd: '失败',
  empty1: '这个 session 还没派出 subagent。',
  empty2: '派出后会出现在这里。',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const EN: Strings = {
  running: n => `${n} running`,
  done: n => `${n} done`,
  failed: n => `${n} failed`,
  toolCalls: n => plural(n, 'tool call'),
  calls: n => plural(n, 'call'),
  starting: 'starting',
  ended: 'Ended',
  killed: 'stopped',
  failedEnd: 'failed',
  empty1: 'No subagents in this session yet.',
  empty2: 'They show up here once dispatched.',
}

export function strings(lang: Lang): Strings {
  return lang === 'zh' ? ZH : EN
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
