import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { textWidth } from '../hooks/logic'

const PANE = {
  plugin: 'subagent-view',
  component: 'Pane',
  requestId: 'subagent-view',
  surface: 'terminal',
  props: {
    title: 'SubAgent View',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Status = 'pending' | 'in_progress' | 'completed'

// 充当 engine：agent.spawn 依次发 a1、a2、…（resume 时沿用原 id）；agent.list 默认列出派过的、都在运行，
// 可由测试换掉；ui.open / ui.close 记下收到的 id。
// panes：engine 记录的、本 plugin 开着的 pane（ui.open 加入、ui.close 移除），可由测试预置。
function engine(on: On, { panes = [] as string[] } = {}) {
  const clock = mock.clock(on)
  const open = new Set(panes)
  const spawned: { id: string; spawnedBy?: string }[] = []
  const opened: string[] = []
  const closed: string[] = []
  // engine 收到 ui.close 那一刻 isOpen 的值：已是 false 说明是本 mod 的 ui.close hook 清的，
  // 不论关闭来自谁（用户的关闭键、命令）。
  const isOpenAtClose: unknown[] = []
  let isOpen: unknown
  on('state.set', { plugin: 'subagent-view', key: 'isOpen' }, (_, e, next) => {
    isOpen = e.value
    return next(e)
  })
  const replies = {
    agents: (): AgentInfo[] =>
      spawned.map(s => ({
        id: s.id,
        description: 'd',
        type: 'general-purpose',
        status: 'running',
        ...(s.spawnedBy === undefined ? {} : { spawnedBy: s.spawnedBy }),
      })),
    // 下一次派出的 agent 由哪个 plugin 派出（模拟别的 mod 的 $.agent.spawn）。
    nextSpawnedBy: undefined as string | undefined,
  }
  let lastId = 0
  on('tool.call', (_, e) => {
    switch (e.tool) {
      case 'TodoWrite':
        return { result: { oldTodos: [], newTodos: e.todos } }
      case 'TaskCreate':
        lastId += 1
        return { result: { task: { id: String(lastId), subject: e.subject } } }
      case 'TaskUpdate':
        return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
      default:
        return { result: {} }
    }
  })
  on('agent.spawn', (_, e) => {
    if (e.resume !== undefined) return { model: 'm', agentId: e.resume.agentId }
    const id = `a${spawned.length + 1}`
    spawned.push({ id, ...(replies.nextSpawnedBy === undefined ? {} : { spawnedBy: replies.nextSpawnedBy }) })
    replies.nextSpawnedBy = undefined
    return { model: 'm', agentId: id }
  })
  on('agent.list', () => ({ value: replies.agents() }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  const registered: unknown[] = []
  on('command.register', (_, e) => {
    registered.push(e)
    return { value: { command: 'subagents' } }
  })
  on('ui.panes', () => ({
    value: [...open].map(id => ({ id, title: 'SubAgent View', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    open.delete(e.id)
    isOpenAtClose.push(isOpen)
    return { value: undefined }
  })

  return { clock, replies, opened, closed, isOpenAtClose, registered }
}

type SpawnInput = Parameters<Engine['agent']['spawn']>[0]

const SPAWN: SpawnInput = {
  tool_use_id: 'tu1',
  prompt: '出登录页设计稿',
  description: '出登录页设计稿',
  subagentType: 'designer',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: true,
  fork: false,
}

const DONE = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

async function spawn($: Engine, extra: Partial<SpawnInput> = {}) {
  const r = await $.agent.spawn({ ...SPAWN, ...extra })
  return r.agentId ?? ''
}

// 7 步：完成 done 步，下一步进行中（activeForm 为「正在写测试」），其余未开始。
function plan(total: number, done: number) {
  return Array.from({ length: total }, (_, i) => {
    const status: Status = i < done ? 'completed' : i === done ? 'in_progress' : 'pending'
    return { content: `步骤 ${i + 1}`, status, activeForm: i === done ? '正在写测试' : `正在步骤 ${i + 1}` }
  })
}

async function write($: Engine, todos: ReturnType<typeof plan>, agentId?: string) {
  await $.tool.call({ tool: 'TodoWrite', todos, ...(agentId === undefined ? {} : { agentId }) })
}

type Ui = { findAll: (q: { type: string }) => Promise<{ key: string | undefined; text: string }[]> }

// pane 的每一行是一个 key 以 `row-` 开头的 Box；按文档顺序返回各行文本。
async function rows(ui: Ui) {
  return (await ui.findAll({ type: 'Box' })).filter(b => (b.key ?? '').startsWith('row-')).map(b => b.text)
}

async function hasRow(ui: Ui, ...parts: string[]) {
  return (await rows(ui)).some(r => parts.every(p => r.includes(p)))
}

async function toggle($: Engine) {
  await $.command.run({
    command: 'subagents',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

test('empty pane shows hint', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '这个 session 还没派出 subagent。')).toBe(true)
  expect(await hasRow(ui, '派出后会出现在这里。')).toBe(true)
  await ui.unmount()
})

test('spawned agent shows avatar, name, description', async ($, on) => {
  engine(on)
  await spawn($)
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '🎨', 'Designer', '出登录页设计稿')).toBe(true)
  expect(await hasRow(ui, '这个 session 还没派出 subagent。')).toBe(false)
  await ui.unmount()
})

test('subagent plan drives progress', async ($, on) => {
  const { clock } = engine(on)
  const id = await spawn($)
  await write($, plan(7, 3), id)
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '3/7', '剩 4 步')).toBe(true)
  expect(await hasRow(ui, '› 正在写测试')).toBe(true)
  await ui.unmount()

  // 时长与预计时间在渲染时用 $.clock.now() 现算：pane 关着不走表，重新 mount 读到新时间。
  await clock.advance(180_000)
  const later = await $.ui.mount(PANE)
  expect(await hasRow(later, '3/7', '≈ 4m')).toBe(true)
  expect(await hasRow(later, '🎨', '3m00s')).toBe(true)
  await later.unmount()
})

test('main loop plan is ignored', async ($, on) => {
  engine(on)
  await spawn($)
  await write($, plan(7, 3))
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '没有计划')).toBe(true)
  expect(await hasRow(ui, '3/7')).toBe(false)
  await ui.unmount()
})

test('no plan shows last tool', async ($, on) => {
  engine(on)
  const id = await spawn($)
  // Grep 不在 tool.call 的类型表里，按任意工具的输入传。
  await $.tool.call({ tool: 'Grep', pattern: 'useAuth', agentId: id } as unknown as Parameters<Engine['tool']['call']>[0])
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '没有计划', '最近：Grep "useAuth"')).toBe(true)
  await ui.unmount()
})

