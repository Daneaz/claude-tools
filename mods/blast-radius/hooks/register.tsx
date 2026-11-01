// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius：拦下危险的 Bash 命令，量出影响，等用户「执行 / 取消」。
// 移植自 claude-code-playground 的 Blast Radius（Apache-2.0），外观换成无框 + 琥珀左竖线。
//
// tool.call（Bash）：危险命令先测量，开 pane 等按钮写入决定。hook 自身只有 10 秒预算，
// 但花在 `$` 调用里的时间不算，所以用短的 `$.process.run(['sleep', …])` 轮询。
// ui.render：Pane 画报告；pane 放不下（窄终端）时同一份报告改画在 AbovePrompt band。
import type { ElementTable, EngineInterface, MatchedHook, Register, RenderChildren, TextProps } from 'claude-code'

import { classify } from './classify'
import { measure, resolveDir } from './measure'
import type { Run } from './measure'
import type { Report, ReportLine, Risk } from '../types'

const PANE_ID = 'blast-radius'
const POLL_SECONDS = '0.25'
const HOLD_LIMIT_MS = 600_000
// 规模胶囊最多画几个
const CAPSULES = 10
// band 给兄弟 mod 留的行数（同 task-progress 的 RESERVED）
const RESERVED = 3

const AMBER = 'warning'
const RED = 'error'
const GREEN = 'success'
const BLUE = 'suggestion'
const BAR = '▎'

type Decision = 'proceed' | 'cancel' | 'timeout' | 'interrupted' | 'error'
type Held = { command: string; risk: Risk; report: Report | null; decision: Decision | null; where: 'pane' | 'band' }

// 正拦着的那条，或 null。一次只拦一个，其他的排队
let held: Held | null = null

const WHY: Record<Exclude<Decision, 'proceed'>, string> = {
  cancel: 'the user pressed Cancel',
  timeout: 'no answer within 10 minutes',
  interrupted: 'the turn was interrupted',
  error: 'Blast Radius hit an error while holding it',
}

/** 给模型看的拒绝原因（英文，照搬原版句式） */
function refusal(why: string, summary?: string) {
  const would = summary === undefined ? '' : ` It would have: ${summary}.`

  return { deny: `Blast Radius held this command and did not run it: ${why}.${would} Do not retry it unless the user asks you to.` }
}

