import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  clearIfFinished,
  fit,
  summarize,
  sweep,
  textWidth,
  truncate,
  windowRows,
} from './logic'
import type { Plan, Subagent, Task } from './logic'

// 颜色都用 theme key，跟着终端主题走。
const GREEN = 'success'
const BLUE = 'suggestion'
// 完成的任务名。
const DONE_NAME = 'inactive'
// 未开始的胶囊，也是进度条的暗轨。
const DARK = 'subtle'
// subagent 的说明文字。
const NOTE = 'inactive'

const BAR = 10
// 展开行：`  ✓  ` 前缀 5 列，列与列之间空 2 列。
const PREFIX = 5
const GAP = 2
// subagent 行：缩进 7 列（比任务名多 2），`↳ subagent` 10 列，`运行中` 6 列。
const AGENT_INDENT = 7
const AGENT_TAG = '↳ subagent'
const RUNNING = '运行中'
// 展开时给下层（quick-tools 等）至少留的行数；收起行与空行各占 1 行。
const RESERVED = 3
const HEAD = 2
// 还在跑的 subagent 状态（AgentStatus）；其余（completed / failed / killed）算已结束。
const ALIVE = ['pending', 'running', 'waiting', 'idle']

const EMPTY: Plan = { tasks: [] }
const plan = atom({ plugin: 'task-progress', key: 'plan' } as const, EMPTY)
const subagents = atom({ plugin: 'task-progress', key: 'subagents' } as const, [] as Subagent[])
const isOpen = atom({ plugin: 'task-progress', key: 'isOpen' } as const, false)
const frame = atom({ plugin: 'task-progress', key: 'frame' } as const, 0)

const isRunning = (t: Task) => t.status === 'in_progress'

// 扫动亮光的计时器：只在展开且有进行中任务时走。模块重载时旧环境连同计时器一起丢弃。
let timer: Timer | undefined

async function shouldAnimate($: EngineInterface) {
  return (await read($, isOpen)) && (await read($, plan)).tasks.some(isRunning)
}

// 每次 tick 先自检：不该走了（收起、没有进行中任务、/clear 后 state 回到默认）就停掉自己。
// 这样即使 syncTimer 交错起出多余的计时器，或状态绕过 syncTimer 变化，也不会一直空转。
async function tick($: EngineInterface, self: () => Timer | undefined) {
  if (!(await shouldAnimate($))) {
    const t = self()
    t?.cancel()
    if (timer === t) timer = undefined
    return
  }
  await update($, frame, f => f + 1)
}

// 按当前状态起停计时器；toggle 和每次计划变化后都调一次。
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

// 计划变空，或上一份已全部完成而这次变化开了新计划（变成未完成），都收起。
async function changePlan($: EngineInterface, change: (p: Plan) => Plan) {
  let wasFinished = false
  let now: Plan = EMPTY
  await update($, plan, p => {
    wasFinished = summarize(p).isFinished
    now = change(p)
    return now
  })
  if (now.tasks.length === 0 || (wasFinished && !summarize(now).isFinished)) {
    await update($, isOpen, () => false)
  }
  await syncTimer($)
}

