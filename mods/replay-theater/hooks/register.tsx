// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// 改编自 claude-code-playground 的 Replay Theater，有修改（外观、文案与部分行为）。

// Replay Theater：记下一轮里 Claude 的文件编辑，轮次结束后在 band 提示，按需逐步回放每次编辑的 diff。
// 改编自 claude-code-playground 的 Replay Theater（Apache-2.0）；外观换成「步骤清单 + 当前步 diff」，文案中文。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import { countChanges, diffLines, fileCount, fitEnd, fitStart, listWindow, MAX_DIFF_LINES, pills, relPath, textWidth } from './logic'
import type { Step } from './logic'

const PANE_ID = 'replay-theater'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
// 点 band 按钮时 band 占着键盘：先隐藏 band，等一下再开 pane（同原版）。
const OPEN_DELAY = 200
const PILL_CAP = 10
const LIST_SIZE = 7
// band 内展开时：清单最少 3 行（含省略行）、diff 最少 3 行（另加「还有」行）。
const MIN_LIST = 3
const MIN_DIFF = 3
// 回放视图里清单与 diff 之外的固定行：标题、三处空行、按钮。
const FIXED_ROWS = 5
// band 内展开时给下层（quick-tools、Blast Radius 等）至少留的行数，同 task-progress。
const RESERVED = 3
// pane 估算行数时多留的 1 行余量。
const PANE_SLACK = 1
const PANE_COLUMNS = 72

// 紫与 quick-tools 的模型紫一致；其余用 theme key，跟着终端主题走。
const PURPLE = '#c792ff'
const GREEN = 'success'
const RED = 'error'
const DARK = 'subtle'
// diff 行底色：用 engine 的 diff theme key，浅色终端下也跟着主题走。
const DEL_BG = 'diffRemovedDimmed'
const ADD_BG = 'diffAddedDimmed'
// 「下一步」按钮紫底上的深色字（同 quick-tools）。
const INK = '#15161a'

// 清单行：`  ✓  ` 前缀 5 列；diff 缩进同样 5 列，与文件名列对齐。列与列之间空 2 列。
const PREFIX = 5
const GAP = 2

// 回放数据放模块变量（同原版）：`pending` 在一轮里累积，`replay` 是上一轮有编辑的步骤。
let pending: Step[] = []
let replay: Step[] = []

// UI 开关放 $.state：写入即重画读者。
const index = atom({ plugin: 'replay-theater', key: 'index' } as const, 0)
const isOpen = atom({ plugin: 'replay-theater', key: 'isOpen' } as const, false)
const inBand = atom({ plugin: 'replay-theater', key: 'inBand' } as const, false)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// 一次工具调用变成一步或多步。e 按松散的对象读：MultiEdit 不一定在本 build 的工具表里。
async function stepsFor($: EngineInterface, e: Record<string, unknown>): Promise<Step[]> {
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    // 拿不到 cwd：保留完整路径。
  }
  const path = str(e.file_path)
  const file = relPath(cwd, path)
  if (e.tool === 'Edit') {
    return [
      {
        tool: 'Edit',
        file,
        diff: diffLines(str(e.old_string), str(e.new_string)),
        note: e.replace_all === true ? '全部替换' : '',
      },
    ]
  }
  if (e.tool === 'MultiEdit' && Array.isArray(e.edits)) {
    const edits = e.edits as Record<string, unknown>[]
    return edits.map((ed, k) => ({
      tool: 'MultiEdit',
      file,
      diff: diffLines(str(ed.old_string), str(ed.new_string)),
      note: `第 ${k + 1}/${edits.length} 处`,
    }))
  }
  if (e.tool === 'Write') {
    let before = ''
    let isNew = true
    try {
      if (path && (await $.fs.exists(path))) {
        before = String(await $.fs.read(path))
        isNew = false
      }
    } catch {
      // 读不了：当新文件显示。
    }
    return [{ tool: 'Write', file, diff: diffLines(before, str(e.content)), note: isNew ? '新文件' : '重写' }]
  }
  return []
}

