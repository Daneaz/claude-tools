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
} from './logic'
import type { Plan, Subagent, Task } from './logic'

// 绿色用 theme key，跟着终端主题走；蓝色没有语义对口的 key，用 hex。
const GREEN = 'success'
const BLUE = '#8ab4ff'
// 完成的任务名。
const DONE_NAME = '#55606e'
// 未开始的胶囊，也是进度条的暗轨。
const DARK = '#3b424d'
// subagent 的说明文字。
const NOTE = '#6b7480'

const BAR = 10
// 展开行：`  ✓  ` 前缀 5 列，列与列之间空 2 列。
const PREFIX = 5
const GAP = 2
// subagent 行：缩进 7 列（比任务名多 2），`↳ subagent` 10 列，`运行中` 6 列。
const AGENT_INDENT = 7
const AGENT_TAG = '↳ subagent'
const RUNNING = '运行中'

const EMPTY: Plan = { tasks: [] }
const plan = atom({ plugin: 'task-progress', key: 'plan' } as const, EMPTY)
const subagents = atom({ plugin: 'task-progress', key: 'subagents' } as const, [] as Subagent[])
const isOpen = atom({ plugin: 'task-progress', key: 'isOpen' } as const, false)
const frame = atom({ plugin: 'task-progress', key: 'frame' } as const, 0)

const isRunning = (t: Task) => t.status === 'in_progress'

// 扫动亮光的计时器：只在展开且有进行中任务时走。模块重载时旧环境连同计时器一起丢弃。
let timer: Timer | undefined

// 按当前状态起停计时器；toggle 和每次计划变化后都调一次。
async function syncTimer($: EngineInterface) {
  const shouldRun = (await read($, isOpen)) && (await read($, plan)).tasks.some(isRunning)
  if (shouldRun && timer === undefined) {
    timer = $.clock.every(160, () => void update($, frame, f => f + 1))
  } else if (!shouldRun && timer !== undefined) {
    timer.cancel()
    timer = undefined
  }
}

async function changePlan($: EngineInterface, change: (p: Plan) => Plan) {
  await update($, plan, change)
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

  // 计划全部完成后，下一次提交 prompt 时清空，展开状态回到收起。
  on('prompt.submit', async ($, e, next) => {
    if (summarize(await read($, plan)).isFinished) {
      await update($, isOpen, () => false)
      await changePlan($, clearIfFinished)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) {
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
        <Text color={GREEN}>{`✓ ${s.total}/${s.total} 全部完成`}</Text>,
        subsNote !== '' && <Text dimColor>{subsNote}</Text>,
      ]
    } else {
      const count = `${s.position}/${s.total}`
      const extra = s.extraRunning > 0 ? ` +${s.extraRunning}` : ''
      const left = `  还剩 ${s.remaining} 个`
      const room = columns - s.total - GAP - textWidth(count) - GAP - textWidth(extra + left + subsNote)
      summary = [
        ...p.tasks.map(t =>
          t.status === 'pending' ? (
            <Text color={DARK}>▱</Text>
          ) : (
            <Text color={t.status === 'completed' ? GREEN : BLUE}>▰</Text>
          ),
        ),
        '  ',
        <Text color={BLUE} weight="bold">{count}</Text>,
        `  ${truncate(s.title, room)}`,
        extra !== '' && <Text dimColor>{extra}</Text>,
        <Text dimColor>{left}</Text>,
        subsNote !== '' && <Text dimColor>{subsNote}</Text>,
      ]
    }

    // 展开的清单：名称列 = 最长任务名（上限 40%），进度条 10 格，描述占剩下的宽度。
    const nameWidth = Math.min(Math.max(...p.tasks.map(t => textWidth(t.title))), Math.floor(columns * 0.4))
    const noteWidth = columns - PREFIX - nameWidth - GAP - BAR - GAP
    const agentWidth = columns - AGENT_INDENT - textWidth(AGENT_TAG) - GAP - GAP - textWidth(RUNNING)

    const taskRow = (t: Task) => {
      const name = fit(t.title, nameWidth)
      if (t.status === 'completed') {
        return (
          <Box key={`task-${t.id}`}>
            <Text>{'  '}<Text color={GREEN}>✓</Text>{'  '}</Text>
            <Text color={DONE_NAME}>{name}</Text>
            <Text>{'  '}</Text>
            <Box key={`bar-${t.id}`}>
              <Text color={GREEN}>{'▰'.repeat(BAR)}</Text>
            </Box>
            <Text>{'  '}</Text>
            <Box key={`note-${t.id}`}>
              <Text color={GREEN}>{truncate('Done', noteWidth)}</Text>
            </Box>
          </Box>
        )
      }
      if (t.status === 'in_progress') {
        return (
          <Box key={`task-${t.id}`}>
            <Text>{'  '}<Text color={BLUE}>›</Text>{'  '}</Text>
            <Text weight="bold">{name}</Text>
            <Text>{'  '}</Text>
            <Box key={`bar-${t.id}`}>
              {sweep(tick, BAR).map(lit => (
                <Text color={lit ? BLUE : DARK}>{lit ? '▰' : '▱'}</Text>
              ))}
            </Box>
            <Text>{'  '}</Text>
            <Box key={`note-${t.id}`}>
              <Text color={BLUE}>{truncate(t.activeForm ?? '进行中', noteWidth)}</Text>
            </Box>
          </Box>
        )
      }

      // 未开始：没有进度条，空出同样宽度让描述列对齐。
      return (
        <Box key={`task-${t.id}`}>
          <Text>{' '.repeat(PREFIX)}</Text>
          <Text dimColor>{name}</Text>
          <Text>{' '.repeat(GAP + BAR + GAP)}</Text>
          <Box key={`note-${t.id}`}>
            <Text dimColor>{truncate('Next', noteWidth)}</Text>
          </Box>
        </Box>
      )
    }

    const agentRow = (a: Subagent) => (
      <Box key={`agent-${a.agentId}`}>
        <Text>{' '.repeat(AGENT_INDENT)}</Text>
        <Text dimColor>{AGENT_TAG}</Text>
        <Text color={NOTE}>{`  ${truncate(a.description, agentWidth)}`}</Text>
        <Text color={BLUE}>{`  ${RUNNING}`}</Text>
      </Box>
    )

    // subagent 行：恰好一个任务进行中时挂在它下面，否则统一列在最后。
    const running = p.tasks.filter(isRunning)
    const host = running.length === 1 ? running[0]?.id : undefined
    const rows = p.tasks.flatMap(t => (t.id === host ? [taskRow(t), ...subs.map(agentRow)] : [taskRow(t)]))
    if (host === undefined) {
      rows.push(...subs.map(agentRow))
    }

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
        {open && <Text>{' '}</Text>}
        {open && rows}
        {below}
      </Box>
    )
  })
}
