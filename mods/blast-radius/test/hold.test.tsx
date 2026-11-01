// hold 队列、Pane / band 与渲染的测试。
// engine 桩写法同 mods/task-progress/test/band.test.tsx：测试里的 on 都在本 mod 之下，充当 engine。
// 轮询的 `sleep` 桩按 mock clock 走（每次 step 毫秒），而不是立即返回：
// 立即返回时 hold 循环一直占着事件循环，测试 kit 永远等不到 settle（实测会卡死）。
import type { On, PaneOpenArgs } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { holdBash } from '../hooks/register'

const PANE = {
  plugin: 'blast-radius',
  component: 'Pane',
  requestId: 'blast-radius',
  surface: 'terminal',
  props: {
    title: 'Blast Radius',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'blast-radius',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const STEP = 250
// rm 测量脚本的输出：3 个文件、3 KB、1 个路径，随后是文件列表
const RM_OUT = '3 3072 1\n./build/a.js\n./build/b.js\n./build/c.js\n'

type Options = { placed?: boolean; step?: number; rmOut?: string }

// 充当 engine：process.run 按 argv 回固定输出（sleep 按 mock clock 走 step 毫秒），
// ui.open 默认回 isPlaced: true；Bash 调用到达这里就算「跑了」，记进 ran。
// ui.render 是更低层画的 `low`，用来看 band 是否独占。
function engine(on: On, { placed = true, step = STEP, rmOut = RM_OUT }: Options = {}) {
  const clock = mock.clock(on)
  const world = {
    clock,
    ran: [] as string[],
    opened: [] as PaneOpenArgs[],
    closes: 0,
    toasts: [] as string[],
    failOpen: false,
    failSleep: false,
  }
  on('process.run', async (_, e) => {
    const argv = e.argv.join(' ')
    if (e.argv[0] === 'sleep') {
      await clock.sleep(step)
      if (world.failSleep) {
        return { deny: 'sleep failed' }
      }
    }
    let stdout = ''
    if (e.argv[0] === 'bash') stdout = rmOut
    if (argv.startsWith('git status')) stdout = 'M  src/math.js\nA  NOTES.md\n'
    if (argv.startsWith('git diff')) stdout = ' 2 files changed, 2 insertions(+), 1 deletion(-)\n'

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.open', (_, e) => {
    world.opened.push(e)
    if (world.failOpen) {
      return { deny: 'open failed' }
    }

    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow terminal' } }
  })
  on('ui.close', () => {
    world.closes += 1

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') world.ran.push(e.command)

    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="low">
        <Text>x</Text>
      </Box>
    )
  })

  return world
}

type Ui = { find: (q: { key: string }) => Promise<{ text: string; props: Record<string, unknown> } | undefined> }

async function textOf(ui: Ui, key: string) {
  return (await ui.find({ key }))?.text
}

test('harmless passes through', async ($, on) => {
  const w = engine(on)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['ls'])
  expect(w.opened).toEqual([])
})

test('proceed runs', async ($, on) => {
  const w = engine(on)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'br-title')).toContain('⚠ 拦截')
  expect(await textOf(ui, 'br-title')).toContain('rm -rf build')
  expect(await textOf(ui, 'br-summary')).toContain('删除 3 个文件')
  expect(w.opened).toEqual([expect.objectContaining({ id: 'blast-radius', title: 'Blast Radius', focus: true })])
  expect(w.ran).toEqual([])

  await ui.press({ key: 'proceed' })
  await w.clock.advance(STEP)
  const r = await call
  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['rm -rf build'])
  expect(w.toasts).toContain('Blast Radius：放行')
  expect(w.closes).toBe(1)
  await ui.unmount()
})

test('cancel denies', async ($, on) => {
  const w = engine(on)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'cancel' })
  await w.clock.advance(STEP)

  const r = await call
  expect(r.deny ?? '').toContain('the user pressed Cancel')
  expect(r.deny ?? '').toContain('删除 3 个文件')
  expect(r.deny ?? '').toContain('Do not retry it unless the user asks you to')
  expect(w.ran).toEqual([])
  await ui.unmount()
})

