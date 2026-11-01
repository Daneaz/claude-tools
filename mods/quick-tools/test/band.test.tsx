import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'quick-tools',
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

type Call = { command: string; args: string }

// 充当 engine：会话模型是 Opus，`turn.step` 不发请求，记下每条命令并按 reply 回输出。
function engine(on: On, reply: (call: Call) => string | undefined = () => undefined): Call[] {
  const calls: Call[] = []
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('command.run', (_, e) => {
    const call = { command: e.command, args: e.args }
    calls.push(call)
    const text = reply(call)

    return text === undefined ? {} : { text }
  })

  return calls
}

// 一次模型请求；model 默认是本 mod 认不出的名字，不影响 status.model。
async function step(
  $: Engine,
  effort: 'low' | 'medium' | 'high',
  { model = 'm', agentId }: { model?: string; agentId?: string } = {},
) {
  const loop = agentId === undefined ? {} : { agentId }
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort, messageCount: 1, ...loop })) {
  }
}

// 会话开始读到 Opus，主循环第一步报 high。
// 人在 prompt 里敲的命令或提交。
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as const

async function start($: Engine) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($, 'high')
}

async function toggleText(ui: { find: (q: { key: string }) => Promise<{ text: string } | undefined> }) {
  return (await ui.find({ key: 'toggle' }))?.text
}

test('collapsed shows the button', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)

  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons).toHaveLength(1)
  expect(buttons[0]?.text).toBe('⚡ Opus · high')
  await ui.unmount()
})

test('press opens the panel', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })

  for (const key of ['fable', 'opus', 'sonnet', 'haiku']) {
    expect(await ui.find({ key: `model-${key}` })).toBeDefined()
  }
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    expect(await ui.find({ key: `effort-${level}` })).toBeDefined()
  }
  expect((await ui.find({ key: 'ultra' }))?.text).toContain('ULTRA')
  expect(await toggleText(ui)).toEndWith(' ▾')

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'model-opus' })).toBeUndefined()
  expect(await toggleText(ui)).toBe('⚡ Opus · high')
  await ui.unmount()
})

test('pick model runs /model', async ($, on) => {
  const calls = engine(on, () => 'Set model to `Sonnet 5.5` and saved as your default for new sessions')
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'model-sonnet' })

  expect(calls).toEqual([{ command: 'model', args: 'sonnet' }])
  expect(await ui.find({ key: 'model-opus' })).toBeDefined()
  // 新模型的 effort 未知，等主循环下一步报上来；subagent 的步不算。
  expect(await toggleText(ui)).toBe('⚡ Sonnet · ? ▾')
  await step($, 'low', { agentId: 'a1', model: 'claude-haiku-5-5' })
  expect(await toggleText(ui)).toBe('⚡ Sonnet · ? ▾')
  await step($, 'medium')
  expect(await toggleText(ui)).toBe('⚡ Sonnet · medium ▾')
  await ui.unmount()
})

test('pick effort runs /effort', async ($, on) => {
  const calls = engine(on, () => 'Set effort level to xhigh (this session only): Deeper reasoning')
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'effort-xhigh' })

  expect(calls).toEqual([{ command: 'effort', args: 'xhigh' }])
  expect(await toggleText(ui)).toBe('⚡ Opus · xhigh ▾')
  await ui.unmount()
})

test('ultra toggles', async ($, on) => {
  const calls = engine(on, ({ args }) =>
    args === 'ultracode on'
      ? 'Ultracode on (this session only): dynamic workflows on every task. Effort stays high.'
      : 'Ultracode off. Effort stays high.',
  )
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'ultra' })
  expect(await toggleText(ui)).toBe('⚡ Opus · high · ✦ ▾')
  await ui.press({ key: 'ultra' })

  expect(calls).toEqual([
    { command: 'effort', args: 'ultracode on' },
    { command: 'effort', args: 'ultracode off' },
  ])
  expect(await toggleText(ui)).toBe('⚡ Opus · high ▾')
  await ui.unmount()
})

test('a press whose command prints nothing applies what was asked', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })

  await ui.press({ key: 'effort-low' })
  expect(await toggleText(ui)).toBe('⚡ Opus · low ▾')
  await ui.press({ key: 'ultra' })
  expect(await toggleText(ui)).toBe('⚡ Opus · low · ✦ ▾')
  await ui.press({ key: 'model-haiku' })
  expect(await toggleText(ui)).toBe('⚡ Haiku · ? · ✦ ▾')
  await ui.unmount()
})

test('a press whose command reports an error changes nothing', async ($, on) => {
  engine(on, () => "Ultracode isn't available on claude-opus-5-5. Valid options are: low, medium")
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'ultra' })

  expect(await toggleText(ui)).toBe('⚡ Opus · high ▾')
  await ui.unmount()
})

test('a press whose command throws changes nothing', async ($, on) => {
  engine(on, () => {
    throw new Error('engine failed')
  })
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'effort-low' })

  expect(await toggleText(ui)).toBe('⚡ Opus · high ▾')
  await ui.unmount()
})

