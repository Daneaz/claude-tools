import { expect, test } from 'claude-code/testing'

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
  toolHint,
  truncate,
} from '../hooks/logic'
import type { Agent } from '../hooks/logic'

function agentOf(over: Partial<Agent> & { agentId: string }): Agent {
  return {
    type: 'general-purpose',
    description: '',
    state: 'running',
    startedAt: 0,
    toolCalls: 0,
    ...over,
  }
}

test('avatarFor uses the table and guesses the rest', async () => {
  expect(avatarFor('general-purpose')).toEqual({ avatar: '🧰', name: 'General' })
  expect(avatarFor('explore').avatar).toBe('🔭')
  expect(avatarFor('Explore')).toEqual({ avatar: '🔭', name: 'Explore' })
  expect(avatarFor('combat-designer')).toEqual({ avatar: '🥊', name: 'Combat' })
  expect(avatarFor('code-reviewer')).toEqual({ avatar: '🔍', name: 'CodeRevie…' })
  expect(avatarFor('foo')).toEqual({ avatar: '🧩', name: 'Foo' })
  expect(avatarFor('security_audit').avatar).toBe('🔒')
  expect(avatarFor('tech-writer').avatar).toBe('📝')
})

test('avatarFor strips a plugin prefix', async () => {
  expect(avatarFor('superpowers:code-reviewer')).toEqual({ avatar: '🔍', name: 'CodeRevie…' })
  expect(avatarFor('game:designer')).toEqual({ avatar: '🎨', name: 'Designer' })
  expect(avatarFor('a:b:Explore')).toEqual({ avatar: '🔭', name: 'Explore' })
})

test('spawnAgent appends and ignores duplicate ids', async () => {
  const list = spawnAgent([], { agentId: 'a', type: 'Explore', description: '搜', now: 5 })
  expect(list).toEqual([
    { agentId: 'a', type: 'Explore', description: '搜', state: 'running', startedAt: 5, toolCalls: 0 },
  ])
  expect(spawnAgent(list, { agentId: 'a', type: 'Plan', description: 'x', now: 9 })).toBe(list)
})

test('endAgent only ends running agents', async () => {
  const list = [agentOf({ agentId: 'a' }), agentOf({ agentId: 'b', state: 'killed', endedAt: 3 })]
  const next = endAgent(list, 'a', 'completed', 10)
  expect(next[0]?.state).toBe('completed')
  expect(next[0]?.endedAt).toBe(10)
  expect(endAgent(next, 'b', 'failed', 20)[1]).toEqual(list[1])
})

test('endStateOf maps reasons', async () => {
  expect(endStateOf('answer')).toBe('completed')
  expect(endStateOf('aborted')).toBe('killed')
  expect(endStateOf('error')).toBe('failed')
  expect(endStateOf('refusal')).toBe('failed')
})

