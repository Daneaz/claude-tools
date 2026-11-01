import type { AgentInfo, On, ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { textWidth } from '../hooks/logic'

const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

type Status = 'pending' | 'in_progress' | 'completed'
type Todo = { content: string; status: Status; activeForm: string }

const NAMES = ['查代码', '写代码', '写测试', '跑测试', '提交']

// 按状态列出计划：第 i 个任务名取 NAMES[i]，activeForm 为「正在<名>」。
function todos(...statuses: Status[]): Todo[] {
  return statuses.map((status, i) => {
    const content = NAMES[i] ?? `任务 ${i}`

    return { content, status, activeForm: `正在${content}` }
  })
}

// 充当 engine：计划工具按工具名回结果，TaskCreate 依次发 id 1、2、…；
// TaskUpdate 的回复与 agent.list 的回复可由测试换掉（默认：派过的都在运行）；AbovePrompt 默认是 engine 自己（什么都不画），
// `lower` 时换成一个更低层 mod 画的 `low`。
function engine(on: On, { lower = false } = {}) {
  const clock = mock.clock(on)
  const replies = {
    taskUpdate: (taskId: string): ToolCallResult => ({
      result: { success: true, taskId, updatedFields: ['status'] },
    }),
    agents: (): AgentInfo[] => spawned.map(id => ({ id, description: 'd', type: 'general-purpose', status: 'running' })),
  }
  const spawned: string[] = []
  let lastId = 0
  on('tool.call', (_, e) => {
    switch (e.tool) {
      case 'TodoWrite':
        return { result: { oldTodos: [], newTodos: e.todos } }
      case 'TaskCreate':
        lastId += 1
        return { result: { task: { id: String(lastId), subject: e.subject } } }
      case 'TaskUpdate':
        return replies.taskUpdate(e.taskId)
      default:
        return { result: {} }
    }
  })
  on('agent.spawn', () => {
    spawned.push('a1')

    return { model: 'm', agentId: 'a1' }
  })
  on('agent.list', () => ({ value: replies.agents() }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    if (!lower) {
      return { type: 'engine', ref: 0 }
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="low">
        <Text>x</Text>
      </Box>
    )
  })

  return { clock, replies }
}

async function write($: Engine, list: Todo[], agentId?: string) {
  await $.tool.call({ tool: 'TodoWrite', todos: list, ...(agentId === undefined ? {} : { agentId }) })
}

async function submit($: Engine) {
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
}

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: '实现登录接口，带测试',
  description: '实现登录接口',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: true,
  fork: false,
} as const

const DONE = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

type Ui = { find: (q: { key: string }) => Promise<{ text: string } | undefined> }

async function textOf(ui: Ui, key: string) {
  return (await ui.find({ key }))?.text
}

test('hidden without plan', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await ui.unmount()
})

test('collapsed shows progress', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress', 'pending', 'pending', 'pending'))
  const ui = await $.ui.mount(BAND)

  const text = await textOf(ui, 'toggle')
  expect(text).toContain('2/5')
  expect(text).toContain('写代码')
  expect(text).toContain('还剩 3 个')
  expect(text).toStartWith('▰▰▱▱▱')
  // 默认收起：清单不在。
  expect(await ui.find({ key: 'task-0' })).toBeUndefined()
  await ui.unmount()
})

test('press expands rows', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress', 'pending', 'pending', 'pending'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })

  for (const id of ['0', '1', '2', '3', '4']) {
    expect(await ui.find({ key: `task-${id}` })).toBeDefined()
  }
  expect(await textOf(ui, 'bar-0')).toBe('▰'.repeat(10))
  expect(await ui.find({ key: 'bar-1' })).toBeDefined()
  expect(await ui.find({ key: 'bar-2' })).toBeUndefined()
  expect(await textOf(ui, 'note-0')).toContain('Done')
  expect(await textOf(ui, 'note-1')).toContain('正在写代码')
  expect(await textOf(ui, 'note-2')).toContain('Next')

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'task-0' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle' })).toBeDefined()
  await ui.unmount()
})

test('parallel shows +N', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress', 'in_progress', 'pending', 'pending'))
  const ui = await $.ui.mount(BAND)

  const text = await textOf(ui, 'toggle')
  expect(text).toContain('2/5')
  expect(text).toContain('写代码 +1')
  expect(text).toContain('还剩 2 个')
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'bar-1' })).toBeDefined()
  expect(await ui.find({ key: 'bar-2' })).toBeDefined()
  expect(await textOf(ui, 'note-2')).toContain('正在写测试')
  await ui.unmount()
})