test('press while working runs once', async ($, on) => {
  const calls = engine(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true } })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'effort-max' })

  expect(calls).toEqual([{ command: 'effort', args: 'max' }])
  await ui.unmount()
})

test('typed commands update the button', async ($, on) => {
  engine(on, ({ command }) =>
    command === 'effort'
      ? 'Set effort level to low (saved as your default for new sessions): Quick, straightforward'
      : 'Set model to `Sonnet 5.5` and saved as your default for new sessions',
  )
  await start($)
  const ui = await $.ui.mount(BAND)

  await $.command.run({ ...TYPED, command: 'effort', args: 'low' })
  expect(await toggleText(ui)).toBe('⚡ Opus · low')
  await $.command.run({ ...TYPED, command: 'model', args: 'sonnet' })
  expect(await toggleText(ui)).toBe('⚡ Sonnet · ?')
  await ui.unmount()
})

test('a typed /model that prints nothing is corrected by the next step', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)

  await $.command.run({ ...TYPED, command: 'model', args: 'sonnet' })
  expect(await toggleText(ui)).toBe('⚡ Opus · high')
  await step($, 'medium', { model: 'claude-sonnet-5-5' })
  expect(await toggleText(ui)).toBe('⚡ Sonnet · medium')
  await ui.unmount()
})

test('submit collapses', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await $.prompt.submit({ text: 'hi', wait: false, origin: TYPED.origin })

  expect(await ui.find({ key: 'model-opus' })).toBeUndefined()
  expect(await toggleText(ui)).toBe('⚡ Opus · high')
  await ui.unmount()
})

for (const [name, props, surface] of [
  ['survey yields', { ...BAND.props, hasSurvey: true }, 'terminal'],
  ['other surfaces pass', BAND.props, 'desktop'],
] as const) {
  test(name, async ($, on) => {
    engine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...BAND, props, surface })

    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  })
}

test('narrow band still shows the button', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 24 } })
  await ui.press({ key: 'toggle' })

  expect(await ui.find({ key: 'model-opus' })).toBeDefined()
  expect(await toggleText(ui)).toBe('⚡ Opus · high ▾')
  await ui.unmount()
})

test('pressing the selected model or effort sends nothing', async ($, on) => {
  const calls = engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'model-opus' })
  await ui.press({ key: 'effort-high' })

  expect(calls).toEqual([])
  expect(await toggleText(ui)).toBe('⚡ Opus · high ▾')
  await ui.unmount()
})

const SWITCH = {
  from_model: 'claude-opus-5-5',
  requested_model: null,
  source: 'picker',
  context_tokens: 0,
  prompt_cache_warm: false,
  cache_ttl: '5m',
  estimated_cache_write_usd: 0,
  pricing: 'catalog',
} as const

test('a model switch made elsewhere updates the button', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)

  await $.classic.PostModelSwitch({ ...SWITCH, to_model: 'claude-sonnet-5-5' })
  expect(await toggleText(ui)).toBe('⚡ Sonnet · ?')
  await step($, 'medium')
  expect(await toggleText(ui)).toBe('⚡ Sonnet · medium')
  // 认不出的模型：model 不动，effort 仍未知。
  await $.classic.PostModelSwitch({ ...SWITCH, to_model: 'gpt-4' })
  expect(await toggleText(ui)).toBe('⚡ Sonnet · ?')
  await ui.unmount()
})

test('ULTRA decides on or off from the state at press time', async ($, on) => {
  const calls = engine(on, ({ args }) =>
    args.startsWith('ultracode on') ? 'Ultracode on (this session only): dynamic workflows on every task. Effort stays high.' : undefined,
  )
  await start($)
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'toggle' })
  // 面板画好之后，用户手敲打开了 ultracode。
  await $.command.run({ ...TYPED, command: 'effort', args: 'ultracode on' })
  await ui.press({ key: 'ultra' })

  expect(calls.at(-1)).toEqual({ command: 'effort', args: 'ultracode off' })
  await ui.unmount()
})

test('steps that change nothing write no state', async ($, on) => {
  engine(on)
  let writes = 0
  on('state.set', { plugin: 'quick-tools', key: 'status' }, ($, e, next) => {
    writes += 1

    return next(e)
  })
  await start($)
  const before = writes
  await step($, 'high')
  await step($, 'high', { model: 'claude-opus-5-5' })
  expect(writes).toBe(before)
  await step($, 'low')
  expect(writes).toBe(before + 1)
})

test('the toggle is drawn plain and ULTRA off sits on grey', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ key: 'toggle' }))?.props.plain).toBe(true)
  await ui.press({ key: 'toggle' })

  const ultra = await ui.find({ key: 'ultra' })
  expect(ultra?.children).toEqual([
    expect.objectContaining({ props: expect.objectContaining({ backgroundColor: '#3a3d48', dimColor: true }) }),
  ])
  await ui.unmount()
})