test('cancel has focus', async ($, on) => {
  const w = engine(on)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)

  expect((await ui.find({ key: 'cancel' }))?.props.autoFocus).toBe(true)
  expect((await ui.find({ key: 'proceed' }))?.props.autoFocus).toBeUndefined()
  expect((await ui.find({ key: 'cancel' }))?.props.hotkey).toBe('2')
  expect((await ui.find({ key: 'proceed' }))?.props.hotkey).toBe('1')
  await ui.press({ key: 'cancel' })
  await w.clock.advance(STEP)
  await call
  await ui.unmount()
})

// 测试 kit 没法中断一次 tool.call 的 dispatch（next.signal 只在会话里 Esc、上层先结束或超预算时 abort），
// 所以这里直接调用 hook 函数：$ 用最小的假对象，next 带一个自己控制的 AbortSignal。
// 这份 hook 在测试模块自己的实例里跑，held 与插件里加载的那份互不相干。
type HookArgs = Parameters<typeof holdBash>
// 测试运行时有 setTimeout，只是 tsconfig 的 lib 里没有它的类型
declare function setTimeout(callback: (...args: never[]) => void, ms: number): unknown

function fakeHost() {
  const host = { opens: 0, closes: 0 }
  const $ = {
    session: { cwd: async () => '/work' },
    process: {
      run: async (argv: readonly string[]) => {
        // 让出一次真实的事件循环，免得轮询空转占满
        await new Promise(resolve => setTimeout(resolve, 1))

        return { exitCode: 0, stdout: argv[0] === 'bash' ? RM_OUT : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    ui: {
      open: async () => {
        host.opens += 1

        return { isPlaced: true }
      },
      close: async () => {
        host.closes += 1
      },
      invalidate: () => {},
      toast: () => {},
    },
    clock: { now: async () => 0 },
  }

  return { host, $: $ as unknown as HookArgs[0] }
}

function fakeCall(command: string) {
  const abort = new AbortController()
  const call = { ran: false }
  const next = Object.assign(
    async () => {
      call.ran = true

      return { result: {} }
    },
    { signal: abort.signal },
  )

  return { abort, call, e: { tool: 'Bash', command, tool_use_id: command } as unknown as HookArgs[1], next: next as unknown as HookArgs[2] }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  expect(check()).toBe(true)
}

test('interrupt denies', async () => {
  const { host, $ } = fakeHost()

  // 拦着的那条被中断
  const first = fakeCall('rm -rf build')
  const held = holdBash($, first.e, first.next)
  await until(() => host.opens === 1)

  // 排队等着的那条被中断：不等前一条答完就拒绝
  const second = fakeCall('rm -rf dist')
  const queued = holdBash($, second.e, second.next)
  await new Promise(resolve => setTimeout(resolve, 10))
  second.abort.abort()
  const q = await queued
  expect(q.deny ?? '').toContain('interrupted')
  expect(second.call.ran).toBe(false)

  first.abort.abort()
  const r = await held
  expect(r.deny ?? '').toContain('the turn was interrupted')
  expect(r.deny ?? '').toContain('删除 3 个文件')
  expect(first.call.ran).toBe(false)
  expect(host.closes).toBe(1)
  expect(host.opens).toBe(1)
})

test('timeout denies', async ($, on) => {
  // sleep 一次走 100 秒，免得 mock clock 逐个 250ms 推进几千次
  const w = engine(on, { step: 100_000 })
  let isDone = false
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  void call.then(() => {
    isDone = true
  })
  await w.clock.settle()

  // 刚好 10 分钟还不算超时
  await w.clock.advance(600_000)
  expect(isDone).toBe(false)

  await w.clock.advance(100_000)
  const r = await call
  expect(r.deny ?? '').toContain('10 minutes')
  expect(w.ran).toEqual([])
  expect(w.closes).toBe(1)
})

test('error denies', async ($, on) => {
  const w = engine(on)
  w.failOpen = true
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })

  expect(r.deny ?? '').toContain('Blast Radius hit an error while holding it')
  expect(w.ran).toEqual([])

  // 排队时轮询出错（hook 抛出）：.catch 兜底拒绝，命令不跑
  w.failOpen = false
  const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const second = $.tool.call({ tool: 'Bash', command: 'rm -rf dist' })
  await w.clock.settle()
  w.failSleep = true
  await w.clock.advance(STEP)
  expect((await first).deny ?? '').toContain('error')
  expect((await second).deny ?? '').toContain('error')
  expect(w.ran).toEqual([])
})

test('second hold waits', async ($, on) => {
  const w = engine(on)
  const first = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const second = $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
  await w.clock.advance(STEP * 2)
  const ui = await $.ui.mount(PANE)

  // 第一条未决：第二条没有开 pane，pane 上还是第一条
  expect(w.opened.length).toBe(1)
  expect(await textOf(ui, 'br-title')).toContain('rm -rf build')

  // 回答第一条；之后再按一次「执行」（还是第一条画出的按钮），也不会改掉第一条的决定或放行第二条
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'proceed' })
  await w.clock.advance(STEP * 2)
  expect((await first).deny ?? '').toContain('the user pressed Cancel')

  expect(w.opened.length).toBe(2)
  expect(await textOf(ui, 'br-title')).toContain('git reset --hard')
  expect(await textOf(ui, 'br-summary')).toContain('丢弃 2 个文件的未提交改动')
  expect(w.ran).toEqual([])

  await ui.press({ key: 'proceed' })
  await w.clock.advance(STEP)
  expect((await second).deny).toBeUndefined()
  expect(w.ran).toEqual(['git reset --hard'])
  await ui.unmount()
})