/** measure 用的 Run：$.process.run 回的是 exitCode */
function hostRun($: EngineInterface): Run {
  return async (argv, opts) => {
    const r = await $.process.run(argv, opts)

    return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
}

function pause($: EngineInterface) {
  return $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
}

/** cd 目标找不到（或是 `cd -`）时的报告：照样拦，只是量不了 */
function unresolved(risk: Risk): Report {
  const note =
    risk.dir === '-' ? 'cd - 去哪个目录取决于 shell 历史，量不了这条命令会改什么。' : `找不到目录 ${risk.dir}，量不了这条命令会改什么。`

  return { summary: `${risk.label}（在 ${risk.dir} 里）`, lines: [], note }
}

export const holdBash: MatchedHook<'tool.call', { tool: 'Bash' }> = async ($, e, next) => {
  const command = String(e.command ?? '')
  const risk = classify(command)
  if (risk === null) {
    return next(e)
  }
  // 已有一条在拦（比如 subagent 的）就等它答完。检查与占用之间没有 await，两条等着的不会同时进来
  while (held !== null) {
    if (next.signal.aborted) {
      return refusal(WHY.interrupted)
    }
    await pause($)
  }
  const mine: Held = { command, risk, report: null, decision: null, where: 'pane' }
  held = mine

  let summary = risk.label
  try {
    // 在命令实际运行的目录里测量：会话目录，再按同一行前面的 cd / git -C 移动
    const run = hostRun($)
    const sessionCwd = await $.session.cwd()
    const cwd = risk.dir ? await resolveDir(run, sessionCwd, risk.dir) : sessionCwd
    mine.report = cwd === null ? unresolved(risk) : await measure(run, risk, cwd)
    summary = mine.report.summary

    const opened = await $.ui.open({ id: PANE_ID, title: 'Blast Radius', focus: true, rows: paneRows(mine.report) })
    if (!opened.isPlaced) {
      mine.where = 'band'
    }
    $.ui.invalidate('ui.render')

    const startedAt = await $.clock.now()
    while (mine.decision === null) {
      if (next.signal.aborted) {
        mine.decision = 'interrupted'
        break
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        mine.decision = 'timeout'
        break
      }
      await pause($)
    }
  } catch {
    // 拦着期间出任何意外都拒绝
    mine.decision = 'error'
  } finally {
    // 先关本条的 pane 再放开 held，免得关掉的是下一条的 pane。
    // 没放下的 pane 也关：它是开着的（只是没画），留着会在终端变宽时冒出一个空 pane
    try {
      await $.ui.close({ id: PANE_ID })
    } catch {
      // pane 已经不在了
    }
    if (held === mine) {
      held = null
    }
    $.ui.invalidate('ui.render')
  }

  const decision: Decision | null = mine.decision
  if (decision === 'proceed') {
    $.ui.toast('Blast Radius：放行')

    return next(e)
  }

  return refusal(decision === null ? 'no answer was recorded' : WHY[decision], summary)
}

/** 用户手动关掉 pane（关闭标记或按键）而还没决定：当作取消，免得没有 UI 干等 10 分钟。
 * 本 mod 自己 finally 里的 $.ui.close 是 origin plugin，不走这里 */
export const cancelOnClose: MatchedHook<'ui.close', { id: typeof PANE_ID }> = ($, e, next) => {
  if (e.origin.kind === 'person' && held !== null && held.decision === null) {
    held.decision = 'cancel'
  }

  return next(e)
}

export const register: Register = on => {
  // 兜底：hook 抛出或超预算时 engine 会替它调 next(e)，命令就跑了。没调过 next 就拒绝
  on('tool.call', { tool: 'Bash' }, holdBash).catch(async ($, e, next) => (next.called ? next(e) : refusal(WHY.error)))

  on('ui.close', { id: PANE_ID }, cancelOnClose)

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e, next) => {
    if (held === null || held.report === null) {
      return next(e)
    }

    return draw($.ui.resolve(e), held, held.report)
  })

  // 拦着且 pane 放不下时独占 band：不组合下层，也不给 survey 让位，按钮必须看得见
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== 'band') {
      return next(e)
    }

    return draw($.ui.resolve(e), held, held.report, e.props.maxRows)
  })
}

// ---- 渲染 ----------------------------------------------------------------

/** pane 想要的行数：标题、影响、三处空行、按钮共 6 行，加列表、「还有」与说明 */
function paneRows(report: Report): number {
  return Math.min(24, 6 + report.lines.length + (report.more ? 1 : 0) + (report.note ? 1 : 0))
}

/**
 * band 版列表的行数。band 超过 maxRows 只露出顶部一窗，数字键只认窗内的按钮；
 * 兄弟 mod（task-progress 等）展开时只给下层留 RESERVED 行。所以总行数守住 maxRows - RESERVED，
 * 前两行（标题、按钮）之外才给列表；放不下就少列，省掉的并进「… 还有 N 个」，连这一行也放不下就不列
 */
function fitBand(report: Report, maxRows: number): { shown: number; more: number } {
  const total = report.lines.length
  const more = report.more ?? 0
  const room = maxRows - RESERVED - 2
  if (total + (more > 0 ? 1 : 0) <= room) {
    return { shown: total, more }
  }
  if (room <= 0) {
    return { shown: 0, more: 0 }
  }
  const shown = room - 1

  return { shown, more: more + total - shown }
}

