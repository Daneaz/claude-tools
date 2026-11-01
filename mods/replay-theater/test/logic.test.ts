import { expect, test } from 'claude-code/testing'

import { countChanges, diffLines, fileCount, fitStart, listWindow, pills, relPath, textWidth } from '../hooks/logic'
import type { Step } from '../hooks/logic'

test('edit diff with context', async () => {
  expect(diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne')).toEqual([
    { op: ' ', t: 'b' },
    { op: '-', t: 'c' },
    { op: '+', t: 'X' },
    { op: ' ', t: 'd' },
  ])
})

test('skipped run shows ellipsis', async () => {
  // 第 2 行与第 8 行改动，中间 d e f 三行被跳过。
  const diff = diffLines('a\nb\nc\nd\ne\nf\ng\nh\ni', 'a\nB\nc\nd\ne\nf\ng\nH\ni')
  expect(diff).toEqual([
    { op: ' ', t: 'a' },
    { op: '-', t: 'b' },
    { op: '+', t: 'B' },
    { op: ' ', t: 'c' },
    { op: '~', t: '⋯' },
    { op: ' ', t: 'g' },
    { op: '-', t: 'h' },
    { op: '+', t: 'H' },
    { op: ' ', t: 'i' },
  ])
})

test('big write no lcs', async () => {
  const old = Array.from({ length: 401 }, (_, i) => `line ${i}`).join('\n')
  const diff = diffLines(old, old)
  // 超过 400 行不做行匹配：同样的文本也是全删再全加。
  expect(diff.length).toBe(802)
  expect(diff.slice(0, 401).every((l) => l.op === '-')).toBe(true)
  expect(diff.slice(401).every((l) => l.op === '+')).toBe(true)
})

test('new file', async () => {
  expect(diffLines('', 'a\nb')).toEqual([
    { op: '+', t: 'a' },
    { op: '+', t: 'b' },
  ])
  // 末尾换行不多出空行。
  expect(diffLines(undefined, 'a\n')).toEqual([{ op: '+', t: 'a' }])
})

test('no change', async () => {
  const diff = diffLines('a\nb\nc', 'a\nb\nc')
  expect(diff.some((l) => l.op === '+' || l.op === '-')).toBe(false)
})

test('count and files', async () => {
  expect(countChanges(diffLines('a\nb\nc', 'a\nX\nY\nc'))).toEqual({ add: 2, del: 1 })
  const step = (file: string): Step => ({ tool: 'Edit', file, diff: [], note: '' })
  expect(fileCount([step('a.ts'), step('b.ts'), step('a.ts')])).toBe(2)
  expect(fileCount([])).toBe(0)
})

test('window keeps current visible', async () => {
  expect(listWindow(20, 0)).toEqual({ start: 0, end: 7 })
  const mid = listWindow(20, 10)
  expect(mid.start <= 10 && 10 < mid.end && mid.end - mid.start === 7).toBe(true)
  expect(listWindow(20, 19)).toEqual({ start: 13, end: 20 })
  expect(listWindow(3, 1)).toEqual({ start: 0, end: 3 })
  for (let i = 0; i < 20; i++) {
    const w = listWindow(20, i)
    expect(w.start <= i && i < w.end).toBe(true)
  }
})

test('pills', async () => {
  expect(pills(5, 1)).toEqual({ seen: 1, current: true, rest: 3, overflow: 0 })
  const many = pills(14, 0)
  expect(many.overflow).toBe(4)
  expect(many.seen + 1 + many.rest).toBe(10)
})

test('pills window follows current', async () => {
  // 超过封顶时可见的 10 个胶囊随当前步滑动（同 listWindow 居中），当前步始终画出。
  expect(pills(14, 12)).toEqual({ seen: 8, current: true, rest: 1, overflow: 4 })
  expect(pills(14, 13)).toEqual({ seen: 9, current: true, rest: 0, overflow: 4 })
  expect(pills(14, 5)).toEqual({ seen: 5, current: true, rest: 4, overflow: 4 })
})

test('fitStart by column width', async () => {
  expect(fitStart('a.ts', 6)).toBe('a.ts  ')
  expect(fitStart('文档.md', 9)).toBe('文档.md  ')
  expect(fitStart('src/long/name.ts', 8)).toBe('…name.ts')
  // 全角字符放不下半个：补空格凑满列宽。
  const cut = fitStart('目录/文档说明.md', 9)
  expect(cut).toBe('…说明.md ')
  expect(textWidth(cut)).toBe(9)
})

test('relPath', async () => {
  expect(relPath('/repo', '/repo/src/a.ts')).toBe('src/a.ts')
  expect(relPath('/repo', '/other/a.ts')).toBe('/other/a.ts')
  expect(relPath('/repo')).toBe('(unknown file)')
})
