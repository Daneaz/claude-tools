// measure / resolveDir 的测试。
// 说明：`claude plugin test` 的环境不能 import Node 内置模块（只允许相对路径和 'claude-code'），
// 测试里的 `$` 也没有 `$.process`，所以这里的 Run 是按 argv 回固定输出的桩：
// 验证传给外部命令的 argv（路径只作参数、不进脚本源码）与对输出的解析。
// 脚本本身（RM_SCRIPT / CD_SCRIPT / git）在真实临时目录里的行为由仓库外的 harness 另行验证，见 task-2 报告。
import { expect, test } from 'claude-code/testing'

import { measure, resolveDir } from '../hooks/measure'
import type { Run } from '../hooks/measure'
import type { Risk } from '../hooks/classify'

type Reply = { code?: number; stdout?: string; stderr?: string } | Error

/** 按 argv 前缀（空格拼接）回固定输出；记下每次调用 */
function stub(table: [prefix: string, reply: Reply][]) {
  const calls: { argv: string[]; cwd: string }[] = []
  const run: Run = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd })
    const joined = argv.join(' ')
    const hit = table.find(([prefix]) => joined.startsWith(prefix))
    if (hit === undefined) {
      throw new Error(`桩里没有 ${joined}`)
    }
    const reply = hit[1]
    if (reply instanceof Error) {
      throw reply
    }
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }
  return { run, calls }
}

const rmRisk = (...targets: string[]): Risk => ({ kind: 'rm', label: 'rm -rf', targets })
const gitRisk = (kind: 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout', args: string[] = []): Risk => ({
  kind,
  label: kind === 'git-reset' ? 'git reset --hard' : kind === 'git-clean' ? 'git clean' : kind === 'git-push-force' ? 'git push --force' : 'git checkout -- .',
  args,
})

test('rm counts files', async () => {
  const { run, calls } = stub([['bash -c', { stdout: '3 3072 1\n./build/a.js\n./build/b.js\n./build/c.js\n' }]])
  const report = await measure(run, rmRisk('build'), '/work')
  expect(report.count).toBe(3)
  expect(report.summary).toContain('删除 3 个文件')
  expect(report.extra).toBe('3.0 KB')
  expect(report.lines).toEqual([
    { mark: '−', text: 'build/a.js' },
    { mark: '−', text: 'build/b.js' },
    { mark: '−', text: 'build/c.js' },
  ])
  expect(calls[0]?.cwd).toBe('/work')
})

test('rm caps list', async () => {
  const listed = Array.from({ length: 10 }, (_, i) => `./f${i}`).join('\n')
  const { run } = stub([['bash -c', { stdout: `12 12288 1\n${listed}\n` }]])
  const report = await measure(run, rmRisk('*'), '/work')
  expect(report.lines.length).toBe(10)
  expect(report.more).toBe(2)
  expect(report.count).toBe(12)
})

test('rm path that looks like a find action', async () => {
  // 路径（含 glob）只作为 bash 的位置参数传入，绝不拼进脚本源码；脚本给相对路径加 ./ 再交给 find
  const { run, calls } = stub([['bash -c', { stdout: '2 0 2\n./-delete\n./keep\n' }]])
  const report = await measure(run, rmRisk('*'), '/work')
  const argv = calls[0]?.argv ?? []
  expect(argv.slice(0, 2)).toEqual(['bash', '-c'])
  expect(argv.slice(3)).toEqual(['blast-radius', '*'])
  // 脚本源码与目标无关
  await measure(run, rmRisk('-delete', '$(touch pwned)'), '/work')
  expect(calls[1]?.argv[2]).toBe(argv[2])
  expect(calls[1]?.argv.slice(3)).toEqual(['blast-radius', '-delete', '$(touch pwned)'])
  expect(argv[2]).toContain('paths[$i]="./${paths[$i]}"')
  expect(report.count).toBe(2)
  expect(report.lines).toContainEqual({ mark: '−', text: '-delete' })
})

test('rm missing path', async () => {
  const { run } = stub([['bash -c', { stdout: '0 0 0\n' }]])
  const report = await measure(run, rmRisk('nope'), '/work')
  expect(report.count ?? 0).toBe(0)
  expect(report.summary).toContain('没有匹配')
  expect(report.lines).toEqual([])
})

test('rm with no targets does not run anything', async () => {
  const { run, calls } = stub([])
  const report = await measure(run, rmRisk(), '/work')
  expect(calls.length).toBe(0)
  expect(report.note ?? '').not.toBe('')
})

test('git reset lists changes', async () => {
  const { run, calls } = stub([
    ['git status --porcelain', { stdout: 'A  NOTES.md\n M src/math.js\n?? junk.txt\n' }],
    ['git diff --shortstat HEAD', { stdout: ' 2 files changed, 2 insertions(+), 1 deletion(-)\n' }],
  ])
  const report = await measure(run, gitRisk('git-reset'), '/repo')
  expect(report.summary).toContain('丢弃 2 个文件的未提交改动')
  expect(report.count).toBe(2)
  expect(report.extra).toBe('+2 −1')
  expect(report.lines).toContainEqual({ mark: 'A', text: 'NOTES.md' })
  expect(report.lines).toContainEqual({ mark: 'M', text: 'src/math.js' })
  expect(report.lines.length).toBe(2) // 未跟踪的 ?? 不算
  expect(calls.map((c) => c.cwd)).toEqual(['/repo', '/repo'])
})