test('overview line', async ($, on) => {
  engine(on)
  const a = await spawn($)
  const b = await spawn($, { subagentType: 'general-purpose', description: '实现登录接口' })
  await write($, plan(7, 3), a)
  await write($, plan(4, 1), b)
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, 'SubAgent View', '2 在跑')).toBe(true)
  expect(await hasRow(ui, '合计剩余 7 步', '剩余时间')).toBe(true)
  await ui.unmount()
})

// 不到 1 分钟时不带「约」；否则「约 N 分钟」。
test('overview eta wording', async ($, on) => {
  const { clock } = engine(on)
  const a = await spawn($)
  await write($, plan(7, 3), a)
  const ui = await $.ui.mount(PANE)
  expect(await hasRow(ui, '剩余时间不到 1 分钟')).toBe(true)
  expect(await hasRow(ui, '剩余时间约')).toBe(false)
  await ui.unmount()

  // 已跑 4.5 分钟完成 3 步：剩 4 步约 6 分钟。
  await clock.advance(270_000)
  const later = await $.ui.mount(PANE)
  expect(await hasRow(later, '剩余时间约 6 分钟')).toBe(true)
  await later.unmount()
})

test('ended agents sink', async ($, on) => {
  engine(on)
  const id = await spawn($)
  await $.turn.complete({ ...DONE, reason: 'aborted', isAborted: true, agentId: id })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '已结束')).toBe(true)
  expect(await hasRow(ui, '✗', '🎨', '已停止')).toBe(true)
  expect(await hasRow(ui, 'SubAgent View', '1 失败')).toBe(true)
  expect(await hasRow(ui, '在跑')).toBe(false)
  await ui.unmount()
})