function markStyle(mark: ReportLine['mark']): TextProps {
  if (mark === '−') return { color: RED }
  if (mark === 'A') return { color: GREEN }
  if (mark === 'M') return { color: BLUE }

  return { dimColor: true }
}

/** 列表路径里与 rm 目标同名的前缀（如 `build/`），画 dim */
function targetPrefix(risk: Risk, text: string): string {
  if (risk.kind !== 'rm') {
    return ''
  }
  for (const target of risk.targets) {
    const base = target.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
    if (base !== '' && text.startsWith(`${base}/`)) {
      return `${base}/`
    }
  }

  return ''
}

type Table = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

/**
 * 无框 + 琥珀左竖线的报告。
 * pane 版照 spec 行序：标题、空行、影响、空行、列表、还有、说明、空行、按钮。
 * band 版（给了 maxRows）紧凑：标题行带摘要，第 2 行就是按钮（说明跟在按钮后），之后才是列表，不留空行
 */
function draw({ Box, Text, Button }: Table, state: Held, report: Report, maxRows?: number) {
  const isBand = maxRows !== undefined
  const { shown, more } = isBand ? fitBand(report, maxRows) : { shown: report.lines.length, more: report.more ?? 0 }
  const capsules = '▰'.repeat(Math.min(report.count ?? 0, CAPSULES))
  // 按钮只回答画出它们的那条命令，不管现在拦着的是哪条
  const decide = (choice: 'proceed' | 'cancel') => () => {
    if (state.decision === null) {
      state.decision = choice
    }
  }
  const row = (key: string, content?: RenderChildren, wrap: TextProps['wrap'] = 'truncate-end') => (
    <Box key={key}>
      <Text color={AMBER}>{BAR}</Text>
      {content !== undefined && <Text wrap={wrap}>{content}</Text>}
    </Box>
  )
  const title = [
    <Text color={AMBER} weight="bold">⚠ 拦截</Text>,
    '  ',
    <Text weight="bold">{state.command.replace(/\s+/g, ' ').trim()}</Text>,
  ]
  const summary = [
    <Text color={RED} weight="bold">{report.summary}</Text>,
    report.extra !== undefined && <Text dimColor>{`  ${report.extra}`}</Text>,
  ]
  const buttons = (hint: string) => (
    <Box key="br-buttons">
      <Text color={AMBER}>{BAR}</Text>
      <Button key="proceed" label="1 执行" hotkey="1" onPress={decide('proceed')} />
      <Text>{'  '}</Text>
      <Button key="cancel" label="2 取消" hotkey="2" autoFocus onPress={decide('cancel')} />
      <Text dimColor wrap="truncate-end">{`   ${hint}`}</Text>
    </Box>
  )
  const lines = report.lines.slice(0, shown).map((line, i) => {
    const prefix = targetPrefix(state.risk, line.text)

    return row(`br-line-${i}`, [
      '  ',
      <Text {...markStyle(line.mark)}>{line.mark}</Text>,
      ' ',
      prefix !== '' && <Text dimColor>{prefix}</Text>,
      line.text.slice(prefix.length),
    ])
  })
  const moreRow = more > 0 && row('br-more', <Text dimColor>{`    … 还有 ${more} 个`}</Text>)

  if (isBand) {
    return (
      <Box key="br" flexDirection="column">
        {row('br-title', [...title, '   ', ...summary])}
        {buttons(report.note ?? 'Claude 在等你决定')}
        {lines}
        {moreRow}
      </Box>
    )
  }

  return (
    <Box key="br" flexDirection="column">
      {row('br-title', title)}
      {row('br-gap-1')}
      {row('br-summary', [capsules !== '' && <Text color={RED}>{`${capsules}  `}</Text>, ...summary])}
      {row('br-gap-2')}
      {lines}
      {moreRow}
      {report.note !== undefined && row('br-note', <Text dimColor>{`  ${report.note}`}</Text>, 'wrap')}
      {row('br-gap-3')}
      {buttons('Claude 在等你决定')}
    </Box>
  )
}