test('git checkout keeps only unstaged changes', async () => {
  const { run, calls } = stub([
    ['git status --porcelain', { stdout: 'A  staged.txt\n M a.txt\nMD b.txt\n' }],
    ['git diff --shortstat --', { stdout: ' 1 file changed, 3 deletions(-)\n' }],
  ])
  const report = await measure(run, gitRisk('git-checkout', ['--', '.']), '/repo')
  expect(report.lines).toEqual([
    { mark: 'M', text: 'a.txt' },
    { mark: 'D', text: 'b.txt' },
  ])
  expect(report.extra).toBe('−3')
  expect(calls[1]?.argv).toEqual(['git', 'diff', '--shortstat', '--'])
})

test('git clean dry run', async () => {
  const { run, calls } = stub([['git clean', { stdout: 'Would remove a.tmp\nWould remove b.tmp\n' }]])
  const report = await measure(run, gitRisk('git-clean', ['-fdx', '-e', 'keep', 'sub']), '/repo')
  // -f / -i / -q 去掉，-n 由测量自己加；路径放在 -- 之后
  expect(calls[0]?.argv).toEqual(['git', 'clean', '-n', '-dx', '-e', 'keep', '--', 'sub'])
  expect(report.count).toBe(2)
  expect(report.summary).toContain('清理 2 个未跟踪路径')
  expect(report.lines).toEqual([
    { mark: '?', text: 'a.tmp' },
    { mark: '?', text: 'b.tmp' },
  ])
})

test('push without fetch', async () => {
  const { run } = stub([
    ['git rev-parse --abbrev-ref HEAD', { stdout: 'main\n' }],
    ['git rev-parse --verify --quiet origin/main', { code: 1 }],
  ])
  const report = await measure(run, gitRisk('git-push-force', ['--force']), '/repo')
  expect(report.note ?? '').toContain('git fetch')
  expect(report.lines).toEqual([])
})

test('push lists dropped commits', async () => {
  const { run, calls } = stub([
    ['git rev-parse --verify --quiet up/dev', { stdout: 'abc\n' }],
    ['git log', { stdout: 'abc123 one\ndef456 two\n' }],
  ])
  const report = await measure(run, gitRisk('git-push-force', ['-f', 'up', 'feat:dev']), '/repo')
  expect(calls[1]?.argv).toEqual(['git', 'log', '--oneline', '--no-decorate', 'feat..up/dev'])
  expect(report.count).toBe(2)
  expect(report.summary).toBe('丢掉 up/dev 上 2 个 commit')
  expect(report.lines).toEqual([
    { mark: '−', text: 'abc123 one' },
    { mark: '−', text: 'def456 two' },
  ])
})

test('migrations are listed by the tool', async () => {
  const { run } = stub([['python3 manage.py showmigrations --plan', { stdout: '[X]  app.0001_initial\n[ ]  app.0002_add\n[ ]  app.0003_more\n' }]])
  const report = await measure(run, { kind: 'migrate', tool: 'django', label: 'manage.py migrate' }, '/proj')
  expect(report.count).toBe(2)
  expect(report.summary).toContain('执行 2 个待跑 migration')
  expect(report.lines).toEqual([
    { mark: ' ', text: 'app.0002_add' },
    { mark: ' ', text: 'app.0003_more' },
  ])
})

test('migration lister that fails or is unknown', async () => {
  const { run } = stub([['bin/rails', new Error('spawn bin/rails ENOENT')]])
  const failed = await measure(run, { kind: 'migrate', tool: 'rails', label: 'db migrate' }, '/proj')
  expect(failed.note ?? '').toContain('bin/rails db:migrate:status')
  const unknown = await measure(stub([]).run, { kind: 'migrate', tool: 'unknown', label: 'migrate' }, '/proj')
  expect(unknown.note ?? '').not.toBe('')
  expect(unknown.lines).toEqual([])
})

test('not a repo', async () => {
  const { run } = stub([['git status', { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }]])
  const report = await measure(run, gitRisk('git-reset'), '/tmp')
  expect(report.note ?? '').not.toBe('')
  expect(report.lines).toEqual([])
})

test('a run that throws is reported, not thrown', async () => {
  const { run } = stub([['bash -c', new Error('timed out')]])
  const report = await measure(run, rmRisk('build'), '/work')
  expect(report.note ?? '').toContain('timed out')
  expect(report.lines).toEqual([])
})

test('resolveDir', async () => {
  const ok = stub([['bash -c', { stdout: '/abs/sub\n' }]])
  expect(await resolveDir(ok.run, '/abs', 'sub')).toBe('/abs/sub')
  // 目录只作为参数传入，cwd 为会话目录
  expect(ok.calls[0]?.argv.slice(3)).toEqual(['blast-radius', 'sub'])
  expect(ok.calls[0]?.cwd).toBe('/abs')

  const missing = stub([['bash -c', { code: 1 }]])
  expect(await resolveDir(missing.run, '/abs', 'nope')).toBe(null)

  const dash = stub([])
  expect(await resolveDir(dash.run, '/abs', '-')).toBe(null)
  expect(dash.calls.length).toBe(0)
})
