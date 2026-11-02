import { expect, test } from 'claude-code/testing'

import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  clearIfFinished,
  fit,
  pickLang,
  strings,
  summarize,
  sweep,
  textWidth,
  truncate,
  windowRows,
} from '../hooks/logic'
import type { Plan, Task, TaskStatus } from '../hooks/logic'

const EMPTY: Plan = { tasks: [] }

function planOf(...items: [title: string, status: TaskStatus][]): Plan {
  return { tasks: items.map(([title, status], i): Task => ({ id: String(i + 1), title, status })) }
}

test('todo write replaces the list', async () => {
  const first = applyTodoWrite(EMPTY, [
    { content: '查代码', status: 'completed', activeForm: '正在查代码' },
    { content: '写代码', status: 'in_progress', activeForm: '正在写代码' },
  ])
  expect(first.tasks.length).toBe(2)
  const second = applyTodoWrite(first, [
    { content: '跑测试', status: 'pending', activeForm: '正在跑测试' },
  ])
  expect(second).toEqual({
    tasks: [{ id: '0', title: '跑测试', activeForm: '正在跑测试', status: 'pending' }],
  })
})

test('create appends pending', async () => {
  expect(applyTaskCreate(EMPTY, '1', '查代码', '正在查代码')).toEqual({
    tasks: [{ id: '1', title: '查代码', activeForm: '正在查代码', status: 'pending' }],
  })
})

test('create after finished starts fresh', async () => {
  const done = planOf(['一', 'completed'], ['二', 'completed'], ['三', 'completed'])
  const next = applyTaskCreate(done, '4', '新任务')
  expect(next.tasks.length).toBe(1)
  expect(next.tasks[0]?.id).toBe('4')
  const s = summarize(next)
  expect(s.position).toBe(1)
  expect(s.total).toBe(1)
})

test('update changes status and deletes', async () => {
  const plan = planOf(['一', 'pending'], ['二', 'pending'])
  const running = applyTaskUpdate(plan, { taskId: '1', status: 'in_progress' })
  expect(running.tasks[0]?.status).toBe('in_progress')
  const deleted = applyTaskUpdate(running, { taskId: '2', status: 'deleted' })
  expect(deleted.tasks.some(t => t.id === '2')).toBe(false)
  expect(applyTaskUpdate(plan, { taskId: '99', status: 'completed' })).toBe(plan)
})

test('subagent update applies to main task', async () => {
  // 主会话建的任务，subagent 用 TaskUpdate 标完成：reducer 不区分调用者。
  const plan = applyTaskCreate(EMPTY, '1', '查代码')
  const next = applyTaskUpdate(plan, { taskId: '1', status: 'completed' })
  expect(next.tasks[0]?.status).toBe('completed')
})

test('summarize middle', async () => {
  const plan = planOf(
    ['查代码', 'completed'],
    ['写代码', 'in_progress'],
    ['三', 'pending'],
    ['四', 'pending'],
    ['五', 'pending'],
  )
  expect(summarize(plan)).toEqual({
    total: 5,
    done: 1,
    remaining: 3,
    position: 2,
    title: '写代码',
    extraRunning: 0,
    isFinished: false,
  })
})

test('summarize parallel', async () => {
  const s = summarize(
    planOf(['一', 'completed'], ['二', 'in_progress'], ['三', 'in_progress'], ['四', 'pending']),
  )
  expect(s.position).toBe(2)
  expect(s.extraRunning).toBe(1)
  expect(s.remaining).toBe(1)
})

test('summarize between tasks', async () => {
  const s = summarize(planOf(['第一项', 'completed'], ['第二项', 'pending'], ['第三项', 'pending']))
  expect(s.position).toBe(2)
  expect(s.title).toBe('第二项')
  expect(s.extraRunning).toBe(0)
})

test('summarize finished', async () => {
  const s = summarize(planOf(['一', 'completed'], ['二', 'completed']))
  expect(s.isFinished).toBe(true)
  expect(s.position).toBe(s.total)
})

