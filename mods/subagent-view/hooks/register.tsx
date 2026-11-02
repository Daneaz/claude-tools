import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  avatarFor,
  endAgent,
  endStateOf,
  fit,
  formatElapsed,
  pickLang,
  strings,
  ordered,
  overviewOf,
  recordTool,
  resumeAgent,
  spawnAgent,
  sweep,
  textWidth,
  truncate,
} from './logic'
import type { Agent, AgentState, Lang } from './logic'

const PANE = 'subagent-view'
const TITLE = 'SubAgent View'

// 颜色都用 theme key，跟着终端主题走（与 task-progress 同一套，加 error）。
const GREEN = 'success'
const BLUE = 'suggestion'
const DARK = 'subtle'
const RED = 'error'

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// 名称列：avatar 2 列 + 空格 + 短名称 10 列 + 空格。
const NAME = 10
const HEAD = 2 + 1 + NAME + 1
// 第 2 行的缩进。
const INDENT = '   '
// 工作条格数；画了工作条后留给「› 工具 hint」不足 MIN_ACTIVITY 列时省掉工作条。
const BAR = 10
const MIN_ACTIVITY = 8
// 计时器每走这么多帧，按 $.agent.list() 自愈一次。
const HEAL_EVERY = 30
// $.agent.list() 里算已结束的状态。
const ENDED: AgentState[] = ['completed', 'failed', 'killed']

// 改了 Agent 的字段就换 shape，旧版本存下的值读作缺省。
const agents = atom({ plugin: 'subagent-view', key: 'agents' } as const, [] as Agent[], { shape: 'agents-2' })
const isOpen = atom({ plugin: 'subagent-view', key: 'isOpen' } as const, false)
const frame = atom({ plugin: 'subagent-view', key: 'frame' } as const, 0)
// 开局（及 /clear 后）按 settings 定一次；null = 还没定，画的时候现读。
const lang = atom({ plugin: 'subagent-view', key: 'lang' } as const, null as Lang | null)

async function settingsLang($: EngineInterface): Promise<Lang> {
  return pickLang(await $.settings.read({ key: 'language' }).catch(() => undefined))
}

const isTracked = async ($: EngineInterface, agentId: string | undefined) =>
  agentId !== undefined && (await read($, agents)).some(a => a.agentId === agentId)

// 漏了 turn.complete 的（后台 agent、被 kill）：按 $.agent.list() 补记结束，不在列表里的算完成。
async function heal($: EngineInterface) {
  const running = (await read($, agents)).filter(a => a.state === 'running')
  if (running.length === 0) return
  const infos = await $.agent.list().catch(() => undefined)
  if (infos === undefined) return
  const now = await $.clock.now()
  await update($, agents, list => {
    for (const a of running) {
      const info = infos.find(i => i.id === a.agentId)
      if (info === undefined) list = endAgent(list, a.agentId, 'completed', now)
      else if ((ENDED as string[]).includes(info.status)) {
        list = endAgent(list, a.agentId, info.status as Exclude<AgentState, 'running'>, now)
      }
    }
    return list
  })
}

// 转圈与时长的计时器：只在 pane 打开且有在跑的 agent 时走。模块重载时旧环境连同计时器一起丢弃。
let timer: Timer | undefined

async function shouldAnimate($: EngineInterface) {
  return (await read($, isOpen)) && (await read($, agents)).some(a => a.state === 'running')
}

// 每次 tick 先自检：不该走了（关了 pane、没有在跑的、/clear 后 state 回到默认）就停掉自己。
async function tick($: EngineInterface, self: () => Timer | undefined) {
  if (!(await shouldAnimate($))) {
    const t = self()
    t?.cancel()
    if (timer === t) timer = undefined
    return
  }
  let f = 0
  await update($, frame, n => (f = n + 1))
  if (f % HEAL_EVERY === 0) await heal($)
}

// 按当前状态起停计时器；开关、派出、结束之后都调一次。
async function syncTimer($: EngineInterface) {
  const shouldRun = await shouldAnimate($)
  if (shouldRun && timer === undefined) {
    const t: Timer = $.clock.every(160, () => void tick($, () => t).catch(() => {}))
    timer = t
  } else if (!shouldRun && timer !== undefined) {
    timer.cancel()
    timer = undefined
  }
}

async function changeAgents($: EngineInterface, change: (list: Agent[]) => Agent[]) {
  await update($, agents, change)
  await syncTimer($)
}

