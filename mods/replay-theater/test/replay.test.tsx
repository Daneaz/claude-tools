import type { On, UiOpenResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { textWidth } from '../hooks/logic'

const BAND = {
  plugin: 'replay-theater',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 30,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'replay-theater',
  component: 'Pane',
  requestId: 'replay-theater',
  surface: 'terminal',
  props: {
    title: '回放',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const CWD = '/repo'

// 充当 engine：cwd 固定 /repo；fs 按路径回内容（files 里没有的算不存在）；ui.open 默认放得下；
// AbovePrompt 下层画一个 `low`。
function engine(on: On, { files = {} as Record<string, string> } = {}) {
  const clock = mock.clock(on)
  const replies = {
    open: (): UiOpenResult => ({ isPlaced: true }),
    cwd: (): string => CWD,
    fsRead: (path: string): string => {
      const text = files[path]
      if (text === undefined) throw new Error('ENOENT')
      return text
    },
  }
  const opened: string[] = []
  // 到达 engine（下层）的工具调用数。
  const reached = { tools: 0 }
  // 关掉的 pane id。
  const closed: string[] = []
  on('command.register', () => ({ value: { command: 'replay' } }))
  on('session.cwd', () => ({ value: replies.cwd() }))
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', (_, e) => ({ value: replies.fsRead(e.path) }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: replies.open() }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('tool.call', () => {
    reached.tools += 1

    return { result: {} }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="low">
        <Text>x</Text>
      </Box>
    )
  })

  return { clock, replies, opened, reached, closed }
}

