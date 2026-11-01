import { expect, test } from 'claude-code/testing'

import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  clearIfFinished,
  summarize,
  sweep,
  truncate,
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
