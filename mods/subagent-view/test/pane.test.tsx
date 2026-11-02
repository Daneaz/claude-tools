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

// 充当 engine：agent.spawn 依次发 a1、a2、…（resume 时沿用原 id）；agent.list 默认列出派过的、都在运行，
// 可由测试换掉；ui.open / ui.close 记下收到的 id。
// panes：engine 记录的、本 plugin 开着的 pane（ui.open 加入、ui.close 移除），可由测试预置。
// language：settings 里的 `language`（null = 未设置）；默认中文，现有断言都按中文写。
function engine(on: On, { panes = [] as string[], language = '中文' as string | null } = {}) {
  const clock = mock.clock(on)
  on('settings.read', () => ({ value: language === null ? {} : { language } }))
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
  // Bash 的 command 为 'deny' 时拒绝，为 'fail' 时报错；其余一律答空结果。
  on('tool.call', (_, e) => {
    const command = (e as unknown as { command?: unknown }).command
    if (command === 'deny') return { deny: 'no' }
    if (command === 'fail') return { result: {}, isError: true }
    return { result: {} }
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

// 按任意工具的输入传（Read、Grep 等不一定在 tool.call 的类型表里）。
async function call($: Engine, tool: string, input: Record<string, unknown>, agentId?: string) {
  await $.tool.call({ tool, ...input, ...(agentId === undefined ? {} : { agentId }) } as unknown as Parameters<
    Engine['tool']['call']
  >[0])
}

// 第 2 行：缩进之后的工作条。
const BAR = /[▰▱]{10}/
const litCount = (row: string) => [...(row.match(BAR)?.[0] ?? '')].filter(c => c === '▰').length

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

test('main loop tool calls are not counted', async ($, on) => {
  engine(on)
  await spawn($)
  await call($, 'Read', { file_path: '/x/main.ts' })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '› 启动中')).toBe(true)
  expect(await hasRow(ui, 'main.ts')).toBe(false)
  expect(await hasRow(ui, '次工具')).toBe(false)
  await ui.unmount()
})

test('running agent shows sweep bar, last tool and count', async ($, on) => {
  engine(on)
  const id = await spawn($, { subagentType: 'general-purpose', description: '实现登录接口' })
  await call($, 'Read', { file_path: '/x/logic.ts' }, id)
  await call($, 'Read', { file_path: '/x/logic.ts' }, id)
  const ui = await $.ui.mount(PANE)

  const all = await rows(ui)
  const i = all.findIndex(r => r.includes('实现登录接口'))
  const line2 = all[i + 1] ?? ''
  expect(line2.startsWith('   ')).toBe(true)
  expect(BAR.test(line2)).toBe(true)
  expect(litCount(line2)).toBe(3)
  expect(line2.includes('› Read logic.ts')).toBe(true)
  expect(line2.includes('2 次工具')).toBe(true)
  await ui.unmount()
})

test('agent with no tool calls shows 启动中 without count', async ($, on) => {
  engine(on)
  await spawn($)
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '› 启动中')).toBe(true)
  expect(await hasRow(ui, '次工具')).toBe(false)
  await ui.unmount()
})

test('denied call is not counted; errored call is', async ($, on) => {
  engine(on)
  const id = await spawn($)
  await call($, 'Grep', { pattern: 'useAuth' }, id)
  await call($, 'Bash', { command: 'deny', description: '被拒的' }, id)
  const ui = await $.ui.mount(PANE)
  expect(await hasRow(ui, '› Grep "useAuth"', '1 次工具')).toBe(true)
  expect(await hasRow(ui, '被拒的')).toBe(false)
  await ui.unmount()

  await call($, 'Bash', { command: 'fail', description: '跑测试' }, id)
  const later = await $.ui.mount(PANE)
  expect(await hasRow(later, '› Bash 跑测试', '2 次工具')).toBe(true)
  await later.unmount()
})

