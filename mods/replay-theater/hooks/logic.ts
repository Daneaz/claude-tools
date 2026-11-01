// 纯逻辑：路径缩写、行 diff 与上下文裁剪、计数、步骤清单窗口与胶囊。移植自 Replay Theater 原版。

import type { DiffLine, Step } from '../types'

// 类型写在 types/index.d.ts（contract 须自包含），这里转出，供 register 与测试使用。
export type { DiffLine, Step }

export const MAX_DIFF_LINES = 12
export const MAX_LCS_LINES = 400

// cwd 下的文件去掉 cwd 前缀；没有路径时给占位文案。
export function relPath(cwd: string, path?: string): string {
  if (!path) return '(unknown file)'
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

// 按行切分；末尾换行不产生空行，空文本为零行。
function splitLines(text?: string | null): string[] {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// 行 diff：小输入走 LCS，未变的行作上下文；任一侧超过 400 行则全删再全加。
export function diffLines(oldText?: string, newText?: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t): DiffLine => ({ op: '-', t })), ...b.map((t): DiffLine => ({ op: '+', t }))]
  }
  const n = a.length
  const m = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度，扁平存放。
  const w = m + 1
  const dp = new Array<number>((n + 1) * w).fill(0)
  const at = (i: number, j: number): number => dp[i * w + j] ?? 0
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const x = a[i] as string
    const y = b[j] as string
    if (x === y) {
      out.push({ op: ' ', t: x })
      i++
      j++
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ op: '-', t: x })
      i++
    } else {
      out.push({ op: '+', t: y })
      j++
    }
  }
  while (i < n) out.push({ op: '-', t: a[i++] as string })
  while (j < m) out.push({ op: '+', t: b[j++] as string })
  return trimContext(out)
}

// 每处改动只留上下各 1 行上下文，被跳过的一段换成 ⋯；全无改动时只取前 12 行。
function trimContext(lines: DiffLine[]): DiffLine[] {
  if (!lines.some((l) => l.op !== ' ')) return lines.slice(0, MAX_DIFF_LINES)
  const changed = (k: number): boolean => {
    const l = lines[k]
    return l !== undefined && l.op !== ' '
  }
  const out: DiffLine[] = []
  let skipped = false
  lines.forEach((l, k) => {
    if (changed(k) || changed(k - 1) || changed(k + 1)) {
      if (skipped && out.length) out.push({ op: '~', t: '⋯' })
      out.push(l)
      skipped = false
    } else skipped = true
  })
  return out
}

export function countChanges(diff: DiffLine[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of diff) {
    if (l.op === '+') add++
    else if (l.op === '-') del++
  }
  return { add, del }
}

// 涉及的文件数（去重）。
export function fileCount(steps: Step[]): number {
  return new Set(steps.map((s) => s.file)).size
}

// 步骤清单的可见窗口 [start, end)：最多 size 行，当前步尽量居中，贴边时靠边。
export function listWindow(total: number, index: number, size = 7): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total }
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), total - size)
  return { start, end: start + size }
}

// 胶囊：看过的（序号 < index）、当前一个、没看的；最多 cap 个，超出的数量记在 overflow（画成 +N）。
// 超过 cap 时可见的一段随当前步滑动（同 listWindow 居中），当前步始终画出。只在有回放（total > 0）时调用。
export function pills(
  total: number,
  index: number,
  cap = 10,
): { seen: number; current: boolean; rest: number; overflow: number } {
  const { start, end } = listWindow(total, index, cap)
  const seen = index - start
  return { seen, current: true, rest: end - start - 1 - seen, overflow: total - (end - start) }
}