const DONE = { answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' } as const

async function startTurn($: Engine, agentId?: string) {
  await $.turn.start({ text: 'go', turnId: 't', ...(agentId === undefined ? {} : { agentId }) })
}

async function edit($: Engine, file: string, oldText = 'a', newText = 'b', agentId?: string) {
  await $.tool.call({
    tool: 'Edit',
    file_path: `${CWD}/${file}`,
    old_string: oldText,
    new_string: newText,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

async function writeFile($: Engine, file: string, content: string) {
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/${file}`, content })
}

// 一轮主循环：2 次 Edit（同一文件）+ 1 次 Write（新文件）。
async function threeEdits($: Engine) {
  await startTurn($)
  await edit($, 'src/a.ts')
  await edit($, 'src/a.ts', 'x', 'y')
  await writeFile($, 'b.ts', 'new\n')
  await $.turn.complete(DONE)
}

// /replay：打开前要等 200ms，推着 mock 时钟走完。
async function replay($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  const run = $.command.run({
    command: 'replay',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  })
  await clock.advance(200)

  return run
}

type Ui = { find: (q: { key: string }) => Promise<{ text: string } | undefined> }

async function textOf(ui: Ui, key: string) {
  return (await ui.find({ key }))?.text
}

async function boxKeys(ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }) {
  return (await ui.findAll({ type: 'Box' })).map(b => b.key ?? '')
}

test('records edits per turn', async ($, on) => {
  engine(on)
  await threeEdits($)
  const ui = await $.ui.mount(BAND)

  const hint = (await textOf(ui, 'rt-hint')) ?? ''
  expect(hint).toContain('▶ 回放')
  expect(hint).toContain('▰▰▰')
  expect(hint).toContain('3 处编辑')
  expect(hint).toContain('2 个文件')
  expect(hint).toContain('点击或 /replay')
  await ui.unmount()
})

test('no hint before any edits', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ key: 'rt-hint' })).toBeUndefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('hint keeps lower', async ($, on) => {
  engine(on)
  await threeEdits($)
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ key: 'rt-hint' })).toBeDefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('quiet on survey', async ($, on) => {
  engine(on)
  await threeEdits($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })

  expect(await ui.find({ key: 'rt-hint' })).toBeUndefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('hint button has no hotkey', async ($, on) => {
  engine(on)
  await threeEdits($)
  const ui = await $.ui.mount(BAND)

  const button = (await ui.find({ key: 'rt-open' })) as { props?: Record<string, unknown> } | undefined
  expect(button).toBeDefined()
  expect(button?.props).toBeDefined()
  expect(button?.props?.plain).toBe(true)
  expect('hotkey' in (button?.props ?? {})).toBe(false)
  await ui.unmount()
})

test('hint pills cap at 10', async ($, on) => {
  engine(on)
  await startTurn($)
  for (let i = 0; i < 14; i++) await edit($, `f${i}.ts`)
  await $.turn.complete(DONE)
  const ui = await $.ui.mount(BAND)

  const hint = (await textOf(ui, 'rt-hint')) ?? ''
  expect(hint).toContain(`${'▰'.repeat(10)}+4`)
  expect(hint).toContain('14 处编辑')
  await ui.unmount()
})

test('replay command opens', async ($, on) => {
  const { clock, opened } = engine(on)
  expect((await replay($, clock)).text).toBe('回放：上一轮没有编辑')
  expect(opened).toEqual([])

  await threeEdits($)
  expect((await replay($, clock)).text).toBe('回放：3 处编辑')
  expect(opened).toEqual(['replay-theater'])
})

test('steps navigate', async ($, on) => {
  const { clock } = engine(on)
  await threeEdits($)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'rt-title')).toContain('1/3')
  expect(await textOf(ui, 'rt-title')).toContain('2 个文件')
  await ui.press({ key: 'next' })
  expect(await textOf(ui, 'rt-title')).toContain('2/3')
  expect(await textOf(ui, 'rt-step-0')).toContain('✓')
  expect(await textOf(ui, 'rt-step-1')).toContain('›')
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(await textOf(ui, 'rt-title')).toContain('3/3')
  await ui.press({ key: 'prev' })
  expect(await textOf(ui, 'rt-title')).toContain('2/3')
  await ui.unmount()
})

test('cjk file names align', async ($, on) => {
  const { clock } = engine(on)
  await startTurn($)
  await edit($, '文档/说明.md')
  await edit($, 'src/a.ts')
  await $.turn.complete(DONE)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  const before = async (key: string) => textWidth(((await textOf(ui, key)) ?? '').split('Edit')[0] ?? '')
  expect(await textOf(ui, 'rt-step-0')).toContain('文档/说明.md')
  expect(await before('rt-step-0')).toBe(await before('rt-step-1'))
  await ui.unmount()
})

test('step row columns', async ($, on) => {
  const { clock } = engine(on)
  await threeEdits($)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  const row0 = (await textOf(ui, 'rt-step-0')) ?? ''
  const row2 = (await textOf(ui, 'rt-step-2')) ?? ''
  expect(row0).toContain('src/a.ts')
  expect(row0).toContain('Edit')
  expect(row0).toContain('+1 −1')
  expect(row2).toContain('b.ts')
  expect(row2).toContain('Write')
  // 工具列对齐。
  expect(row0.indexOf('Edit')).toBe(row2.indexOf('Write'))
  // diff 第一步：删 a 加 b，前缀与文件名列对齐（缩进 5）。
  expect(await textOf(ui, 'rt-diff-0')).toBe('     − a')
  expect(await textOf(ui, 'rt-diff-1')).toBe('     + b')
  await ui.unmount()
})

test('diff caps at 12', async ($, on) => {
  const { clock } = engine(on)
  const lines = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  await startTurn($)
  await writeFile($, 'big.ts', lines)
  await $.turn.complete(DONE)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  const keys = (await boxKeys(ui)).filter(k => /^rt-diff-\d+$/.test(k))
  expect(keys.length).toBe(12)
  expect(await textOf(ui, 'rt-diff-more')).toContain('… 还有 8 行')
  await ui.unmount()
})

test('multiedit one step per edit', async ($, on) => {
  const { clock } = engine(on)
  await startTurn($)
  // 本 build 的工具表里没有 MultiEdit，入参按松散对象传。
  await $.tool.call({
    tool: 'MultiEdit',
    file_path: `${CWD}/m.ts`,
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
      { old_string: 'e', new_string: 'f' },
    ],
  } as never)
  await $.turn.complete(DONE)
  expect((await replay($, clock)).text).toBe('回放：3 处编辑')
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'rt-title')).toContain('1/3')
  expect(await textOf(ui, 'rt-step-0')).toContain('第 1/3 处')
  expect(await textOf(ui, 'rt-step-2')).toContain('第 3/3 处')
  await ui.unmount()
})

test('notes', async ($, on) => {
  const { clock } = engine(on, { files: { [`${CWD}/old.ts`]: 'x\n' } })
  await startTurn($)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/r.ts`, old_string: 'a', new_string: 'b', replace_all: true })
  await writeFile($, 'old.ts', 'y\n')
  await writeFile($, 'new.ts', 'y\n')
  await $.turn.complete(DONE)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'rt-step-0')).toContain('全部替换')
  expect(await textOf(ui, 'rt-step-1')).toContain('重写')
  expect(await textOf(ui, 'rt-step-2')).toContain('新文件')
  await ui.unmount()
})

