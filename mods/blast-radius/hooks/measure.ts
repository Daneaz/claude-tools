// Risk + cwd → Report：量出危险命令会影响什么。移植自 claude-code-playground 的 Blast Radius（Apache-2.0）
// 外部命令一律经注入的 run 按 argv 执行（无 shell 拼接），路径只作参数
import type { Report, ReportLine, Risk } from '../types'

/** 跑一个外部命令；register 里由 $.process.run 适配而来 */
export type Run = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>

type GitRisk = Extract<Risk, { args: string[] }>
type MigrateRisk = Extract<Risk, { kind: 'migrate' }>
type RmRisk = Extract<Risk, { kind: 'rm' }>

const LIST_MAX = 10

// 把 cd 目标解析成绝对目录，不存在则无输出。目标作为参数传入，从不当源码
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`

/** cd 目标的绝对路径；不存在或 `cd -`（依赖 shell 历史）时为 null */
export async function resolveDir(run: Run, sessionCwd: string, dir: string): Promise<string | null> {
  if (dir === '-') {
    return null
  }
  const result = await run(['bash', '-c', CD_SCRIPT, 'blast-radius', dir], { cwd: sessionCwd, timeoutMs: 5000 })
  const out = result.stdout.trim()
  return result.code === 0 && out !== '' ? out : null
}

/** 给 pane 的报告。从不抛出：量不了就照实说 */
export async function measure(run: Run, risk: Risk, cwd: string): Promise<Report> {
  try {
    if (risk.kind === 'rm') {
      return await measureRm(run, risk, cwd)
    }
    if (risk.kind === 'migrate') {
      return await measureMigrations(run, risk, cwd)
    }
    return await measureGit(run, risk, cwd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { summary: `${risk.label}（量不了）`, lines: [], note: `量不了：${message.slice(0, 200)}` }
  }
}

// 路径作为参数交给 bash，从不当源码，所以里面什么都不会被执行。compgen -G 展开 glob 但不做命令替换
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# 相对路径前加 ./，find 就不会把 -delete 这样的名字当成动作
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`

async function measureRm(run: Run, risk: RmRisk, cwd: string): Promise<Report> {
  if (risk.targets.length === 0) {
    return { summary: 'rm 没有给路径', lines: [], note: '没有可展开的路径。' }
  }
  const result = await run(['bash', '-c', RM_SCRIPT, 'blast-radius', ...risk.targets], { cwd, timeoutMs: 15000 })
  const [head, ...rest] = result.stdout.split('\n').filter((l) => l !== '')
  const [files = 0, bytes = 0, found = 0] = (head ?? '0 0 0').split(' ').map(Number)
  const paths = risk.targets.join(' ')
  if (!found) {
    return { summary: `不会删除：没有匹配 ${paths} 的文件`, lines: [], note: '路径不存在，rm 没有东西可删。' }
  }
  if (!files) {
    return { summary: `删除 ${found} 个路径（里面没有文件）`, lines: [], note: `路径：${paths}` }
  }
  return {
    summary: `删除 ${files} 个文件`,
    count: files,
    extra: size(bytes),
    lines: rest.map((l) => ({ mark: '−', text: l.replace(/^\.\//, '') })),
    more: Math.max(0, files - rest.length),
    note: `路径：${paths}`,
  }
}

/** porcelain 状态字母 → 行首标记；不认识的留空 */
function markOf(letter: string | undefined): ReportLine['mark'] {
  return letter === 'A' || letter === 'M' || letter === 'D' ? letter : ' '
}

/** `git diff --shortstat` → `+N −N`；没有增删时为 undefined */
function shortstat(text: string): string | undefined {
  const added = text.match(/(\d+) insertions?\(\+\)/)?.[1]
  const removed = text.match(/(\d+) deletions?\(-\)/)?.[1]
  const parts = [added && `+${added}`, removed && `−${removed}`].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : undefined
}

async function measureGit(run: Run, risk: GitRisk, cwd: string): Promise<Report> {
  if (risk.kind === 'git-push-force') {
    return await measurePush(run, risk, cwd)
  }
  if (risk.kind === 'git-clean') {
    const flags: string[] = []
    const paths: string[] = []
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i] ?? ''
      if (a === '--') {
        paths.push(...risk.args.slice(i + 1))
        break
      }
      if (a === '-e' || a === '--exclude') {
        flags.push(a, risk.args[i + 1] ?? '')
        i += 1
      } else if (a.startsWith('--exclude=') || /^-e./.test(a)) {
        flags.push(a)
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, '') // -n 由下面加；-f、-i、-q 会改变 dry run
        if (kept !== '-') {
          flags.push(kept)
        }
      } else if (!a.startsWith('-')) {
        paths.push(a)
      }
    }
    const result = await run(['git', 'clean', '-n', ...flags, '--', ...paths], { cwd, timeoutMs: 15000 })
    if (result.code !== 0) {
      return { summary: 'git clean（没法 dry run）', lines: [], note: result.stderr.trim().slice(0, 200) || 'git clean -n 失败。' }
    }
    const gone = result.stdout
      .split('\n')
      .filter((l) => l.startsWith('Would remove '))
      .map((l) => l.slice(13))
    return {
      summary: gone.length === 0 ? '不会清理：没有匹配的未跟踪文件' : `清理 ${gone.length} 个未跟踪路径`,
      count: gone.length,
      lines: gone.slice(0, LIST_MAX).map((text) => ({ mark: '?', text })),
      more: Math.max(0, gone.length - LIST_MAX),
      note: '来自 git clean -n。未跟踪的文件不在 git 里，删了无法恢复。',
    }
  }
  const status = await run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 15000 })
  if (status.code !== 0) {
    return { summary: `${risk.label}（这里不是 git 仓库？）`, lines: [], note: status.stderr.trim().slice(0, 200) || 'git status 失败。' }
  }
  const rows = status.stdout.split('\n').filter((l) => l.length > 3 && !l.startsWith('??'))
  // reset --hard 丢掉已暂存和未暂存的改动；checkout -- . 只丢未暂存的
  const isReset = risk.kind === 'git-reset'
  const lost = isReset ? rows : rows.filter((l) => l[1] !== ' ')
  const stat = await run(['git', 'diff', '--shortstat', isReset ? 'HEAD' : '--'], { cwd, timeoutMs: 15000 })
  return {
    summary: lost.length === 0 ? '不会丢弃：没有未提交的改动' : `丢弃 ${lost.length} 个文件的未提交改动`,
    count: lost.length,
    extra: shortstat(stat.stdout),
    lines: lost.slice(0, LIST_MAX).map((l) => ({
      // reset 看暂存区字母优先，checkout 只看工作区字母
      mark: markOf(isReset && l[0] !== ' ' ? l[0] : l[1]),
      text: l.slice(3),
    })),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== '' ? '未提交的改动无法恢复。' : '来自 git status --porcelain。',
  }
}