// pane 行数按内容估算：清单窗口（含上下省略行）+ 最长的 diff（含「还有」行）+ 固定行与余量。
function paneRows(): number {
  const list = Math.min(replay.length, LIST_SIZE) + (replay.length > LIST_SIZE ? 2 : 0)
  const longest = Math.max(1, ...replay.map(s => s.diff.length))
  const diff = Math.min(longest, MAX_DIFF_LINES) + (longest > MAX_DIFF_LINES ? 1 : 0)
  return list + diff + FIXED_ROWS + PANE_SLACK
}

async function openReplay($: EngineInterface): Promise<boolean> {
  if (replay.length === 0) return false
  await update($, index, () => 0)
  await update($, inBand, () => false)
  await update($, isOpen, () => true)
  await $.clock.sleep(OPEN_DELAY)
  const placed = await $.ui.open({
    id: PANE_ID,
    title: '回放',
    focus: true,
    closeOnEscape: true,
    rows: paneRows(),
    columns: PANE_COLUMNS,
  })
  // 放不下 pane（窄终端）：回放画在 band 里。
  await update($, inBand, () => placed.isPlaced === false)
  return true
}

// 清单窗口：最多 size 步、总行数（含上下省略行）不超过 budget；当前步始终在内。
function fitWindow(total: number, k: number, size: number, budget: number) {
  for (let s = Math.min(size, total); s > 1; s--) {
    const win = listWindow(total, k, s)
    if (s + (win.start > 0 ? 1 : 0) + (win.end < total ? 1 : 0) <= budget) return win
  }
  return listWindow(total, k, 1)
}

const pad = (text: string, size: number) => text + ' '.repeat(Math.max(0, size - textWidth(text)))