test('no line changes', async ($, on) => {
  const { clock } = engine(on)
  await startTurn($)
  await edit($, 'same.ts', '', '')
  await $.turn.complete(DONE)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'rt-diff-empty')).toContain('（无行变化）')
  await ui.unmount()
})

test('recording error still passes', async ($, on) => {
  const { replies, reached } = engine(on, { files: { [`${CWD}/x.ts`]: 'old' } })
  replies.fsRead = () => {
    throw new Error('boom')
  }
  await startTurn($)
  await writeFile($, 'x.ts', 'new')
  await $.turn.complete(DONE)

  expect(reached.tools).toBe(1)
})

test('cwd error still passes', async ($, on) => {
  const { replies, reached, clock } = engine(on)
  replies.cwd = () => {
    throw new Error('boom')
  }
  await startTurn($)
  await edit($, 'a.ts')
  await $.turn.complete(DONE)
  expect(reached.tools).toBe(1)
  // 拿不到 cwd 时保留完整路径。
  await replay($, clock)
  const ui = await $.ui.mount(PANE)
  expect(await textOf(ui, 'rt-step-0')).toContain('/repo/a.ts')
  await ui.unmount()
})

test('subagent edits join main turn', async ($, on) => {
  const { clock } = engine(on)
  await startTurn($)
  await edit($, 'main.ts')
  await startTurn($, 'a1')
  await edit($, 'sub.ts', 'a', 'b', 'a1')
  await $.turn.complete({ ...DONE, agentId: 'a1' })
  await $.turn.complete(DONE)
  expect((await replay($, clock)).text).toBe('回放：2 处编辑')
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'rt-step-1')).toContain('sub.ts')
  await ui.unmount()
})

test('empty turn keeps replay', async ($, on) => {
  engine(on)
  await threeEdits($)
  await startTurn($)
  await $.turn.complete(DONE)
  const ui = await $.ui.mount(BAND)

  expect(await textOf(ui, 'rt-hint')).toContain('3 处编辑')
  await ui.unmount()
})

test('new turn replaces replay', async ($, on) => {
  engine(on)
  await threeEdits($)
  await startTurn($)
  await edit($, 'z.ts')
  await $.turn.complete(DONE)
  const ui = await $.ui.mount(BAND)

  expect(await textOf(ui, 'rt-hint')).toContain('1 处编辑')
  await ui.unmount()
})