async function measurePush(run: Run, risk: GitRisk, cwd: string): Promise<Report> {
  const positional = risk.args.filter((a) => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  // refspec 是 src:dst；没有冒号时推同名本地分支
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source, branch] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = (branch ?? '').replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    // 不写分支或写 HEAD：推当前分支到同名远端分支
    const head = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })
    branch = head.stdout.trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await run(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd, timeoutMs: 10000 })
  if (known.code !== 0) {
    return { summary: `强推到 ${ref}`, lines: [], note: `本地没有 ${ref} 的副本，判断不了会丢掉哪些 commit。先运行 git fetch。` }
  }
  const log = await run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], { cwd, timeoutMs: 15000 })
  const dropped = log.stdout.split('\n').filter((l) => l !== '')
  return {
    summary: dropped.length === 0 ? `强推到 ${ref}：不会丢掉 commit` : `丢掉 ${ref} 上 ${dropped.length} 个 commit`,
    count: dropped.length,
    lines: dropped.slice(0, LIST_MAX).map((text) => ({ mark: '−', text })),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `${ref} 上有、${source} 没有的 commit（以上次 fetch 为准）。`,
  }
}

type Lister = { argv: string[]; pending: (l: string) => boolean; strip: (l: string) => string }

const MIGRATION_LISTERS: Partial<Record<MigrateRisk['tool'], Lister>> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], pending: (l) => l.startsWith('[ ]'), strip: (l) => l.slice(4).trim() },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], pending: (l) => l.includes('->'), strip: (l) => l },
  rails: { argv: ['bin/rails', 'db:migrate:status'], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ['npx', '--no-install', 'prisma', 'migrate', 'status'], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
}

async function measureMigrations(run: Run, risk: MigrateRisk, cwd: string): Promise<Report> {
  const lister = MIGRATION_LISTERS[risk.tool]
  if (lister === undefined) {
    return { summary: '执行 migration', lines: [], note: '这个工具列不出待跑的 migration，所以不显示列表。' }
  }
  let result: Awaited<ReturnType<Run>>
  try {
    result = await run(lister.argv, { cwd, timeoutMs: 20000 })
  } catch (error) {
    result = { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
  const command = lister.argv.join(' ')
  if (result.code !== 0) {
    return { summary: `执行 ${risk.label}`, lines: [], note: `列不出待跑的 migration（${command} 失败）。` }
  }
  const pending = result.stdout.split('\n').filter(lister.pending).map(lister.strip)
  return {
    summary: pending.length === 0 ? `${risk.label}：没有待跑的 migration` : `执行 ${pending.length} 个待跑 migration`,
    count: pending.length,
    lines: pending.slice(0, LIST_MAX).map((text) => ({ mark: ' ', text })),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `来自 ${command}。`,
  }
}

/** 字节数 → 人读的大小，如 1.1 MB */
function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}