test('band when pane not placed', async ($, on) => {
  const w = engine(on, { placed: false })
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const ui = await $.ui.mount(BAND)

  // 独占：只画本 mod 的报告，不组合下层
  expect(await ui.find({ key: 'proceed' })).toBeDefined()
  expect(await textOf(ui, 'br-title')).toContain('⚠ 拦截')
  expect(await ui.find({ key: 'low' })).toBeUndefined()

  await ui.press({ key: 'proceed' })
  await w.clock.advance(STEP)
  expect((await call).deny).toBeUndefined()
  expect(w.ran).toEqual(['rm -rf build'])
  // 放行后 band 还给下层
  expect(await ui.find({ key: 'low' })).toBeDefined()
  expect(await ui.find({ key: 'proceed' })).toBeUndefined()
  await ui.unmount()
})

test('band idle passes through', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ key: 'low' })).toBeDefined()
  expect(await ui.find({ key: 'proceed' })).toBeUndefined()
  await ui.unmount()
})

test('pane draws the report', async ($, on) => {
  const listed = Array.from({ length: 10 }, (_, i) => `./build/f${i}.js`).join('\n')
  const w = engine(on, { rmOut: `12 1153434 1\n${listed}\n` })
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const ui = await $.ui.mount(PANE)

  expect(await textOf(ui, 'br-title')).toBe('▎⚠ 拦截  rm -rf build')
  expect(await textOf(ui, 'br-summary')).toBe('▎▰▰▰▰▰▰▰▰▰▰  删除 12 个文件  1.1 MB')
  expect(await textOf(ui, 'br-line-0')).toBe('▎  − build/f0.js')
  expect(await textOf(ui, 'br-line-9')).toBe('▎  − build/f9.js')
  expect(await textOf(ui, 'br-more')).toBe('▎    … 还有 2 个')
  expect(await textOf(ui, 'br-note')).toBe('▎  路径：build')
  expect(await textOf(ui, 'br-buttons')).toContain('Claude 在等你决定')
  // 与目标同名的路径前缀 dim
  const line = await ui.find({ key: 'br-line-0' })
  expect(JSON.stringify(line?.children)).toContain('"dimColor":true')
  await ui.press({ key: 'cancel' })
  await w.clock.advance(STEP)
  await call
  await ui.unmount()
})

test('band fits maxRows', async ($, on) => {
  const listed = Array.from({ length: 10 }, (_, i) => `./build/f${i}.js`).join('\n')
  const w = engine(on, { placed: false, rmOut: `12 1153434 1\n${listed}\n` })
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await w.clock.settle()
  const maxRows = 9
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows } })

  // 标题、影响、note、空行、按钮、「还有」共 6 行，剩 3 行给列表
  expect(await ui.find({ key: 'br-line-2' })).toBeDefined()
  expect(await ui.find({ key: 'br-line-3' })).toBeUndefined()
  expect(await textOf(ui, 'br-more')).toBe('▎    … 还有 9 个')
  expect(await ui.find({ key: 'proceed' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  await w.clock.advance(STEP)
  await call
  await ui.unmount()
})