// 回放视图：标题行、步骤清单、当前步 diff、按钮。画在 Pane 里，或窄终端下画在 band 里。
async function replayView($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>, isBand: boolean, columns: number, maxRows: number) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const total = replay.length
  // 轮次进行中（如 Blast Radius 拦截时）band 里只留标题行，保证下层按钮可见。
  const isCollapsed = isBand && e.component === 'AbovePrompt' && e.props.isWorking
  const k = Math.max(0, Math.min(await read($, index), total - 1))
  const step = replay[k]
  if (step === undefined) {
    return <Text dimColor>没有可回放的编辑</Text>
  }

  // band 内按 maxRows 收缩：先扣固定行，清单（含省略行，最少 3 行）先取，留够 diff 的 3 行与「还有」行；
  // 剩下的给 diff（含「还有」行）。预算是 maxRows 扣掉给下层留的 RESERVED 行；不够最小 view 时按最小 view 画。
  // pane 里清单 7 步、diff 12 行。
  const budget = maxRows - RESERVED
  const win = isBand
    ? fitWindow(total, k, LIST_SIZE, Math.max(MIN_LIST, budget - FIXED_ROWS - MIN_DIFF - 1))
    : listWindow(total, k, LIST_SIZE)
  const listRows = win.end - win.start + (win.start > 0 ? 1 : 0) + (win.end < total ? 1 : 0)
  const diffRows = isBand ? Math.max(MIN_DIFF + 1, budget - FIXED_ROWS - listRows) : MAX_DIFF_LINES + 1
  // diff 放得下就全画；放不下留一行给「还有 N 行」。
  const maxDiff = Math.min(MAX_DIFF_LINES, step.diff.length <= diffRows ? diffRows : diffRows - 1)

  // 标题行：胶囊看过的绿、当前紫、没看的暗；超出封顶的数量 dim `+N`。
  const p = pills(total, k, PILL_CAP)
  const title = (
    <Box key="rt-title">
      <Text color={PURPLE} weight="bold">▶ 回放</Text>
      <Text>{'  '}</Text>
      <Text color={GREEN}>{'▰'.repeat(p.seen)}</Text>
      <Text color={PURPLE}>▰</Text>
      <Text color={DARK}>{'▱'.repeat(p.rest)}</Text>
      {p.overflow > 0 && <Text dimColor>{`+${p.overflow}`}</Text>}
      <Text>{'  '}</Text>
      <Text color={PURPLE} weight="bold">{`${k + 1}/${total}`}</Text>
      <Text dimColor>{`  ${fileCount(replay)} 个文件`}</Text>
    </Box>
  )

  // 清单列：文件名（上限 40% 宽）、工具名、+N −N、note；各列竖向对齐。
  const counts = replay.map(s => countChanges(s.diff))
  const nameWidth = Math.max(4, Math.min(Math.max(...replay.map(s => textWidth(s.file))), Math.floor(columns * 0.4)))
  const toolWidth = Math.max(...replay.map(s => s.tool.length))
  const addWidth = Math.max(...counts.map(c => `+${c.add}`.length))
  const delWidth = Math.max(...counts.map(c => `−${c.del}`.length))

  const row = (s: Step, i: number) => {
    const c = counts[i] ?? { add: 0, del: 0 }
    const name = fitStart(s.file, nameWidth)
    const isRest = i > k
    const tail = [
      <Text dimColor>{`${' '.repeat(GAP)}${pad(s.tool, toolWidth)}${' '.repeat(GAP)}`}</Text>,
      <Text color={isRest ? undefined : GREEN} dimColor={isRest}>{pad(`+${c.add}`, addWidth)}</Text>,
      <Text>{' '}</Text>,
      <Text color={isRest ? undefined : RED} dimColor={isRest}>{pad(`−${c.del}`, delWidth)}</Text>,
      s.note !== '' && <Text dimColor>{`  · ${s.note}`}</Text>,
    ]
    if (i < k) {
      return (
        <Box key={`rt-step-${i}`}>
          <Text>{'  '}<Text color={GREEN}>✓</Text>{'  '}</Text>
          <Text dimColor>{name}</Text>
          {tail}
        </Box>
      )
    }
    if (i === k) {
      return (
        <Box key={`rt-step-${i}`}>
          <Text>{'  '}<Text color={PURPLE}>›</Text>{'  '}</Text>
          <Text weight="bold">{name}</Text>
          {tail}
        </Box>
      )
    }
    return (
      <Box key={`rt-step-${i}`}>
        <Text>{' '.repeat(PREFIX)}</Text>
        <Text dimColor>{name}</Text>
        {tail}
      </Box>
    )
  }

  const more = (key: string, n: number) => (
    <Box key={key}>
      <Text dimColor>{`${' '.repeat(PREFIX)}… ${n} 步`}</Text>
    </Box>
  )
  const list = [
    win.start > 0 && more('rt-more-above', win.start),
    ...replay.slice(win.start, win.end).map((s, n) => row(s, win.start + n)),
    win.end < total && more('rt-more-below', total - win.end),
  ]

  // diff：删红字暗红底、加绿字暗绿底、上下文与 ⋯ dim；≤ maxDiff 行，超出「… 还有 N 行」。
  const indent = ' '.repeat(PREFIX)
  const lineWidth = Math.max(10, columns - PREFIX)
  const shown = step.diff.slice(0, maxDiff)
  const diff = shown.map((l, n) => {
    const key = `rt-diff-${n}`
    if (l.op === '-' || l.op === '+') {
      const isDel = l.op === '-'
      return (
        <Box key={key}>
          <Text>{indent}</Text>
          <Text color={isDel ? RED : GREEN} backgroundColor={isDel ? DEL_BG : ADD_BG}>
            {fitEnd(`${isDel ? '−' : '+'} ${l.t}`, lineWidth)}
          </Text>
        </Box>
      )
    }
    return (
      <Box key={key}>
        <Text dimColor>{indent + fitEnd(l.op === '~' ? '⋯' : `  ${l.t}`, lineWidth)}</Text>
      </Box>
    )
  })
  if (step.diff.length > maxDiff) {
    diff.push(
      <Box key="rt-diff-more">
        <Text dimColor>{`${indent}… 还有 ${step.diff.length - maxDiff} 行`}</Text>
      </Box>,
    )
  }
  if (shown.length === 0) {
    diff.push(
      <Box key="rt-diff-empty">
        <Text dimColor>{`${indent}（无行变化）`}</Text>
      </Box>,
    )
  }

  // 翻页夹在边界不动（同原版）；按下时再读一次 index，不用画的时候捕获的值。
  const go = async (delta: number) => {
    await update($, index, i => Math.max(0, Math.min(i + delta, replay.length - 1)))
  }
  // 本 mod 自己发的 $.ui.close 不会回到自己的 ui.close hook（测试 kit 实测），所以这里自己收起状态。
  // band 模式下 pane 也已 open（只是没画出来），同样要关掉，免得终端变宽后突然冒出来。
  const close = async () => {
    await update($, isOpen, () => false)
    await update($, inBand, () => false)
    await $.ui.close({ id: PANE_ID })
  }

  if (isCollapsed) {
    return (
      <Box key="rt-view" flexDirection="column">
        {title}
      </Box>
    )
  }

  return (
    <Box key="rt-view" flexDirection="column">
      {title}
      <Text>{' '}</Text>
      {list}
      <Text>{' '}</Text>
      {diff}
      <Text>{' '}</Text>
      <Box key="rt-buttons">
        <Button key="prev" hotkey="p" label="‹ p" onPress={() => go(-1)} />
        <Text>{' '}</Text>
        <Button key="next" hotkey="n" autoFocus onPress={() => go(1)}>
          <Text backgroundColor={PURPLE} color={INK}>{' n › '}</Text>
        </Button>
        <Text>{' '}</Text>
        <Button key="close" hotkey="c" label="c 关闭" onPress={close} />
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  // 斜杠命令 /replay 打开回放。
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // pane 可能已被 unload：开关复位，免得 band 卡在「已打开」。
    await update($, isOpen, () => false)
    await update($, inBand, () => false)
    await $.command.register({ name: 'replay', description: '回放上一轮的文件编辑' })
    return r
  })

  on('command.run', { command: 'replay' }, async $ => {
    const opened = await openReplay($)
    return { text: opened ? `回放：${replay.length} 处编辑` : '回放：上一轮没有编辑' }
  })

  // 记下每次编辑再放行；记录出任何错都不能挡住调用。
  on('tool.call', async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      try {
        pending.push(...(await stepsFor($, e as unknown as Record<string, unknown>)))
      } catch {
        // 记录失败不影响编辑。
      }
    }
    return next(e)
  })

  // 主循环的新一轮清空待记列表；subagent 的轮次不清，其编辑并入主轮次。
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) pending = []
    return next(e)
  })

  // 主循环一轮结束：有编辑才替换回放、从第 1 步开始；没有编辑保留上一份。
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || pending.length === 0) return r
    replay = pending
    pending = []
    await update($, index, () => 0)
    $.ui.invalidate('ui.render')
    return r
  })

  // band：提示行，或窄终端下展开的回放；永远画在上、下层附在下面。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const open = await read($, isOpen)
    const showView = open && (await read($, inBand)) && replay.length > 0
    if (!showView && (replay.length === 0 || open)) return next(e)

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    let top
    if (showView) {
      top = await replayView($, e, true, e.props.bodyColumns, e.props.maxRows)
    } else {
      // 提示胶囊全绿，封顶 10 个，超出 dim `+N`。按钮不设热键：避免抢走空输入框的第一个字母。
      const total = replay.length
      const overflow = total - Math.min(total, PILL_CAP)
      top = (
        <Box key="rt-hint">
          <Button key="rt-open" plain onPress={() => openReplay($)}>
            <Text color={PURPLE}>▶ 回放</Text>
            {'  '}
            <Text color={GREEN}>{'▰'.repeat(Math.min(total, PILL_CAP))}</Text>
            {overflow > 0 && <Text dimColor>{`+${overflow}`}</Text>}
            {'  '}
            <Text color={PURPLE} weight="bold">{`${total} 处编辑`}</Text>
            <Text dimColor>{`  ${fileCount(replay)} 个文件 · 点击或 /replay`}</Text>
          </Button>
        </Box>
      )
    }

    return (
      <Box key="rt-root" flexDirection="column">
        {top}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) =>
    replayView($, e, false, e.props.bodyColumns, 0),
  )

  // 用户关了 pane（Esc 等）：同步开关。
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) {
      await update($, isOpen, () => false)
      await update($, inBand, () => false)
    }
    return next(e)
  })
}