test('band replay keeps lower', async ($, on) => {
  const { clock, replies } = engine(on)
  replies.open = () => ({ isPlaced: false, reason: 'no-room' }) as UiOpenResult
  await threeEdits($)
  await replay($, clock)
  const ui = await $.ui.mount(BAND)

  expect(await textOf(ui, 'rt-title')).toContain('1/3')
  expect(await ui.find({ key: 'low' })).toBeDefined()
  expect(await ui.find({ key: 'rt-hint' })).toBeUndefined()
  await ui.press({ key: 'close' })
  expect(await ui.find({ key: 'rt-title' })).toBeUndefined()
  expect(await ui.find({ key: 'rt-hint' })).toBeDefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('band replay shrinks to maxRows', async ($, on) => {
  const { clock, replies } = engine(on)
  replies.open = () => ({ isPlaced: false, reason: 'no-room' }) as UiOpenResult
  await startTurn($)
  for (let i = 0; i < 10; i++) await writeFile($, `f${i}.ts`, Array.from({ length: 20 }, (_, k) => `l${k}`).join('\n'))
  await $.turn.complete(DONE)

  // 回放 view 的行：标题、清单行与省略行、diff 行与「还有」行、按钮，加 3 个空行。
  const viewRows = (keys: string[]) =>
    keys.filter(k => /^rt-(title|step-\d+|more-(above|below)|diff-.+|buttons)$/.test(k)).length + 3
  // 给下层留 3 行：view ≤ maxRows - 3。最小 view 是 12 行（固定 5 + 清单 3 + diff 3 + 「还有」1），
  // maxRows = 12 时扣完不够，按最小 view 画（12 行），这时只保证不小于最小值。
  const MIN_VIEW = 12
  for (const maxRows of [12, 15, 19, 27]) {
    await replay($, clock)
    const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows } })
    // 第 1 步（只有下省略行）与中间一步（上下都有省略行）都要放得下。
    for (const at of [0, 5]) {
      while (!(await textOf(ui, 'rt-title'))?.includes(`${at + 1}/10`)) await ui.press({ key: 'next' })
      const keys = await boxKeys(ui)
      expect(viewRows(keys)).toBeLessThanOrEqual(Math.max(maxRows - 3, MIN_VIEW))
      if (maxRows - 3 < MIN_VIEW) expect(viewRows(keys)).toBe(MIN_VIEW)
      expect(keys.filter(k => /^rt-diff-\d+$/.test(k)).length).toBeGreaterThanOrEqual(3)
      expect(keys.filter(k => /^rt-(step-\d+|more-(above|below))$/.test(k)).length).toBeGreaterThanOrEqual(3)
      expect(keys).toContain(`rt-step-${at}`)
      expect(keys).toContain('rt-diff-more')
      expect(await ui.find({ key: 'low' })).toBeDefined()
    }
    if (maxRows === 27) {
      // 宽裕时清单 7 步。
      expect((await boxKeys(ui)).filter(k => /^rt-step-\d+$/.test(k)).length).toBe(7)
    }
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
})

test('pane hides hint', async ($, on) => {
  const { clock } = engine(on)
  await threeEdits($)
  await replay($, clock)
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ key: 'rt-hint' })).toBeUndefined()
  expect(await ui.find({ key: 'low' })).toBeDefined()
  await ui.unmount()
})

test('close button syncs state', async ($, on) => {
  const { clock, closed } = engine(on)
  await threeEdits($)
  await replay($, clock)
  const band = await $.ui.mount(BAND)
  const pane = await $.ui.mount(PANE)
  expect(await band.find({ key: 'rt-hint' })).toBeUndefined()

  // 测试 kit 的 $ 没有 ui.close，无法模拟用户按 Esc（engine 发的 ui.close）；mod 自己的 $.ui.close
  // 又不经过它自己的 ui.close hook。这里只验证「关闭」按钮：发出 ui.close，band 回到提示。
  await pane.press({ key: 'close' })
  expect(closed).toEqual(['replay-theater'])
  expect(await band.find({ key: 'rt-hint' })).toBeDefined()
  await pane.unmount()
  await band.unmount()
})

test('long step list keeps current visible', async ($, on) => {
  const { clock } = engine(on)
  await startTurn($)
  for (let i = 0; i < 12; i++) await edit($, `f${i}.ts`)
  await $.turn.complete(DONE)
  await replay($, clock)
  const ui = await $.ui.mount(PANE)

  for (let i = 0; i < 11; i++) await ui.press({ key: 'next' })
  expect(await textOf(ui, 'rt-title')).toContain('12/12')
  const keys = (await boxKeys(ui)).filter(k => /^rt-step-\d+$/.test(k))
  expect(keys.length).toBe(7)
  expect(keys).toContain('rt-step-11')
  expect(await textOf(ui, 'rt-more-above')).toContain('… 5 步')
  // 胶囊窗口跟随当前步：当前步（紫）仍画出，没有没看的。
  expect(await textOf(ui, 'rt-title')).toContain('▰'.repeat(10))
  expect(await textOf(ui, 'rt-title')).not.toContain('▱')
  await ui.unmount()
})