test('sweep bar is dropped when it would squeeze the activity text', async ($, on) => {
  engine(on)
  const id = await spawn($)
  await call($, 'Read', { file_path: '/x/a.ts' }, id)
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 20 } })
  const all = await rows(narrow)
  expect(all.some(r => /[▰▱]/.test(r))).toBe(false)
  // 第 2 行不超宽（第 1 行的 avatar + 名称 + 时长在 20 列下本就放不下，v1 起如此，不在本次范围）。
  const line2 = all.find(r => r.includes('› Read')) ?? ''
  expect(line2.includes('1 次工具')).toBe(true)
  expect(textWidth(line2)).toBeLessThanOrEqual(20)
  await narrow.unmount()

  // 24 列：工作条 + 次数之后只剩 0 列给「› Read …」，宁可不画工作条。
  const tight = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
  const tightRows = await rows(tight)
  expect(tightRows.some(r => /[▰▱]/.test(r))).toBe(false)
  expect(tightRows.some(r => r.includes('› Read'))).toBe(true)
  await tight.unmount()

  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  const wideRows = await rows(wide)
  expect(wideRows.some(r => BAR.test(r))).toBe(true)
  expect(wideRows.some(r => r.includes('› Read a.ts'))).toBe(true)
  await wide.unmount()
})

test('ended row shows call count or 失败/已停止', async ($, on) => {
  engine(on)
  const a = await spawn($, { description: '做了三次' })
  await call($, 'Read', { file_path: '/x/a.ts' }, a)
  await call($, 'Read', { file_path: '/x/a.ts' }, a)
  await call($, 'Read', { file_path: '/x/a.ts' }, a)
  const b = await spawn($, { description: '没调工具' })
  const c = await spawn($, { description: '出错了' })
  const d = await spawn($, { description: '被停了' })
  await $.turn.complete({ ...DONE, agentId: a })
  await $.turn.complete({ ...DONE, agentId: b })
  await $.turn.complete({ ...DONE, reason: 'error', agentId: c })
  await $.turn.complete({ ...DONE, reason: 'aborted', isAborted: true, agentId: d })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, '✓', '做了三次', '3 次')).toBe(true)
  const none = (await rows(ui)).find(r => r.includes('没调工具')) ?? ''
  expect(none.startsWith('✓')).toBe(true)
  expect(none.includes('次')).toBe(false)
  expect(await hasRow(ui, '✗', '出错了', '失败')).toBe(true)
  expect(await hasRow(ui, '✗', '被停了', '已停止')).toBe(true)
  expect((await rows(ui)).some(r => /[▰▱]/.test(r))).toBe(false)
  await ui.unmount()
})

test('overview line', async ($, on) => {
  engine(on)
  await spawn($)
  await spawn($, { subagentType: 'general-purpose', description: '实现登录接口' })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, 'SubAgent View', '2 在跑')).toBe(true)
  expect(await hasRow(ui, '合计剩余')).toBe(false)
  expect(await hasRow(ui, '剩余时间')).toBe(false)
  await ui.unmount()
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
  await call($, 'Bash', { description: '跑一个名字非常非常长的集成测试套件并收集覆盖率报告' }, a)
  await spawn($, { subagentType: 'Explore', description: '搜索调用点' })
  const c = await spawn($, { subagentType: 'motion-director', description: '打击感时间轴' })
  await call($, 'Read', { file_path: '/x/timeline.ts' }, c)
  const d = await spawn($, { subagentType: 'code-reviewer', description: '审查 spec' })
  await call($, 'Read', { file_path: '/x/spec.md' }, d)
  const e = await spawn($, { subagentType: 'general-purpose', description: '迁移数据库' })
  await call($, 'Grep', { pattern: 'migrate' }, e)
  await clock.advance(150_000)
  await $.turn.complete({ ...DONE, agentId: c })
  await $.turn.complete({ ...DONE, reason: 'error', agentId: d })
  const ui = await $.ui.mount(PANE)

  const all = await rows(ui)
  for (const r of all) expect(textWidth(r)).toBeLessThanOrEqual(60)
  // 说明与简短参数截断，但次数保留并靠右。
  expect(await hasRow(ui, long.slice(0, 4), '…')).toBe(true)
  expect(await hasRow(ui, '› Bash', '…', '1 次工具')).toBe(true)
  expect(all.filter(r => r.endsWith('次工具')).length).toBe(2)
  for (const r of all.filter(r => r.endsWith('次工具'))) expect(textWidth(r)).toBe(60)
  expect(await hasRow(ui, '✓', '🎬', '1 次')).toBe(true)
  expect(await hasRow(ui, '✗', '🔍', '失败')).toBe(true)
  // 分隔线铺满宽度；右侧时长靠右对齐。
  expect(all.some(r => r === '─'.repeat(60))).toBe(true)
  expect(all.filter(r => r.endsWith('2m30s')).length).toBeGreaterThanOrEqual(5)
  for (const r of all.filter(r => r.endsWith('2m30s'))) expect(textWidth(r)).toBe(60)
  await ui.unmount()

  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 } })
  for (const r of await rows(narrow)) expect(textWidth(r)).toBeLessThanOrEqual(40)
  expect((await rows(narrow)).some(r => /[▰▱]{10}/.test(r))).toBe(true)
  await narrow.unmount()
})