test('toolHint picks the telling field', async () => {
  expect(toolHint('Grep', { pattern: 'useAuth' })).toBe('"useAuth"')
  expect(toolHint('Read', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  expect(toolHint('Bash', { description: '跑测试', command: 'npm test' })).toBe('跑测试')
  expect(toolHint('Bash', { command: 'x'.repeat(40) })).toBe('x'.repeat(29) + '…')
  expect(toolHint('Mystery', { a: 1 })).toBe('')
})

test('recordTool counts every tool, plan tools included', async () => {
  let list = spawnAgent([], { agentId: 'a', type: 'Explore', description: '搜', now: 0 })
  list = recordTool(list, 'a', 'Read', { file_path: '/a/b.ts' })
  expect(list[0]?.lastTool).toEqual({ tool: 'Read', hint: 'b.ts' })
  list = recordTool(list, 'a', 'TodoWrite', {})
  expect(list[0]?.toolCalls).toBe(2)
  expect(list[0]?.lastTool).toEqual({ tool: 'TodoWrite', hint: '' })
})

test('resume keeps toolCalls and restarts the clock', async () => {
  let list = [agentOf({ agentId: 'a', toolCalls: 3 })]
  list = endAgent(list, 'a', 'completed', 500)
  list = resumeAgent(list, 'a', 1000)
  expect(list[0]?.state).toBe('running')
  expect(list[0]?.startedAt).toBe(1000)
  expect(list[0]?.toolCalls).toBe(3)
  expect(list[0]?.endedAt).toBe(undefined)
})

test('sweep bounces 3 lit cells across 10', async () => {
  const lit = (f: number) => sweep(f).flatMap((on, i) => (on ? [i] : []))
  expect(lit(0)).toEqual([0, 1, 2])
  expect(lit(7)).toEqual([7, 8, 9])
  expect(lit(8)).toEqual([6, 7, 8])
  for (let f = 0; f < 20; f++) {
    expect(sweep(f).length).toBe(10)
    expect(lit(f).length).toBe(3)
  }
})

test('overview counts only', async () => {
  const list = [
    agentOf({ agentId: 'a' }),
    agentOf({ agentId: 'b' }),
    agentOf({ agentId: 'c', state: 'completed', endedAt: 1 }),
    agentOf({ agentId: 'd', state: 'failed', endedAt: 2 }),
    agentOf({ agentId: 'e', state: 'killed', endedAt: 3 }),
  ]
  expect(overviewOf(list)).toEqual({ running: 2, completed: 1, failed: 2 })
  expect(overviewOf([])).toEqual({ running: 0, completed: 0, failed: 0 })
})

test('formatters', async () => {
  expect(formatElapsed(40000)).toBe('0m40s')
  expect(formatElapsed(252000)).toBe('4m12s')
  expect(formatElapsed(3780000)).toBe('1h03m')
})

test('ordered keeps spawn order and sorts ended by endedAt desc', async () => {
  const list = [
    agentOf({ agentId: 'r1' }),
    agentOf({ agentId: 'e1', state: 'completed', endedAt: 10 }),
    agentOf({ agentId: 'r2' }),
    agentOf({ agentId: 'e2', state: 'failed', endedAt: 30 }),
    agentOf({ agentId: 'e3', state: 'killed', endedAt: 20 }),
  ]
  const { running, ended } = ordered(list)
  expect(running.map(a => a.agentId)).toEqual(['r1', 'r2'])
  expect(ended.map(a => a.agentId)).toEqual(['e2', 'e3', 'e1'])
})

test('emoji count as two columns', async () => {
  for (const e of ['📟', '🔒', '📊', '🔭', '🧰', '🥊']) expect(textWidth(e)).toBe(2)
  expect(truncate('CodeReviewer', 10)).toBe('CodeRevie…')
  expect(fit('🔭 Explore', 12)).toBe('🔭 Explore  ')
})

test('language picks chinese from settings, english otherwise', async () => {
  for (const v of ['中文', '简体中文', 'Chinese', 'zh-CN', ' 汉语 ']) expect(pickLang(v)).toBe('zh')
  for (const v of ['English', 'japanese', '', undefined, 42]) expect(pickLang(v)).toBe('en')
})

test('strings in both languages', async () => {
  const zh = strings('zh')
  const en = strings('en')
  expect([zh.running(3), zh.done(1), zh.failed(2)]).toEqual(['3 在跑', '1 完成', '2 失败'])
  expect([en.running(3), en.done(1), en.failed(2)]).toEqual(['3 running', '1 done', '2 failed'])
  expect([zh.toolCalls(7), zh.calls(7)]).toEqual(['7 次工具', '7 次'])
  expect([en.toolCalls(1), en.toolCalls(7), en.calls(1), en.calls(7)]).toEqual([
    '1 tool call',
    '7 tool calls',
    '1 call',
    '7 calls',
  ])
  expect([zh.starting, zh.ended, zh.killed, zh.failedEnd]).toEqual(['启动中', '已结束', '已停止', '失败'])
  expect([en.starting, en.ended, en.killed, en.failedEnd]).toEqual(['starting', 'Ended', 'stopped', 'failed'])
  expect([zh.empty1, zh.empty2]).toEqual(['这个 session 还没派出 subagent。', '派出后会出现在这里。'])
  expect([en.empty1, en.empty2]).toEqual(['No subagents in this session yet.', 'They show up here once dispatched.'])
})
