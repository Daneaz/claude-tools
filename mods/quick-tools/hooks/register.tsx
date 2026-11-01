import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EFFORTS,
  MODELS,
  applyCommandResult,
  buttonLabel,
  modelKeyOf,
  supportedEfforts,
} from './logic'
import type { Status } from './logic'

const PURPLE = '#c792ff'
const INK = '#15161a'
// ULTRA 开时逐字底色，一字一色。
const RAINBOW = [
  '#ff5f8a', '#ff8c64', '#ffb84d', '#e6dc5a', '#7ee787', '#58c4ff', '#78a0ff', '#aa8cff', '#c792ff',
]
const ULTRA = ' ✦ ULTRA '

const status = atom({ plugin: 'quick-tools', key: 'status' } as const, {
  model: null,
  effort: null,
  ultracode: false,
})
const isOpen = atom({ plugin: 'quick-tools', key: 'isOpen' } as const, false)

// 本 mod 自己发的 `$.command.run` 不经过自己的 `command.run` hook，所以按下后自己读输出。
// 交互模式下 `/model` `/effort` 是 local-jsx 命令，输出能否作为 `text` 回来没有验证过：
// 没有输出（且没有 reject）时，按所请求的值更新；有输出就只信输出，认不出的（多半是报错）不动。
async function run(
  $: EngineInterface,
  command: 'model' | 'effort',
  args: string,
  asked: (s: Status) => Status,
) {
  const r = await $.command.run({ command, args }).catch(() => null)
  if (r === null) {
    return // 命令 reject（engine 出错、被拦下）：状态不变。
  }

  const { text } = r
  await update($, status, s => (text ? applyCommandResult(s, command, args, text) : asked(s)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const model = modelKeyOf(await $.session.model())
    await update($, status, s => ({ ...s, model }))

    return next(e)
  })

  // 主循环每一步带着实际的 model 与 effort：开局、切模型后（effort 置 null）、
  // 手敲 `/model` 却没拿到输出时，都从这里校正；认不出的不动。
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const model = modelKeyOf(e.model)
      const level = EFFORTS.find(x => x === e.effort)
      await update($, status, s => ({ ...s, model: model ?? s.model, effort: level ?? s.effort }))
    }

    return yield* next(e)
  })

  // 用户手敲的 `/model` `/effort`。
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    await update($, status, s => applyCommandResult(s, 'model', e.args, r.text ?? ''))

    return r
  })
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    await update($, status, s => applyCommandResult(s, 'effort', e.args, r.text ?? ''))

    return r
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, isOpen, () => false)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, status)
    const open = await read($, isOpen)
    const supported = supportedEfforts(s.model)

    // 选中项紫底深字，其他 dim。
    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) =>
      isOn ? (
        <Button key={key} plain onPress={onPress}>
          <Text backgroundColor={PURPLE} color={INK}>{` ${label} `}</Text>
        </Button>
      ) : (
        <Button key={key} plain dimColor onPress={onPress}>{` ${label} `}</Button>
      )

    const ultracode = !s.ultracode
    const toggleUltra = () =>
      run($, 'effort', `ultracode ${ultracode ? 'on' : 'off'}`, st => ({ ...st, ultracode }))

    return (
      <Box flexDirection="column" alignItems="flex-end">
        {open && (
          <Box borderStyle="round" flexDirection="column" paddingX={1}>
            <Box flexWrap="wrap">
              {MODELS.map(m =>
                chip(`model-${m.key}`, m.label, s.model === m.key, () =>
                  run($, 'model', m.id, st => ({ ...st, model: m.key, effort: null })),
                ),
              )}
            </Box>
            <Box flexWrap="wrap">
              {EFFORTS.map(level => {
                // 当前模型不支持的档：dim，按下不发命令。
                const isLive = supported.includes(level)

                return chip(`effort-${level}`, level, isLive && s.effort === level, () =>
                  isLive ? run($, 'effort', level, st => ({ ...st, effort: level })) : undefined,
                )
              })}
            </Box>
            <Box>
              {s.ultracode ? (
                <Button key="ultra" plain onPress={toggleUltra}>
                  {/* Text 不带 key：描述树没有 reconciliation，surface 会丢掉 Text 的 key。 */}
                  {Array.from(ULTRA).map((ch, i) => (
                    <Text backgroundColor={RAINBOW[i]} color={INK}>{ch}</Text>
                  ))}
                </Button>
              ) : (
                <Button key="ultra" plain dimColor onPress={toggleUltra}>{ULTRA}</Button>
              )}
            </Box>
          </Box>
        )}
        <Button key="toggle" label={buttonLabel(s, open)} onPress={() => update($, isOpen, o => !o)} />
      </Box>
    )
  })
}
