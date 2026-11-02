// 纯逻辑：把 TodoWrite / TaskCreate / TaskUpdate 折叠成计划，算摘要、扫动亮光与按列宽截断。

import type { Plan, Subagent, Summary, Task, TaskStatus } from '../types'

// 类型写在 types/index.d.ts（contract 须自包含），这里转出，供 register 与测试使用。
export type { Plan, Subagent, Summary, Task, TaskStatus }

// TodoWrite 每次给整张表：整表替换，id 用下标。
export function applyTodoWrite(
  _plan: Plan,
  todos: { content: string; status: TaskStatus; activeForm: string }[],
): Plan {
  return {
    tasks: todos.map((t, i) => ({
      id: String(i),
      title: t.content,
      activeForm: t.activeForm,
      status: t.status,
    })),
  }
}

// 上一份计划已全部完成时，新建任务意味着新计划：先清空再追加。
export function applyTaskCreate(plan: Plan, id: string, subject: string, activeForm?: string): Plan {
  const base = clearIfFinished(plan)
  const task: Task = { id, title: subject, status: 'pending' }
  if (activeForm !== undefined) task.activeForm = activeForm
  return { tasks: [...base.tasks, task] }
}

// 不区分调用者（主会话或 subagent）；id 不存在时原样返回同一引用。
export function applyTaskUpdate(
  plan: Plan,
  input: { taskId: string; subject?: string; activeForm?: string; status?: TaskStatus | 'deleted' },
): Plan {
  const index = plan.tasks.findIndex(t => t.id === input.taskId)
  if (index < 0) return plan
  if (input.status === 'deleted') {
    return { tasks: plan.tasks.filter((_, i) => i !== index) }
  }
  const old = plan.tasks[index]!
  const next: Task = {
    ...old,
    ...(input.subject !== undefined ? { title: input.subject } : {}),
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  }
  return { tasks: plan.tasks.map((t, i) => (i === index ? next : t)) }
}

export function clearIfFinished(plan: Plan): Plan {
  return summarize(plan).isFinished ? { tasks: [] } : plan
}

export function summarize(plan: Plan): Summary {
  const { tasks } = plan
  const total = tasks.length
  const done = tasks.filter(t => t.status === 'completed').length
  const remaining = tasks.filter(t => t.status === 'pending').length
  const running = tasks.filter(t => t.status === 'in_progress').length
  const isFinished = total > 0 && done === total

  // 优先第一个进行中，其次第一个 pending；都没有（全完成）时落在最后一项。
  let index = tasks.findIndex(t => t.status === 'in_progress')
  if (index < 0) index = tasks.findIndex(t => t.status === 'pending')
  if (index < 0) index = total - 1

  return {
    total,
    done,
    remaining,
    position: index + 1,
    title: tasks[index]?.title ?? '',
    extraRunning: Math.max(0, running - 1),
    isFinished,
  }
}

// 亮光在 width 格里来回弹：起点 0→(width-len)→0，周期 2*(width-len) 帧。
export function sweep(frame: number, width = 10, len = 3): boolean[] {
  const span = width - len
  const period = span * 2
  const phase = period > 0 ? ((frame % period) + period) % period : 0
  const start = phase <= span ? phase : period - phase
  return Array.from({ length: width }, (_, i) => i >= start && i < start + len)
}

// 东亚全角字符占 2 列；其余按 1 列。
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

// 清单超出预算时，取以 focus 为中心的一段 [start, end)；被省略的上方 / 下方各占一行汇总。
// 总行数（含汇总行）不超过 budget；budget 太小放不下汇总行时只留焦点所在的行、不画汇总。
export function windowRows(
  total: number,
  focus: number,
  budget: number,
): { start: number; end: number; showAbove: boolean; showBelow: boolean } {
  if (total <= budget) return { start: 0, end: total, showAbove: false, showBelow: false }
  for (let w = budget; w >= 1; w--) {
    const start = Math.min(Math.max(0, focus - Math.floor((w - 1) / 2)), total - w)
    const end = start + w
    const showAbove = start > 0
    const showBelow = end < total
    if (w + Number(showAbove) + Number(showBelow) <= budget) return { start, end, showAbove, showBelow }
  }
  return { start: focus, end: focus + 1, showAbove: false, showBelow: false }
}

// 界面语言：settings 的 `language` 是中文（中文 / Chinese / zh…）就用中文，其余（含未设置）用英文。
export type Lang = 'zh' | 'en'

export function pickLang(language: unknown): Lang {
  return typeof language === 'string' && /中文|汉语|漢語|chinese|^zh\b/i.test(language.trim()) ? 'zh' : 'en'
}

// band 上的文案；Done / Next 两种语言都用英文（用户定的）。
export type Strings = {
  remaining: (n: number) => string
  finished: (total: number) => string
  subagents: (n: number) => string
  more: (n: number) => string
  running: string
  inProgress: string
}

const ZH: Strings = {
  remaining: n => `还剩 ${n} 个`,
  finished: total => `✓ ${total}/${total} 全部完成`,
  subagents: n => `${n} 个 subagent`,
  more: n => `… 另有 ${n} 个`,
  running: '运行中',
  inProgress: '进行中',
}

const EN: Strings = {
  remaining: n => `${n} left`,
  finished: total => `✓ ${total}/${total} all done`,
  subagents: n => `${n} subagent${n === 1 ? '' : 's'}`,
  more: n => `… ${n} more`,
  running: 'running',
  inProgress: 'in progress',
}

export function strings(lang: Lang): Strings {
  return lang === 'zh' ? ZH : EN
}