test('resume moves agent back', async ($, on) => {
  engine(on)
  const id = await spawn($)
  await $.turn.complete({ ...DONE, agentId: id })
  await spawn($, { resume: { agentId: id } })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '已结束')).toBe(false)
  expect((await rows(ui)).filter(r => r.includes('出登录页设计稿')).length).toBe(1)
  expect(await hasRow(ui, '1 在跑')).toBe(true)
  await ui.unmount()
})

test('duplicate resume on a running agent keeps its clock', async ($, on) => {
  const { clock } = engine(on)
  const id = await spawn($)
  await clock.advance(65_000)
  await spawn($, { resume: { agentId: id } })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '🎨', '1m05s')).toBe(true)
  await ui.unmount()
})

test('nested and plugin-spawned agents are ignored', async ($, on) => {
  const { replies } = engine(on)
  await spawn($, { parentAgentId: 'p1', description: '嵌套的' })
  replies.nextSpawnedBy = 'other-mod'
  await spawn($, { description: 'mod 派的' })
  await spawn($, { workflow: { runId: 'wf_1', agentIndex: 1 }, description: 'workflow 的' })
  await spawn($, { isTeammate: true, description: 'teammate' })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '这个 session 还没派出 subagent。')).toBe(true)
  await ui.unmount()
})

test('command toggles pane', async ($, on) => {
  const { opened, closed } = engine(on)
  let isOpen: unknown
  on('state.set', { plugin: 'subagent-view', key: 'isOpen' }, (_, e, next) => {
    isOpen = e.value
    return next(e)
  })

  await toggle($)
  expect(opened).toEqual(['subagent-view'])
  expect(isOpen).toBe(true)

  await toggle($)
  expect(closed).toEqual(['subagent-view'])
  expect(isOpen).toBe(false)
})