test('ignores subagent plan', async ($, on) => {
  engine(on)
  await write($, todos('in_progress', 'pending'), 'a1')
  await $.tool.call({ tool: 'TaskCreate', subject: '子任务', description: 'd', agentId: 'a1' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()

  // 主会话建的任务照常出现，subagent 建的没有混进来。
  await $.tool.call({ tool: 'TaskCreate', subject: '主任务', description: 'd' })
  const text = await textOf(ui, 'toggle')
  expect(text).toContain('1/1')
  expect(text).toContain('主任务')
  await ui.unmount()
})

test('failed calls leave the plan', async ($, on) => {
  const { replies } = engine(on)
  await $.tool.call({ tool: 'TaskCreate', subject: '查代码', description: 'd', activeForm: '正在查代码' })
  const ui = await $.ui.mount(BAND)
  expect(await textOf(ui, 'toggle')).toContain('还剩 1 个')

  const fails: ((taskId: string) => ToolCallResult)[] = [
    taskId => ({ result: { success: false, taskId, updatedFields: [], error: 'no such task' } }),
    () => ({ deny: 'x' }),
    () => ({ isError: true, result: 'boom', text: 'boom' }),
  ]
  for (const fail of fails) {
    replies.taskUpdate = fail
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' }).catch(() => undefined)
    expect(await textOf(ui, 'toggle')).toContain('还剩 1 个')
  }

  // 成功的更新照常生效；subagent 发来的也算（任务表 session 共享）。
  replies.taskUpdate = taskId => ({ result: { success: true, taskId, updatedFields: ['status'] } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', agentId: 'a1' })
  expect(await textOf(ui, 'toggle')).toContain('全部完成')
  await ui.unmount()
})

test('finished clears on next prompt', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'completed', 'completed'))
  const ui = await $.ui.mount(BAND)

  expect(await textOf(ui, 'toggle')).toBe('✓ 3/3 全部完成')
  await ui.press({ key: 'toggle' })
  expect(await textOf(ui, 'note-2')).toContain('Done')
  await submit($)
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()

  // 新计划从收起开始。
  await write($, todos('in_progress'))
  expect(await ui.find({ key: 'toggle' })).toBeDefined()
  expect(await ui.find({ key: 'task-0' })).toBeUndefined()
  await ui.unmount()
})

test('unfinished plan survives a prompt', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress'))
  const ui = await $.ui.mount(BAND)
  await submit($)

  expect(await textOf(ui, 'toggle')).toContain('2/2')
  await ui.unmount()
})

test('subagent row lives until its turn completes', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress', 'pending'))
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount(BAND)

  expect(await textOf(ui, 'toggle')).toContain('1 个 subagent')
  await ui.press({ key: 'toggle' })
  const row = await textOf(ui, 'agent-a1')
  expect(row).toContain('↳ subagent')
  expect(row).toContain('实现登录接口')
  expect(row).toContain('运行中')

  // 后台 subagent 跨 prompt 仍在跑；主循环的 turn.complete 不算它结束。
  await submit($)
  await $.turn.complete(DONE)
  expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

  await $.turn.complete({ ...DONE, agentId: 'a1' })
  expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
  expect(await textOf(ui, 'toggle')).not.toContain('subagent')
  await ui.unmount()
})

test('nested and workflow agents are not tracked', async ($, on) => {
  engine(on)
  await write($, todos('in_progress'))
  await $.agent.spawn({ ...SPAWN, parentAgentId: 'p1' })
  await $.agent.spawn({ ...SPAWN, workflow: { runId: 'wf_1', agentIndex: 1 } })
  const ui = await $.ui.mount(BAND)

  const text = await textOf(ui, 'toggle')
  expect(text).toContain('1/1')
  expect(text).not.toContain('subagent')
  await ui.unmount()
})

// 文档顺序里的 Box key，用来看行的先后。
async function boxKeys(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }) {
  return (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '')
}

test('subagent row sits under the only running task, else at the end', async ($, on) => {
  engine(on)
  await write($, todos('completed', 'in_progress', 'pending'))
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })

  let keys = await boxKeys(ui)
  expect(keys.indexOf('agent-a1')).toBeGreaterThan(keys.indexOf('task-1'))
  expect(keys.indexOf('agent-a1')).toBeLessThan(keys.indexOf('task-2'))

  await write($, todos('in_progress', 'in_progress', 'pending'))
  keys = await boxKeys(ui)
  expect(keys.indexOf('agent-a1')).toBeGreaterThan(keys.indexOf('task-2'))
  await ui.unmount()
})