export const register: Register = on => {
  // 只收主会话的计划：subagent 自己的 TodoWrite / TaskCreate 不进 band。
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.deny === undefined && !r.isError) {
      const todos = r.result.newTodos
      await changePlan($, p => applyTodoWrite(p, todos))
    }

    return r
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && r.deny === undefined && !r.isError) {
      const { id } = r.result.task
      await changePlan($, p => applyTaskCreate(p, id, e.subject, e.activeForm))
    }

    return r
  })

  // 任务表 session 共享：subagent 把主会话建的任务标完成也要算，不看 agentId。
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && r.result.success !== false) {
      await changePlan($, p => applyTaskUpdate(p, e))
    }

    return r
  })

  // 只跟踪主会话派出的 subagent；嵌套的、workflow 的不算。
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const { agentId } = r
    if (e.parentAgentId === undefined && e.workflow === undefined && agentId !== undefined) {
      await update($, subagents, list => [...list, { agentId, description: e.description }])
    }

    return r
  })

  // subagent 的一次运行结束（成功、失败、被停）都会到这里；前台、后台都一样。
  on('turn.complete', async ($, e, next) => {
    const { agentId } = e
    if (agentId !== undefined && (await read($, subagents)).some(s => s.agentId === agentId)) {
      await update($, subagents, list => list.filter(s => s.agentId !== agentId))
    }

    return next(e)
  })

  // 计划全部完成后，下一次提交 prompt 时清空（changePlan 里随之收起）。
  // 顺带自愈 subagent 列表：漏了 turn.complete 的、已不在运行的，按 $.agent.list() 去掉。
  on('prompt.submit', async ($, e, next) => {
    if (summarize(await read($, plan)).isFinished) {
      await changePlan($, clearIfFinished)
    }
    if ((await read($, subagents)).length > 0) {
      const agents = await $.agent.list().catch(() => undefined)
      if (agents !== undefined) {
        const alive = new Set(agents.filter(a => ALIVE.includes(a.status)).map(a => a.id))
        await update($, subagents, list => list.filter(s => alive.has(s.agentId)))
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // AbovePrompt 只在 terminal 与 desktop 上出现，两处都画。
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.hasSurvey) {
      return next(e)
    }

    // 下层（quick-tools 等其他 mod、engine 自己）的画面放在本 mod 的行下面，一起返回。
    const below = await next(e)
    const p = await read($, plan)
    if (p.tasks.length === 0) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const subs = await read($, subagents)
    const open = await read($, isOpen)
    const tick = open && p.tasks.some(isRunning) ? await read($, frame) : 0
    const s = summarize(p)
    const subsNote = subs.length > 0 ? `  · ${subs.length} 个 subagent` : ''

    // 收起行：胶囊 + 序号/总数 + 标题 + 还剩；窄的时候先截标题，胶囊和序号保留。
    let summary
    if (s.isFinished) {
      summary = [
        <Text mono color={GREEN}>{`✓ ${s.total}/${s.total} 全部完成`}</Text>,
        subsNote !== '' && <Text mono dimColor>{subsNote}</Text>,
      ]
    } else {
      const count = `${s.position}/${s.total}`
      const extra = s.extraRunning > 0 ? ` +${s.extraRunning}` : ''
      const left = `  还剩 ${s.remaining} 个`
      const room = columns - s.total - GAP - textWidth(count) - GAP - textWidth(extra + left + subsNote)
      summary = [
        ...p.tasks.map(t =>
          t.status === 'pending' ? (
            <Text mono color={DARK}>▱</Text>
          ) : (
            <Text mono color={t.status === 'completed' ? GREEN : BLUE}>▰</Text>
          ),
        ),
        '  ',
        <Text mono color={BLUE} weight="bold">{count}</Text>,
        `  ${truncate(s.title, room)}`,
        extra !== '' && <Text mono dimColor>{extra}</Text>,
        <Text mono dimColor>{left}</Text>,
        subsNote !== '' && <Text mono dimColor>{subsNote}</Text>,
      ]
    }

    // 展开的清单：名称列 = 最长任务名（上限 40%），进度条 10 格，描述占剩下的宽度。
    const nameWidth = Math.min(Math.max(...p.tasks.map(t => textWidth(t.title))), Math.floor(columns * 0.4))
    const noteColumn = PREFIX + nameWidth + GAP + BAR + GAP
    const noteWidth = columns - noteColumn
    // subagent 行的说明从 `↳ subagent  ` 之后开始；「运行中」对齐到任务行的描述列。
    // 描述列太靠左（放不下说明）或太靠右（放不下「运行中」）时，退回紧跟说明之后。
    const agentStart = AGENT_INDENT + textWidth(AGENT_TAG) + GAP
    const alignedWidth = noteColumn - GAP - agentStart
    const isAligned = alignedWidth >= 6 && noteWidth >= textWidth(RUNNING)
    const agentWidth = isAligned ? alignedWidth : columns - agentStart - GAP - textWidth(RUNNING)

    const taskRow = (t: Task) => {
      const name = fit(t.title, nameWidth)
      if (t.status === 'completed') {
        return (
          <Box key={`task-${t.id}`}>
            <Text mono>{'  '}<Text mono color={GREEN}>✓</Text>{'  '}</Text>
            <Text mono color={DONE_NAME}>{name}</Text>
            <Text mono>{'  '}</Text>
            <Box key={`bar-${t.id}`}>
              <Text mono color={GREEN}>{'▰'.repeat(BAR)}</Text>
            </Box>
            <Text mono>{'  '}</Text>
            <Box key={`note-${t.id}`}>
              <Text mono color={GREEN}>{truncate('Done', noteWidth)}</Text>
            </Box>
          </Box>
        )
      }
      if (t.status === 'in_progress') {
        return (
          <Box key={`task-${t.id}`}>
            <Text mono>{'  '}<Text mono color={BLUE}>›</Text>{'  '}</Text>
            <Text mono weight="bold">{name}</Text>
            <Text mono>{'  '}</Text>
            <Box key={`bar-${t.id}`}>
              {sweep(tick, BAR).map(lit => (
                <Text mono color={lit ? BLUE : DARK}>{lit ? '▰' : '▱'}</Text>
              ))}
            </Box>
            <Text mono>{'  '}</Text>
            <Box key={`note-${t.id}`}>
              <Text mono color={BLUE}>{truncate(t.activeForm ?? '进行中', noteWidth)}</Text>
            </Box>
          </Box>
        )
      }

      // 未开始：没有进度条，空出同样宽度让描述列对齐。
      return (
        <Box key={`task-${t.id}`}>
          <Text mono>{' '.repeat(PREFIX)}</Text>
          <Text mono dimColor>{name}</Text>
          <Text mono>{' '.repeat(GAP + BAR + GAP)}</Text>
          <Box key={`note-${t.id}`}>
            <Text mono dimColor>{truncate('Next', noteWidth)}</Text>
          </Box>
        </Box>
      )
    }

    const agentRow = (a: Subagent) => (
      <Box key={`agent-${a.agentId}`}>
        <Text mono>{' '.repeat(AGENT_INDENT)}</Text>
        <Text mono dimColor>{AGENT_TAG}</Text>
        <Text mono color={NOTE}>
          {`  ${isAligned ? fit(a.description, agentWidth) : truncate(a.description, agentWidth)}`}
        </Text>
        <Text mono color={BLUE}>{`  ${RUNNING}`}</Text>
      </Box>
    )

    // subagent 行：恰好一个任务进行中时挂在它下面，否则统一列在最后。
    const running = p.tasks.filter(isRunning)
    const host = running.length === 1 ? running[0]?.id : undefined
    // 焦点 = summarize 选出的当前任务（第一个进行中，否则第一个 pending）在行里的下标。
    const current = p.tasks[s.position - 1]?.id
    let focus = 0
    let rowCount = 0
    const all = p.tasks.flatMap(t => {
      if (t.id === current) focus = rowCount
      const group = t.id === host ? [taskRow(t), ...subs.map(agentRow)] : [taskRow(t)]
      rowCount += group.length
      return group
    })
    if (host === undefined) {
      all.push(...subs.map(agentRow))
    }

    // 遵守 maxRows：收起行、空行之外再给下层留 RESERVED 行，剩下的给清单；
    // 放不下时只画以当前任务为中心的一段，上下被省略的各用一行 dim 的汇总。
    const budget = Math.max(1, e.props.maxRows - HEAD - RESERVED)
    const win = windowRows(all.length, focus, budget)
    const more = (key: string, n: number) => (
      <Box key={key}>
        <Text mono dimColor>{`${' '.repeat(PREFIX)}… 另有 ${n} 个`}</Text>
      </Box>
    )
    const rows = [
      win.showAbove && more('more-above', win.start),
      ...all.slice(win.start, win.end),
      win.showBelow && more('more-below', all.length - win.end),
    ]

    // 按下时切换；计时器随之起停。
    const toggle = async () => {
      await update($, isOpen, o => !o)
      await syncTimer($)
    }

    return (
      <Box key="root" flexDirection="column">
        <Button key="toggle" plain onPress={toggle}>
          {summary}
        </Button>
        {open && <Text mono>{' '}</Text>}
        {open && rows}
        {below}
      </Box>
    )
  })
}
