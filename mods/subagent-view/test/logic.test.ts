import { expect, test } from 'claude-code/testing'

import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  avatarFor,
  endAgent,
  endStateOf,
  etaOf,
  fit,
  formatElapsed,
  formatEta,
  formatEtaLong,
  ordered,
  overviewOf,
  progressOf,
  recordTool,
  resumeAgent,
  spawnAgent,
  textWidth,
  toolHint,
  truncate,
} from '../hooks/logic'
import type { Agent, Step, StepStatus } from '../hooks/logic'

function stepsOf(...statuses: StepStatus[]): Step[] {
  return statuses.map((status, i) => ({ id: `todo-${i}`, title: `第 ${i} 步`, status }))
}

function agentOf(over: Partial<Agent> & { agentId: string }): Agent {
  return {
    type: 'general-purpose',
    description: '',
    state: 'running',
    startedAt: 0,
    steps: [],
    doneAtStart: 0,
    ...over,
  }
}

function todos(...statuses: StepStatus[]) {
  return statuses.map((status, i) => ({ content: `第 ${i} 步`, status, activeForm: `正在做第 ${i} 步` }))
}

test('avatarFor uses the table and guesses the rest', async () => {
  expect(avatarFor('general-purpose')).toEqual({ avatar: '🧰', name: 'General' })
  expect(avatarFor('explore').avatar).toBe('🔭')
  expect(avatarFor('Explore')).toEqual({ avatar: '🔭', name: 'Explore' })
  expect(avatarFor('combat-designer')).toEqual({ avatar: '🥊', name: 'Combat' })
  expect(avatarFor('code-reviewer')).toEqual({ avatar: '🔍', name: 'CodeRevie…' })
  expect(avatarFor('foo')).toEqual({ avatar: '🧩', name: 'Foo' })
  expect(avatarFor('security_audit').avatar).toBe('🔒')
  expect(avatarFor('tech-writer').avatar).toBe('📝')
})

test('avatarFor strips a plugin prefix', async () => {
  expect(avatarFor('superpowers:code-reviewer')).toEqual({ avatar: '🔍', name: 'CodeRevie…' })
  expect(avatarFor('game:designer')).toEqual({ avatar: '🎨', name: 'Designer' })
  expect(avatarFor('a:b:Explore')).toEqual({ avatar: '🔭', name: 'Explore' })
})

test('spawnAgent appends and ignores duplicate ids', async () => {
  const list = spawnAgent([], { agentId: 'a', type: 'Explore', description: '搜', now: 5 })
  expect(list).toEqual([
    { agentId: 'a', type: 'Explore', description: '搜', state: 'running', startedAt: 5, steps: [], doneAtStart: 0 },
  ])
  expect(spawnAgent(list, { agentId: 'a', type: 'Plan', description: 'x', now: 9 })).toBe(list)
})

test('endAgent only ends running agents', async () => {
  const list = [agentOf({ agentId: 'a' }), agentOf({ agentId: 'b', state: 'killed', endedAt: 3 })]
  const next = endAgent(list, 'a', 'completed', 10)
  expect(next[0]?.state).toBe('completed')
  expect(next[0]?.endedAt).toBe(10)
  expect(endAgent(next, 'b', 'failed', 20)[1]).toEqual(list[1])
})

test('endStateOf maps reasons', async () => {
  expect(endStateOf('answer')).toBe('completed')
  expect(endStateOf('aborted')).toBe('killed')
  expect(endStateOf('error')).toBe('failed')
  expect(endStateOf('refusal')).toBe('failed')
})

test('todoWrite replaces steps with todo ids', async () => {
  const list = applyTodoWrite([agentOf({ agentId: 'a' })], 'a', todos('completed', 'in_progress'))
  expect(list[0]?.steps).toEqual([
    { id: 'todo-0', title: '第 0 步', activeForm: '正在做第 0 步', status: 'completed' },
    { id: 'todo-1', title: '第 1 步', activeForm: '正在做第 1 步', status: 'in_progress' },
  ])
})

test('taskUpdate ignores todo ids', async () => {
  const list = applyTodoWrite([agentOf({ agentId: 'a' })], 'a', todos('pending', 'pending'))
  expect(applyTaskUpdate(list, { taskId: '1', status: 'completed' })).toBe(list)
})

test('taskUpdate applies to owner', async () => {
  let list = [agentOf({ agentId: 'a' }), agentOf({ agentId: 'b' })]
  list = applyTaskCreate(list, 'a', '7', '查代码', '正在查代码')
  expect(list[0]?.steps).toEqual([{ id: '7', title: '查代码', activeForm: '正在查代码', status: 'pending' }])
  // B 发起的 update，也落在持有 7 的 A 上
  list = applyTaskUpdate(list, { taskId: '7', status: 'completed' })
  expect(list[0]?.steps[0]?.status).toBe('completed')
  expect(list[1]?.steps).toEqual([])
  list = applyTaskUpdate(list, { taskId: '7', status: 'deleted' })
  expect(list[0]?.steps).toEqual([])
})