test('keeps lower band', async ($, on) => {
  engine(on, { lower: true })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'low' })).toBeDefined()

  await write($, todos('in_progress', 'pending'))
  expect(await ui.find({ key: 'toggle' })).toBeDefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

for (const [name, props, surface] of [
  ['quiet on survey', { ...BAND.props, hasSurvey: true }, 'terminal'],
  ['other surfaces pass', BAND.props, 'vscode'],
] as const) {
  test(name, async ($, on) => {
    engine(on, { lower: true })
    await write($, todos('in_progress', 'pending'))
    const ui = await $.ui.mount({ ...BAND, props, surface })

    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    expect(await ui.find({ key: 'low' })).toBeDefined()
    await ui.unmount()
  })
}

// 桌面端也画同一条 band（AbovePrompt 只在 terminal 与 desktop 上出现）。
test('draws on desktop too', async ($, on) => {
  engine(on, { lower: true })
  await write($, todos('completed', 'in_progress', 'pending'))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  expect((await ui.find({ key: 'toggle' }))?.text).toContain('2/3')
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'task-1' })).toBeDefined()
  await ui.unmount()
})

test('animates only while open with a running task', async ($, on) => {
  const { clock } = engine(on)
  let ticks = 0
  on('state.set', { plugin: 'task-progress', key: 'frame' }, (_, e, next) => {
    ticks += 1

    return next(e)
  })
  await write($, todos('completed', 'in_progress', 'pending'))
  const ui = await $.ui.mount(BAND)

  // 收起时不走表。
  await clock.advance(1000)
  expect(ticks).toBe(0)

  await ui.press({ key: 'toggle' })
  expect(await textOf(ui, 'bar-1')).toBe('▰▰▰▱▱▱▱▱▱▱')
  await clock.advance(160)
  expect(await textOf(ui, 'bar-1')).toBe('▱▰▰▰▱▱▱▱▱▱')

  await ui.press({ key: 'toggle' })
  let before = ticks
  await clock.advance(1000)
  expect(ticks).toBe(before)

  // 展开着，但没有进行中的任务了：也停。
  await ui.press({ key: 'toggle' })
  await clock.advance(160)
  expect(ticks).toBe(before + 1)
  await write($, todos('completed', 'completed', 'pending'))
  before = ticks
  await clock.advance(1000)
  expect(ticks).toBe(before)

  // 展开着又来了进行中的任务：计划变化时重新起表。
  await write($, todos('completed', 'completed', 'in_progress'))
  await clock.advance(320)
  expect(ticks).toBe(before + 2)
  await ui.unmount()
})

test('long text stays on one line', async ($, on) => {
  engine(on)
  const long = '把登录接口拆成三个服务并补上集成测试与文档以及回滚方案'
  await write($, [
    { content: '查代码', status: 'completed', activeForm: '正在查代码' },
    { content: long, status: 'in_progress', activeForm: `正在${long}` },
    { content: '提交', status: 'pending', activeForm: '正在提交' },
  ])
  await $.agent.spawn({ ...SPAWN, description: long })
  const columns = 50
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns } })
  await ui.press({ key: 'toggle' })

  const toggle = (await textOf(ui, 'toggle')) ?? ''
  expect(textWidth(toggle)).toBeLessThanOrEqual(columns)
  expect(toggle).toContain('2/3')
  expect(toggle).toContain('…')
  for (const key of ['task-0', 'task-1', 'task-2', 'agent-a1']) {
    const row = (await textOf(ui, key)) ?? ''
    expect(textWidth(row)).toBeLessThanOrEqual(columns)
  }
  // 名称列上限 bodyColumns 的 40%：进度条列、描述列在各行从同一列开始。
  const name = Math.floor(columns * 0.4)
  expect(await textOf(ui, 'task-1')).toContain('…')
  expect(textWidth(((await textOf(ui, 'task-0')) ?? '').split('▰')[0] ?? '')).toBe(5 + name + 2)
  expect(textWidth(((await textOf(ui, 'task-2')) ?? '').split('Next')[0] ?? '')).toBe(5 + name + 2 + 10 + 2)
  // subagent 行的「运行中」与任务行的描述列同一列。
  expect(textWidth(((await textOf(ui, 'agent-a1')) ?? '').split('运行中')[0] ?? '')).toBe(5 + name + 2 + 10 + 2)
  await ui.unmount()
})