// pane 是否打开以 engine 的记录为准：/clear 让 state 回到默认，但 pane 可能还开着。
const isPaneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// 开局与 /clear 之后：注册命令（immediate：turn 进行中也能立刻开关），isOpen 按 pane 的实际状态重设。
async function init($: EngineInterface) {
  await $.command.register({ name: 'subagents', description: 'Show or hide the SubAgent View pane', immediate: true })
  const open = await isPaneOpen($)
  await update($, isOpen, () => open)
  const chosen = await settingsLang($)
  await update($, lang, () => chosen)
  await syncTimer($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await init($)
    return next(e)
  })

  // /clear 换了新 session id，$.state 回到默认值，且不触发 session.start；只来 classic SessionStart（source: clear）。
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await init($)
    return next(e)
  })

  // 不在对话里留回执：pane 的出现 / 消失本身就是回应。
  on('command.run', { command: 'subagents' }, async $ => {
    if (await isPaneOpen($)) {
      // isOpen 由下面的 ui.close hook 清掉：与用户自己关掉 pane 走同一条路。
      await $.ui.close({ id: PANE })
    } else {
      await $.ui.open({ id: PANE, title: TITLE })
      await update($, isOpen, () => true)
    }
    await syncTimer($)
    return {}
  })

  // 用 pane 自带的关闭操作关掉时也要跟着变；不拦截关闭。
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isOpen, () => false)
      await syncTimer($)
    }
    return next(e)
  })

  // 只跟踪模型在主会话派出的：嵌套的、workflow 的、teammate、别的 mod 派的（spawnedBy）都不算。
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const { agentId } = r
    if (agentId === undefined) return r

    const now = await $.clock.now()
    if (e.resume !== undefined) {
      // 同一个 agent 的重复叫醒事件不重置计时。
      const a = (await read($, agents)).find(x => x.agentId === agentId)
      if (a !== undefined && a.state !== 'running') {
        await changeAgents($, list => resumeAgent(list, agentId, now))
      }
      return r
    }
    if (e.parentAgentId !== undefined || e.workflow !== undefined || e.isTeammate) return r
    const infos = await $.agent.list().catch(() => undefined)
    if (infos?.find(i => i.id === agentId)?.spawnedBy !== undefined) return r

    await changeAgents($, list =>
      spawnAgent(list, { agentId, type: e.subagentType, description: e.description, now }),
    )
    return r
  })

  // subagent 的一次运行结束（完成、失败、被停）；前台、后台都一样。
  on('turn.complete', async ($, e, next) => {
    const { agentId } = e
    if (agentId !== undefined && (await isTracked($, agentId))) {
      const now = await $.clock.now()
      await changeAgents($, list => endAgent(list, agentId, endStateOf(e.reason), now))
    }
    return next(e)
  })

  // 被跟踪的 subagent 的每次工具调用：记下最近一次并计数；被 deny 的不计，报错的照样计。
  on('tool.call', async ($, e, next) => {
    const { agentId } = e
    if (agentId === undefined || !(await isTracked($, agentId))) return next(e)
    const r = await next(e)
    if (r.deny === undefined) {
      const input = e as unknown as Record<string, unknown>
      await update($, agents, list => recordTool(list, agentId, e.tool, input))
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    await heal($)
    await syncTimer($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // terminal 与 desktop 都画；desktop 上 Text 用 mono，列与 terminal 一样对齐。vscode / mobile 交给下层。
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const W = e.props.bodyColumns
    const list = await read($, agents)
    const str = strings((await read($, lang)) ?? (await settingsLang($)))
    const now = await $.clock.now()
    const tick = await read($, frame)
    const spin = SPINNER[tick % SPINNER.length] ?? SPINNER[0]

    // 一行 = 一个 Box；right 靠右对齐到 W 列，left 的最后一段（可截断的说明）让出位置。
    const pad = (used: number, right: string) => ' '.repeat(Math.max(1, W - used - textWidth(right)))

    if (list.length === 0) {
      return (
        <Box key="root" flexDirection="column">
          <Box key="row-title"><Text mono color={BLUE} weight="bold">{TITLE}</Text></Box>
          <Box key="row-gap"><Text mono> </Text></Box>
          <Box key="row-empty-1"><Text mono dimColor>{truncate(str.empty1, W)}</Text></Box>
          <Box key="row-empty-2"><Text mono dimColor>{truncate(str.empty2, W)}</Text></Box>
        </Box>
      )
    }

    const o = overviewOf(list)
    const { running, ended } = ordered(list)

    // 总览第 1 行：标题 + 各项计数（为 0 的不显示），计数靠右。
    const counts = [
      o.running > 0 && { text: str.running(o.running), color: BLUE },
      o.completed > 0 && { text: str.done(o.completed), color: GREEN },
      o.failed > 0 && { text: str.failed(o.failed), color: RED },
    ].filter(c => c !== false)
    const countsText = counts.map(c => c.text).join('  ')
    const titleRow = (
      <Box key="row-title">
        <Text mono color={BLUE} weight="bold">{TITLE}</Text>
        <Text mono>{pad(textWidth(TITLE), countsText)}</Text>
        {counts.map((c, i) => (
          <Text mono color={c.color}>{(i > 0 ? '  ' : '') + c.text}</Text>
        ))}
      </Box>
    )

    const divider = (key: string) => (
      <Box key={key}>
        <Text mono dimColor>{'─'.repeat(W)}</Text>
      </Box>
    )

    // 头部：avatar + 短名称（加粗）+ 说明，说明按 room 截断。
    const head = (a: Agent, room: number, dim = false) => {
      const { avatar, name } = avatarFor(a.type)
      return [
        <Text mono>{`${avatar} `}</Text>,
        <Text mono weight={dim ? 'regular' : 'bold'} dimColor={dim}>{fit(name, NAME)}</Text>,
        <Text mono dimColor={dim}>{` ${truncate(a.description, room)}`}</Text>,
      ]
    }

    const runningBlock = (a: Agent, index: number) => {
      const id = a.agentId
      const elapsed = formatElapsed(now - a.startedAt)
      const right = `${spin} ${elapsed}`
      const room = W - HEAD - 2 - textWidth(right)
      const desc = truncate(a.description, room)
      const line1 = (
        <Box key={`row-${id}-1`}>
          {head(a, room)}
          <Text mono>{pad(HEAD + textWidth(desc), right)}</Text>
          <Text mono color={BLUE}>{spin}</Text>
          <Text mono dimColor>{` ${elapsed}`}</Text>
        </Box>
      )

      const rows = [index > 0 && <Box key={`row-${id}-gap`}><Text mono> </Text></Box>, line1]

      // 第 2 行：工作条（窄时省掉）+ `› 工具 参数` + 靠右的调用次数；没调过工具时只写 `› 启动中`。
      const calls = str.toolCalls(a.toolCalls)
      const callsRoom = a.lastTool === undefined ? 0 : 1 + textWidth(calls)
      const hasBar = W - INDENT.length - BAR - 2 - callsRoom >= MIN_ACTIVITY
      const bar = hasBar
        ? [
            ...sweep(tick, BAR).map(lit => <Text mono color={lit ? BLUE : DARK}>{lit ? '▰' : '▱'}</Text>),
            <Text mono>{'  '}</Text>,
          ]
        : []
      const lead = INDENT.length + (hasBar ? BAR + 2 : 0)
      if (a.lastTool === undefined) {
        rows.push(
          <Box key={`row-${id}-2`}>
            <Text mono>{INDENT}</Text>
            {bar}
            <Text mono dimColor>{truncate(`› ${str.starting}`, Math.max(0, W - lead))}</Text>
          </Box>,
        )
        return rows
      }
      const activity = truncate(
        `› ${a.lastTool.tool}${a.lastTool.hint ? ` ${a.lastTool.hint}` : ''}`,
        Math.max(0, W - lead - 1 - textWidth(calls)),
      )
      rows.push(
        <Box key={`row-${id}-2`}>
          <Text mono>{INDENT}</Text>
          {bar}
          <Text mono color={BLUE}>{activity}</Text>
          <Text mono>{pad(lead + textWidth(activity), calls)}</Text>
          <Text mono dimColor>{calls}</Text>
        </Box>,
      )
      return rows
    }

    // 已结束一行：✓ / ✗ + 头部（dim）+ 结果 + 总用时（靠右）。
    const endedRow = (a: Agent) => {
      const ok = a.state === 'completed'
      const mark = ok ? '✓' : '✗'
      const result = ok ? (a.toolCalls > 0 ? str.calls(a.toolCalls) : '') : a.state === 'killed' ? str.killed : str.failedEnd
      const elapsed = formatElapsed((a.endedAt ?? now) - a.startedAt)
      const tail = result ? `  ${result}` : ''
      const room = W - 2 - HEAD - textWidth(tail) - 2 - textWidth(elapsed)
      const desc = truncate(a.description, room)
      return (
        <Box key={`row-${a.agentId}-ended`}>
          <Text mono color={ok ? GREEN : RED}>{`${mark} `}</Text>
          {head(a, room, true)}
          {ok ? <Text mono dimColor>{tail}</Text> : <Text mono color={RED}>{tail}</Text>}
          <Text mono>{pad(2 + HEAD + textWidth(desc) + textWidth(tail), elapsed)}</Text>
          <Text mono dimColor>{elapsed}</Text>
        </Box>
      )
    }

    return (
      <Box key="root" flexDirection="column">
        {titleRow}
        {divider('row-divider-1')}
        {running.flatMap(runningBlock)}
        {ended.length > 0 && running.length > 0 && divider('row-divider-2')}
        {ended.length > 0 && (
          <Box key="row-ended">
            <Text mono dimColor>{str.ended}</Text>
          </Box>
        )}
        {ended.map(endedRow)}
      </Box>
    )
  })
}
