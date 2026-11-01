import { expect, test } from 'claude-code/testing'

import {
  EFFORTS,
  MODELS,
  applyCommandResult,
  buttonLabel,
  modelKeyOf,
  supportedEfforts,
} from '../hooks/logic'
import type { Status } from '../hooks/logic'

const OPUS_HIGH: Status = { model: 'opus', effort: 'high', ultracode: false }

test('modelKeyOf reads ids, aliases and display names', async () => {
  expect(modelKeyOf('claude-opus-5-5')).toBe('opus')
  expect(modelKeyOf('Sonnet 5.5')).toBe('sonnet')
  expect(modelKeyOf('haiku')).toBe('haiku')
  expect(modelKeyOf('gpt-4')).toBeNull()
})

test('MODELS send aliases, which modelKeyOf reads back', async () => {
  expect(MODELS.map(m => m.alias)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  for (const m of MODELS) {
    expect(modelKeyOf(m.alias)).toBe(m.key)
  }
})

test('effort output sets the level', async () => {
  const text =
    'Set effort level to xhigh (saved as your default for new sessions): Deeper reasoning than high, just below maximum (on supported models)'
  expect(applyCommandResult(OPUS_HIGH, 'effort', 'xhigh', text)).toEqual({
    ...OPUS_HIGH,
    effort: 'xhigh',
  })
})

test('ultracode on and off', async () => {
  const on = applyCommandResult(
    OPUS_HIGH,
    'effort',
    'ultracode on',
    'Ultracode on (this session only): dynamic workflows on every task. Effort stays high.',
  )
  expect(on).toEqual({ ...OPUS_HIGH, ultracode: true })

  const off = applyCommandResult(
    { ...OPUS_HIGH, ultracode: true },
    'effort',
    'ultracode off',
    'Ultracode off. Effort stays medium.',
  )
  expect(off).toEqual({ model: 'opus', effort: 'medium', ultracode: false })
})

test('model output sets the model', async () => {
  // effort 按模型分开存，`/model` 的输出不带 effort：置 null，等下一次 turn.step 填。
  const saved = applyCommandResult(
    OPUS_HIGH,
    'model',
    'sonnet',
    'Set model to `Sonnet 5.5` and saved as your default for new sessions',
  )
  expect(saved).toEqual({ ...OPUS_HIGH, model: 'sonnet', effort: null })

  const sessionOnly = applyCommandResult(
    OPUS_HIGH,
    'model',
    'haiku',
    'Set model to `Haiku 5.5` for this session only',
  )
  expect(sessionOnly).toEqual({ ...OPUS_HIGH, model: 'haiku', effort: null })
})

test('effort auto, clamped, and a kept model', async () => {
  expect(
    applyCommandResult(OPUS_HIGH, 'effort', 'auto', 'Effort level set to auto (this session only)'),
  ).toEqual({ ...OPUS_HIGH, effort: null })

  const clamped =
    "Effort 'max' exceeds the cap for claude-opus-5-5 set by your settings or organization; set to 'xhigh' instead (this session only): Deeper reasoning than high"
  expect(applyCommandResult(OPUS_HIGH, 'effort', 'max', clamped)).toEqual({
    ...OPUS_HIGH,
    effort: 'xhigh',
  })

  expect(applyCommandResult(OPUS_HIGH, 'model', 'opus', 'Kept model as `Opus 5.5`')).toBe(
    OPUS_HIGH,
  )
})

test('ANSI codes and leading whitespace are ignored', async () => {
  expect(
    applyCommandResult(
      OPUS_HIGH,
      'effort',
      'low',
      '  \u001b[2mSet effort level to \u001b[1mlow\u001b[22m (this session only): Quick',
    ),
  ).toEqual({ ...OPUS_HIGH, effort: 'low' })

  expect(
    applyCommandResult(
      OPUS_HIGH,
      'model',
      'haiku',
      '\n\u001b[1mSet model to `Haiku 5.5`\u001b[22m for this session only',
    ),
  ).toEqual({ ...OPUS_HIGH, model: 'haiku', effort: null })
})

test('unrecognised output leaves state alone', async () => {
  const errors: [command: 'model' | 'effort', args: string, text: string][] = [
    [
      'effort',
      'bogus',
      'Invalid argument: bogus. Valid options are: low, medium, high, xhigh, max, auto, ultracode [on|off]',
    ],
    [
      'effort',
      'ultracode on',
      "Ultracode isn't available on claude-haiku-5-5. Valid options are: low, medium, high, xhigh, max, auto",
    ],
    ['model', 'gpt-4', 'Unable to validate model: gpt-4 not found'],
    ['effort', 'xhigh', 'Set model to `Sonnet 5.5` for this session only'],
  ]
  for (const [command, args, text] of errors) {
    expect(applyCommandResult(OPUS_HIGH, command, args, text)).toBe(OPUS_HIGH)
  }
})

test('an effort change that turns ultracode off says so', async () => {
  const ULTRA_HIGH: Status = { ...OPUS_HIGH, ultracode: true }
  expect(
    applyCommandResult(
      ULTRA_HIGH,
      'effort',
      'low',
      'Set effort level to low (this session only): Quick, straightforward · Ultracode off',
    ),
  ).toEqual({ ...OPUS_HIGH, effort: 'low', ultracode: false })
  expect(
    applyCommandResult(ULTRA_HIGH, 'effort', 'auto', 'Effort level set to auto (this session only) · Ultracode off'),
  ).toEqual({ ...OPUS_HIGH, effort: null, ultracode: false })
  expect(
    applyCommandResult(OPUS_HIGH, 'effort', 'max', 'Set effort level to max (this session only): Maximum · Ultracode on'),
  ).toEqual({ ...OPUS_HIGH, effort: 'max', ultracode: true })
})

test('buttonLabel', async () => {
  expect(buttonLabel({ model: 'opus', effort: 'high', ultracode: false }, false)).toBe(
    '⚡ Opus · high',
  )
  expect(buttonLabel({ model: 'opus', effort: 'high', ultracode: true }, true)).toBe(
    '⚡ Opus · high · ✦ ▾',
  )
  expect(buttonLabel({ model: null, effort: null, ultracode: false }, false)).toBe('⚡ ? · ?')
})

test('supportedEfforts: every 2.1.316 model takes all five levels', async () => {
  expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  for (const { key } of MODELS) {
    expect(supportedEfforts(key)).toEqual(EFFORTS)
  }
  expect(supportedEfforts(null)).toEqual(EFFORTS)
})