test('toolHint picks the telling field', async () => {
  expect(toolHint('Grep', { pattern: 'useAuth' })).toBe('"useAuth"')
  expect(toolHint('Read', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  expect(toolHint('Bash', { description: '跑测试', command: 'npm test' })).toBe('跑测试')
  expect(toolHint('Bash', { command: 'x'.repeat(40) })).toBe('x'.repeat(29) + '…')
  expect(toolHint('Mystery', { a: 1 })).toBe('')
})

test('recordTool skips plan tools', async () => {
  const list = [agentOf({ agentId: 'a' })]
  const next = recordTool(list, 'a', 'Glob', { pattern: '**/*.ts' })
  expect(next[0]?.lastTool).toEqual({ tool: 'Glob', hint: '**/*.ts' })
  expect(recordTool(next, 'a', 'TodoWrite', {})[0]?.lastTool).toEqual({ tool: 'Glob', hint: '**/*.ts' })
})

test('progressOf finds the current step', async () => {
  const a = agentOf({
    agentId: 'a',
    steps: [
      { id: '1', title: '一', status: 'completed' },
      { id: '2', title: '二', activeForm: '正在二', status: 'in_progress' },
      { id: '3', title: '三', status: 'pending' },
    ],
  })
  expect(progressOf(a)).toEqual({ total: 3, done: 1, remaining: 2, current: { text: '正在二', isActive: true } })
  const b = agentOf({ agentId: 'b', steps: stepsOf('completed', 'pending') })
  expect(progressOf(b).current).toEqual({ text: '第 1 步', isActive: false })
})

test('eta', async () => {
  const a = agentOf({
    agentId: 'a',
    steps: stepsOf('completed', 'completed', 'completed', 'pending', 'pending', 'pending', 'pending'),
  })
  expect(etaOf(a, 180000)).toBe(240000)
  expect(etaOf(agentOf({ agentId: 'b', steps: stepsOf('pending', 'pending') }), 180000)).toBe('estimating')
  expect(etaOf(agentOf({ agentId: 'c' }), 180000)).toBe(null)
})

test('eta after resume uses steps since resume', async () => {
  let list = applyTodoWrite([agentOf({ agentId: 'a' })], 'a', todos('completed', 'completed', 'pending', 'pending'))
  list = endAgent(list, 'a', 'completed', 50000)
  list = resumeAgent(list, 'a', 100000)
  expect(list[0]?.state).toBe('running')
  expect(list[0]?.endedAt).toBe(undefined)
  expect(list[0]?.doneAtStart).toBe(2)
  list = applyTodoWrite(list, 'a', todos('completed', 'completed', 'completed', 'pending'))
  expect(etaOf(list[0]!, 160000)).toBe(60000)
})

test('overview', async () => {
  const now = 100000
  const list = [
    // 75s 完成 1 步，剩 4 → 300000
    agentOf({ agentId: 'a', startedAt: now - 75000, steps: stepsOf('completed', 'pending', 'pending', 'pending', 'pending') }),
    // 60s 完成 1 步，剩 3 → 180000
    agentOf({ agentId: 'b', startedAt: now - 60000, steps: stepsOf('completed', 'pending', 'pending', 'pending') }),
    // 0 步完成，剩 5 → estimating
    agentOf({ agentId: 'c', steps: stepsOf('pending', 'pending', 'pending', 'pending', 'pending') }),
    agentOf({ agentId: 'd', state: 'completed', endedAt: 1 }),
    agentOf({ agentId: 'e', state: 'killed', endedAt: 2 }),
  ]
  expect(etaOf(list[0]!, now)).toBe(300000)
  expect(etaOf(list[1]!, now)).toBe(180000)
  expect(overviewOf(list, now)).toEqual({ running: 3, completed: 1, failed: 1, remainingSteps: 12, etaMs: 300000 })
  expect(overviewOf([], now).etaMs).toBe(null)
})

test('formatters', async () => {
  expect(formatElapsed(40000)).toBe('0m40s')
  expect(formatElapsed(252000)).toBe('4m12s')
  expect(formatElapsed(3780000)).toBe('1h03m')
  expect(formatEta(30000)).toBe('<1m')
  expect(formatEta(300000)).toBe('5m')
  expect(formatEtaLong(360000)).toBe('约 6 分钟')
  expect(formatEtaLong(30000)).toBe('不到 1 分钟')
})

test('ordered keeps spawn order and sorts ended by endedAt desc', async () => {
  const list = [
    agentOf({ agentId: 'r1' }),
    agentOf({ agentId: 'e1', state: 'completed', endedAt: 10 }),
    agentOf({ agentId: 'r2' }),
    agentOf({ agentId: 'e2', state: 'failed', endedAt: 30 }),
    agentOf({ agentId: 'e3', state: 'killed', endedAt: 20 }),
  ]
  const { running, ended } = ordered(list)
  expect(running.map(a => a.agentId)).toEqual(['r1', 'r2'])
  expect(ended.map(a => a.agentId)).toEqual(['e2', 'e3', 'e1'])
})

test('emoji count as two columns', async () => {
  for (const e of ['📟', '🔒', '📊', '🔭', '🧰', '🥊']) expect(textWidth(e)).toBe(2)
  expect(truncate('CodeReviewer', 10)).toBe('CodeRevie…')
  expect(fit('🔭 Explore', 12)).toBe('🔭 Explore  ')
})