test('long plan respects maxRows and keeps lower band', async ($, on) => {
  engine(on, { lower: true })
  const statuses: Status[] = ['completed', 'completed', 'completed', 'completed', 'completed', 'in_progress']
  for (let i = 0; i < 14; i++) statuses.push('pending')
  await write($, todos(...statuses))
  await $.agent.spawn(SPAWN)
  const maxRows = 10
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows } })
  await ui.press({ key: 'toggle' })

  // 收起行 1 + 空行 1 + 给下层留 3 行：清单（含 subagent 行与「另有」行）最多 maxRows - 5 行。
  const keys = (await boxKeys(ui)).filter(k => /^(task|agent|more)-/.test(k))
  expect(keys.length).toBeLessThanOrEqual(maxRows - 5)
  // 以当前任务为中心：进行中的任务在，上下都有省略汇总。
  expect(keys).toContain('task-5')
  expect(keys).toContain('more-above')
  expect(keys).toContain('more-below')
  expect(await textOf(ui, 'more-above')).toMatch(/… 另有 \d+ 个/)
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('emptied plan starts collapsed', async ($, on) => {
  const { replies } = engine(on)
  // TodoWrite([]) 清空。
  await write($, todos('in_progress', 'pending'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'task-0' })).toBeDefined()
  await write($, [])
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await write($, todos('in_progress'))
  expect(await ui.find({ key: 'task-0' })).toBeUndefined()

  // 全部 deleted。
  await write($, [])
  await $.tool.call({ tool: 'TaskCreate', subject: '查代码', description: 'd' })
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'task-1' })).toBeDefined()
  replies.taskUpdate = taskId => ({ result: { success: true, taskId, updatedFields: ['status'] } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' })
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  await $.tool.call({ tool: 'TaskCreate', subject: '写代码', description: 'd' })
  expect(await ui.find({ key: 'task-2' })).toBeUndefined()
  await ui.unmount()
})

test('new plan after finished starts collapsed', async ($, on) => {
  engine(on)
  await $.tool.call({ tool: 'TaskCreate', subject: '查代码', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'task-1' })).toBeDefined()

  // 没提交 prompt 就开了新计划：旧的被清掉，新的从收起开始。
  await $.tool.call({ tool: 'TaskCreate', subject: '写代码', description: 'd' })
  expect(await textOf(ui, 'toggle')).toContain('1/1')
  expect(await ui.find({ key: 'task-2' })).toBeUndefined()
  await ui.unmount()
})

test('timer stops itself when state resets under it', async ($, on) => {
  const { clock } = engine(on)
  let ticks = 0
  let cleared = false
  on('state.set', { plugin: 'task-progress', key: 'frame' }, (_, e, next) => {
    ticks += 1

    return next(e)
  })
  // 模拟 /clear：state 回到默认值（收起），本 mod 的 toggle / changePlan 都没走。
  on('state.get', { plugin: 'task-progress', key: 'isOpen' }, (_, e, next) =>
    cleared ? { value: { value: false, version: 0 } } : next(e),
  )
  await write($, todos('in_progress'))
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await clock.advance(160)
  expect(ticks).toBe(1)

  cleared = true
  await clock.advance(1000)
  expect(ticks).toBe(1)
  await ui.unmount()
})

test('prompt drops subagents that are no longer running', async ($, on) => {
  const { replies } = engine(on)
  await write($, todos('in_progress'))
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount(BAND)
  expect(await textOf(ui, 'toggle')).toContain('1 个 subagent')

  // 还在跑：留着。
  await submit($)
  expect(await textOf(ui, 'toggle')).toContain('1 个 subagent')

  // turn.complete 漏了，但 agent.list 说已结束：下一次 prompt 时去掉。
  replies.agents = () => [{ id: 'a1', description: 'd', type: 'general-purpose', status: 'killed' }]
  await submit($)
  expect(await textOf(ui, 'toggle')).not.toContain('subagent')

  // 列表里已没有它的也去掉。
  await $.agent.spawn(SPAWN)
  expect(await textOf(ui, 'toggle')).toContain('1 个 subagent')
  replies.agents = () => []
  await submit($)
  expect(await textOf(ui, 'toggle')).not.toContain('subagent')
  await ui.unmount()
})