test('/subagents is immediate and prints nothing', async ($, on) => {
  const { registered } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual([expect.objectContaining({ name: 'subagents', immediate: true })])

  const r = await $.command.run({
    command: 'subagents',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(r.text).toBeUndefined()
})

// 测试的 $ 没有 ui.close，engine 层 hook 也不能调 $.ui.close，无法以 person 身份关闭；
// 借命令发起的关闭走同一条 ui.close 链：engine 收到关闭时 isOpen 已是 false，说明清它的是 ui.close hook（不看 origin）。
test('ui.close hook clears isOpen', async ($, on) => {
  const { closed, isOpenAtClose } = engine(on)
  await toggle($)
  await toggle($)

  expect(closed).toEqual(['subagent-view'])
  expect(isOpenAtClose).toEqual([false])
})

// 开局时 pane 已开着（如 resume 前留下的）：session.start 按 ui.panes 纠正 isOpen，命令据实际状态关闭。
test('session.start syncs isOpen with open panes', async ($, on) => {
  const { opened, closed } = engine(on, { panes: ['subagent-view'] })
  let isOpen: unknown
  on('state.set', { plugin: 'subagent-view', key: 'isOpen' }, (_, e, next) => {
    isOpen = e.value
    return next(e)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(isOpen).toBe(true)

  await toggle($)
  expect(closed).toEqual(['subagent-view'])
  expect(opened).toEqual([])
  expect(isOpen).toBe(false)
})

// /clear 不触发 session.start，只来 classic SessionStart(source: clear)：同样重注册命令、按 ui.panes 纠正 isOpen。
test('after /clear isOpen follows the still-open pane', async ($, on) => {
  const { registered } = engine(on, { panes: ['subagent-view'] })
  on('classic.SessionStart', () => ({}))
  let isOpen: unknown
  on('state.set', { plugin: 'subagent-view', key: 'isOpen' }, (_, e, next) => {
    isOpen = e.value
    return next(e)
  })

  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(isOpen).toBe(true)
  expect(registered).toEqual([expect.objectContaining({ name: 'subagents', immediate: true })])
})

test('session.start without the pane leaves isOpen false', async ($, on) => {
  const { opened } = engine(on)
  let isOpen: unknown
  on('state.set', { plugin: 'subagent-view', key: 'isOpen' }, (_, e, next) => {
    isOpen = e.value
    return next(e)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(isOpen).toBe(false)
  await toggle($)
  expect(opened).toEqual(['subagent-view'])
})

test('self-heal marks a vanished agent ended', async ($, on) => {
  const { replies } = engine(on)
  await spawn($)
  const ui = await $.ui.mount(PANE)
  expect(await hasRow(ui, '已结束')).toBe(false)

  replies.agents = () => []
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(await hasRow(ui, '已结束')).toBe(true)
  expect(await hasRow(ui, '✓', '🎨')).toBe(true)
  await ui.unmount()
})

test('self-heal follows agent.list status', async ($, on) => {
  const { replies } = engine(on)
  const id = await spawn($)
  const ui = await $.ui.mount(PANE)

  replies.agents = () => [{ id, description: 'd', type: 'designer', status: 'failed' }]
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  expect(await hasRow(ui, '✗', '🎨', '失败')).toBe(true)
  await ui.unmount()
})

test('timer stops when state resets', async ($, on) => {
  const { clock } = engine(on)
  let ticks = 0
  let cleared = false
  on('state.set', { plugin: 'subagent-view', key: 'frame' }, (_, e, next) => {
    ticks += 1
    return next(e)
  })
  // 模拟 /clear：打开开关后，本 mod 的 state 都读作缺省（agents 空、isOpen false）。
  on('state.get', { plugin: 'subagent-view' }, (_, e, next) => (cleared ? { value: { value: undefined, version: 0 } } : next(e)))
  await spawn($)
  await toggle($)
  await clock.advance(320)
  expect(ticks).toBe(2)

  // state 回到默认后，下一次 tick 停掉自己。
  cleared = true
  await clock.advance(160)
  const before = ticks
  await clock.advance(1000)
  expect(ticks).toBe(before)
})

test('layout fits bodyColumns', async ($, on) => {
  const { clock } = engine(on)
  const long = '把登录接口拆成三个服务并补上集成测试与文档以及回滚方案和监控告警'
  const a = await spawn($, { description: long })
  await write($, plan(40, 3), a)
  await spawn($, { subagentType: 'Explore', description: '搜索调用点' })
  const c = await spawn($, { subagentType: 'motion-director', description: '打击感时间轴' })
  const d = await spawn($, { subagentType: 'code-reviewer', description: '审查 spec' })
  await write($, plan(6, 2), d)
  const e = await spawn($, { subagentType: 'general-purpose', description: '迁移数据库' })
  await write($, plan(5, 0), e)
  await clock.advance(150_000)
  await $.turn.complete({ ...DONE, agentId: c })
  await $.turn.complete({ ...DONE, reason: 'error', agentId: d })
  const ui = await $.ui.mount(PANE)

  const all = await rows(ui)
  for (const r of all) expect(textWidth(r)).toBeLessThanOrEqual(60)
  // 胶囊截断，但 a/b 保留。
  expect(await hasRow(ui, '3/40', '剩 37 步')).toBe(true)
  expect(await hasRow(ui, long.slice(0, 4), '…')).toBe(true)
  expect(await hasRow(ui, '0/5', '估算中')).toBe(true)
  expect(await hasRow(ui, '✗', '🔍', '停在 2/6')).toBe(true)
  // 分隔线铺满宽度；右侧时长靠右对齐。
  expect(all.some(r => r === '─'.repeat(60))).toBe(true)
  expect(all.filter(r => r.endsWith('2m30s')).length).toBeGreaterThanOrEqual(5)
  for (const r of all.filter(r => r.endsWith('2m30s'))) expect(textWidth(r)).toBe(60)
  await ui.unmount()
})

// 桌面 app 也画同样的 pane；Text 都用 mono，列与 terminal 一样对齐。
test('draws on desktop too', async ($, on) => {
  engine(on)
  const a = await spawn($)
  await write($, plan(7, 3), a)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await hasRow(ui, 'SubAgent View', '1 在跑')).toBe(true)
  expect(await hasRow(ui, '🎨', 'Designer', '出登录页设计稿')).toBe(true)
  expect(await hasRow(ui, '3/7', '剩 4 步')).toBe(true)
  const texts = (await ui.findAll({ type: 'Text' })) as unknown as { props: { mono?: boolean } }[]
  expect(texts.length).toBeGreaterThan(0)
  for (const t of texts) expect(t.props.mono).toBe(true)
  await ui.unmount()
})

for (const surface of ['vscode'] as const) {
  test('other surfaces pass', async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    await spawn($)
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await hasRow(ui, '🎨')).toBe(false)
    await ui.unmount()
  })
}
