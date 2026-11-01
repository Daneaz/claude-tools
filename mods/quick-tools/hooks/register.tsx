import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EFFORTS,
  MODELS,
  applyCommandResult,
  buttonLabel,
  modelKeyOf,
  savedEffort,
  supportedEfforts,
} from './logic'
import type { Status } from './logic'

const PURPLE = '#c792ff'
const INK = '#15161a'
// ULTRA 关时的灰底。
const GREY = '#3a3d48'
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

// `$.command.run` 只跳过发起调用的那个 hook；onPress 不是 hook，所以这里的调用照常经过本 mod 的
// `command.run` hook。hook 和这里都按同一份输出写 state，结果相同，重复写无害；这里另外处理没有输出时的兜底。
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
  await fillSavedEffort($)
}

// effort 未知时（开局、切模型后）先用 settings 里该模型存的档位，下一步主循环再按实际值校正。
async function fillSavedEffort($: EngineInterface) {
  const s = await read($, status)
  if (s.effort !== null) {
    return
  }
  const effort = savedEffort(await $.settings.read({ key: 'modelSettings' }).catch(() => undefined), s.model)
  if (effort !== null) {
    await update($, status, st => (st.effort === null ? { ...st, effort } : st))
  }
}

// 从会话读模型、从 settings 读该模型存的 effort。
async function init($: EngineInterface) {
  const model = modelKeyOf(await $.session.model())
  await update($, status, s => ({ ...s, model }))
  await fillSavedEffort($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await init($)

    return next(e)
  })

  // /clear 换了新 session id，$.state 回到默认值，且不再触发 session.start；classic SessionStart 仍会来（source: clear）。
  on('classic.SessionStart', async ($, e, next) => {
    await init($)

    return next(e)
  })

  // 主循环每一步带着实际的 model 与 effort：开局、切模型后（effort 置 null）、
  // 手敲 `/model` 却没拿到输出时，都从这里校正；认不出的不动。
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const model = modelKeyOf(e.model) ?? undefined
      const level = EFFORTS.find(x => x === e.effort)
      // 每一步都会进来：值没变就不写，免得每步都触发一次重画。
      const s = await read($, status)
      if ((model !== undefined && model !== s.model) || (level !== undefined && level !== s.effort)) {
        await update($, status, st => ({ ...st, model: model ?? st.model, effort: level ?? st.effort }))
      }
    }

    return yield* next(e)
  })

  // picker、meta+p、/config、fast mode、fallback 换的模型：effort 置 null，等下一步主循环报上来。
  on('classic.PostModelSwitch', async ($, e, next) => {
    const model = modelKeyOf(e.to_model)
    await update($, status, s => ({ ...s, model: model ?? s.model, effort: null }))
    await fillSavedEffort($)

    return next(e)
  })

  // 用户手敲的 `/model` `/effort`。
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    await update($, status, s => applyCommandResult(s, 'model', e.args, r.text ?? ''))
    await fillSavedEffort($)

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
    // AbovePrompt 只在 terminal 与 desktop app 上触发；两边的 Box/Text/Button 同一套 props，画同一棵树。
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey) {
      return next(e)
    }

    // 下层（task-progress 等其他 mod、engine 自己）的画面放在按钮上方；按钮留在最下、最右。
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, status)
    const open = await read($, isOpen)
    const supported = supportedEfforts(s.model)

    // 桌面 app 把 Button 画成原生按钮，里面 Text 的颜色不生效：选中态用原生的 primary，其余 secondary。
    const isDesktop = e.surface === 'desktop'
    const nativeChip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
    )

    // terminal：选中项紫底深字，其他 dim。
    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) =>
      isDesktop ? nativeChip(key, label, isOn, onPress) : isOn ? (
        <Button key={key} plain onPress={onPress}>
          <Text backgroundColor={PURPLE} color={INK}>{` ${label} `}</Text>
        </Button>
      ) : (
        <Button key={key} plain dimColor onPress={onPress}>{` ${label} `}</Button>
      )

    // 按下时再读一次 state，不用画的时候捕获的值。
    const toggleUltra = async () => {
      const ultracode = !(await read($, status)).ultracode
      await run($, 'effort', `ultracode ${ultracode ? 'on' : 'off'}`, st => ({ ...st, ultracode }))
    }

    const root = (
      // 撑满 band 宽度，按钮才会落在最右侧（不设宽度时 Box 只有内容那么宽）。
      <Box key="root" width={e.props.bodyColumns} flexDirection="column" alignItems="flex-end">
        {open && (
          <Box key="panel-row" justifyContent="flex-end">
          <Box borderStyle="round" flexDirection="column" paddingX={1}>
            <Box flexWrap="wrap">
              {MODELS.map(m =>
                // 已选中的再按一次：不发命令。
                chip(`model-${m.key}`, m.label, s.model === m.key, () =>
                  s.model === m.key
                    ? undefined
                    : run($, 'model', m.alias, st => ({ ...st, model: m.key, effort: null })),
                ),
              )}
            </Box>
            <Box flexWrap="wrap">
              {EFFORTS.map(level => {
                // 当前模型不支持的档（2.1.316 上没有）：dim，按下不发命令；已选中的同样不发。
                const isLive = supported.includes(level)
                const isOn = isLive && s.effort === level

                return chip(`effort-${level}`, level, isOn, () =>
                  isLive && !isOn ? run($, 'effort', level, st => ({ ...st, effort: level })) : undefined,
                )
              })}
            </Box>
            <Box>
              {isDesktop ? (
                nativeChip('ultra', ULTRA.trim(), s.ultracode, toggleUltra)
              ) : s.ultracode ? (
                <Button key="ultra" plain onPress={toggleUltra}>
                  {/* Text 不带 key：描述树没有 reconciliation，surface 会丢掉 Text 的 key。 */}
                  {Array.from(ULTRA).map((ch, i) => (
                    <Text backgroundColor={RAINBOW[i]} color={INK}>{ch}</Text>
                  ))}
                </Button>
              ) : (
                <Button key="ultra" plain onPress={toggleUltra}>
                  <Text backgroundColor={GREY} dimColor>{ULTRA}</Text>
                </Button>
              )}
            </Box>
          </Box>
          </Box>
        )}
        {/* terminal 会把 Button 撑满整行，单靠外层 alignItems 无法靠右；包一层横向 Box 推到右边。plain：不画 `[ ]`。 */}
        <Box key="toggle-row" justifyContent="flex-end">
          <Button key="toggle" plain label={buttonLabel(s, open)} onPress={() => update($, isOpen, o => !o)} />
        </Box>
      </Box>
    )

    // 下层什么都没画时只返回本 mod 的 root，结构与组合前一致。
    return below ? (
      <Box key="stack" flexDirection="column">
        {below}
        {root}
      </Box>
    ) : (
      root
    )
  })
}