test('clearIfFinished', async () => {
  const done = planOf(['一', 'completed'])
  expect(clearIfFinished(done)).toEqual(EMPTY)
  const open = planOf(['一', 'completed'], ['二', 'pending'])
  expect(clearIfFinished(open)).toBe(open)
  expect(summarize(EMPTY).isFinished).toBe(false)
})

test('sweep bounces', async () => {
  expect(sweep(0).slice(0, 3)).toEqual([true, true, true])
  expect(sweep(7).slice(7)).toEqual([true, true, true])
  expect(sweep(14)).toEqual(sweep(0))
  for (let f = 0; f < 28; f++) {
    const cells = sweep(f)
    expect(cells.length).toBe(10)
    expect(cells.filter(Boolean).length).toBe(3)
  }
})

test('truncate by columns', async () => {
  expect(truncate('review 代码', 20)).toBe('review 代码')
  expect(truncate('一二三四五六', 7)).toBe('一二三…')
  expect(truncate('abcdef', 4)).toBe('abc…')
})

test('text width counts CJK as two', async () => {
  expect(textWidth('review 代码')).toBe(11)
  expect(textWidth('▰▱✓›…')).toBe(5)
  expect(textWidth('')).toBe(0)
})

test('fit cuts then pads to the column', async () => {
  expect(fit('查代码', 10)).toBe('查代码    ')
  // 宽字符放不下时截断结果可能比列宽少 1 列，补空格补齐。
  expect(fit('一二三四五六', 8)).toBe('一二三… ')
  expect(textWidth(fit('一二三四五六', 8))).toBe(8)
  expect(fit('abc', 3)).toBe('abc')
})

test('window shows all when it fits', async () => {
  expect(windowRows(5, 2, 5)).toEqual({ start: 0, end: 5, showAbove: false, showBelow: false })
})

test('window centers on focus within budget', async () => {
  // 10 行、焦点 5、预算 5：上下各一行「另有」，中间 3 行以焦点为中心。
  expect(windowRows(10, 5, 5)).toEqual({ start: 4, end: 7, showAbove: true, showBelow: true })
  // 焦点在开头：没有上方汇总行，多出一行给清单。
  expect(windowRows(10, 0, 5)).toEqual({ start: 0, end: 4, showAbove: false, showBelow: true })
  // 焦点在末尾。
  expect(windowRows(10, 9, 5)).toEqual({ start: 6, end: 10, showAbove: true, showBelow: false })
})

test('window never exceeds budget', async () => {
  for (const total of [1, 3, 8, 20]) {
    for (let budget = 1; budget <= 10; budget++) {
      for (let focus = 0; focus < total; focus++) {
        const w = windowRows(total, focus, budget)
        const used = w.end - w.start + Number(w.showAbove) + Number(w.showBelow)
        expect(used).toBeLessThanOrEqual(Math.max(budget, 1))
        expect(focus >= w.start && focus < w.end).toBe(true)
      }
    }
  }
})

test('language picks chinese from settings, english otherwise', async () => {
  for (const v of ['中文', '简体中文', 'Chinese', 'chinese', 'zh', 'zh-CN', '繁體中文']) expect(pickLang(v)).toBe('zh')
  for (const v of ['English', 'en', '日本語', '', undefined, 42]) expect(pickLang(v)).toBe('en')
})

test('strings in both languages', async () => {
  expect(strings('zh').remaining(3)).toBe('还剩 3 个')
  expect(strings('en').remaining(3)).toBe('3 left')
  expect(strings('zh').finished(4)).toBe('✓ 4/4 全部完成')
  expect(strings('en').finished(4)).toBe('✓ 4/4 all done')
  expect(strings('zh').subagents(2)).toBe('2 个 subagent')
  expect(strings('en').subagents(1)).toBe('1 subagent')
  expect(strings('en').subagents(2)).toBe('2 subagents')
  expect(strings('zh').more(5)).toBe('… 另有 5 个')
  expect(strings('en').more(5)).toBe('… 5 more')
  expect(strings('zh').running).toBe('运行中')
  expect(strings('en').running).toBe('running')
  expect(strings('zh').inProgress).toBe('进行中')
  expect(strings('en').inProgress).toBe('in progress')
})