// 桌面 app 也画同样的 pane；Text 都用 mono，列与 terminal 一样对齐。
test('draws on desktop too', async ($, on) => {
  engine(on)
  const a = await spawn($)
  await call($, 'Read', { file_path: '/x/login.html' }, a)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await hasRow(ui, 'SubAgent View', '1 在跑')).toBe(true)
  expect(await hasRow(ui, '🎨', 'Designer', '出登录页设计稿')).toBe(true)
  expect(await hasRow(ui, '› Read login.html', '1 次工具')).toBe(true)
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

test('english when settings language is not chinese', async ($, on) => {
  engine(on, { language: 'English' })
  const a = await spawn($, { description: 'login page' })
  await call($, 'Read', { file_path: '/x/a.ts' }, a)
  await call($, 'Read', { file_path: '/x/b.ts' }, a)
  await spawn($, { subagentType: 'Explore', description: 'search' })
  const b = await spawn($, { description: 'one call' })
  await call($, 'Read', { file_path: '/x/a.ts' }, b)
  const c = await spawn($, { description: 'broke' })
  const d = await spawn($, { description: 'halted' })
  await $.turn.complete({ ...DONE, agentId: b })
  await $.turn.complete({ ...DONE, reason: 'error', agentId: c })
  await $.turn.complete({ ...DONE, reason: 'aborted', isAborted: true, agentId: d })
  const ui = await $.ui.mount(PANE)

  expect(await hasRow(ui, 'SubAgent View', '2 running', '1 done', '2 failed')).toBe(true)
  expect(await hasRow(ui, '› Read b.ts', '2 tool calls')).toBe(true)
  expect(await hasRow(ui, '› starting')).toBe(true)
  expect(await hasRow(ui, 'Ended')).toBe(true)
  expect(await hasRow(ui, '✓', 'one call', '1 call')).toBe(true)
  expect(await hasRow(ui, '✗', 'broke', 'failed')).toBe(true)
  expect(await hasRow(ui, '✗', 'halted', 'stopped')).toBe(true)
  expect((await rows(ui)).some(r => /[\u4e00-\u9fff]/.test(r))).toBe(false)
  await ui.unmount()
})

test('english empty pane when settings has no language', async ($, on) => {
  engine(on, { language: null })
  const ui = await $.ui.mount(PANE)
  expect(await hasRow(ui, 'No subagents in this session yet.')).toBe(true)
  expect(await hasRow(ui, 'They show up here once dispatched.')).toBe(true)
  await ui.unmount()
})

test('one running call reads singular', async ($, on) => {
  engine(on, { language: 'English' })
  const a = await spawn($)
  await call($, 'Read', { file_path: '/x/a.ts' }, a)
  const ui = await $.ui.mount(PANE)
  expect(await hasRow(ui, '› Read a.ts', '1 tool call')).toBe(true)
  expect(await hasRow(ui, '1 tool calls')).toBe(false)
  await ui.unmount()
})
