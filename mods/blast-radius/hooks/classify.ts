// 命令文本 → Risk | null。逐段移植自 claude-code-playground 的 Blast Radius（Apache-2.0）
import type { Risk } from '../types'

export type { Report, ReportLine, Risk } from '../types'

// 目录：null 表示会话目录（没被移动过）
type Dir = string | null
// 一段的结果：危险命令、目录变化（cd / pushd / popd）、或无关
type SegmentResult = Risk | { cd: Dir } | null

// sudo 里带值的选项，值不能当成命令
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// 只读命令，参数里出现 migrate 也不算 migration
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git'])
// 放在真正命令前面、不改变其行为的词
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** 之后 `cd arg` 会到的目录；dir 为当前目录（null = 会话目录） */
function joinDir(dir: Dir, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) {
    return arg ?? '~'
  }
  return dir ? `${dir}/${arg}` : arg
}

/** 按引号拆词，够读 flag 和路径用 */
function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
}

/** 有目录时带上 dir，null 时省略 */
function withDir(risk: Risk, dir: Dir): Risk {
  return dir === null ? risk : { ...risk, dir }
}

/** 整行命令里第一个危险段，或 null */
export function classify(command: string): Risk | null {
  let dir: Dir = null // 本行前面的 cd 移到的目录
  const scopes: Dir[] = [] // ( 子 shell ) 结束时要恢复的目录
  const pushed: Dir[] = [] // pushd 栈，给 popd 用
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // 末尾的重定向和 & 不挡住右括号：`(cd sub && make) > log`
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir)
    }
    const result = classifySegment(raw, dir, pushed)
    if (result !== null && !('cd' in result)) {
      return result
    }
    if (result !== null) {
      dir = result.cd // cd、pushd 或 popd 移动了目录
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop() ?? null // ( … ) 里的 cd 不外溢
    }
  }
  return null
}

/** 单段：危险命令、{ cd } 目录变化、或 null */
function classifySegment(segment: string, dir: Dir, pushed: Dir[]): SegmentResult {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
  while (words.length > 0 && ASSIGNMENT.test(words[0] ?? '')) {
    words.shift() // 开头的 VAR=value
  }
  if (words[0] === 'sudo') {
    words.shift()
    while (words.length > 0 && (words[0] ?? '').startsWith('-')) {
      const option = words.shift() ?? ''
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift()
      }
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0] ?? '') || ASSIGNMENT.test(words[0] ?? ''))) {
    words.shift()
  }
  if (words[0] === 'nice') {
    words.shift()
    const level: string | undefined = words[0]
    if (level === '-n') {
      words.splice(0, 2)
    } else if (/^-\d+$/.test(level ?? '')) {
      words.shift()
    }
  }
  const [first, ...args] = words
  if (first === undefined) {
    return null
  }
  const cmd = first.replace(/^\\/, '') // \rm 绕过 alias，仍是 rm
  if (cmd === 'cd') {
    return { cd: args[0] === '-' ? '-' : joinDir(dir, args[0]) }
  }
  if (cmd === 'pushd') {
    pushed.push(dir)
    return { cd: joinDir(dir, args[0]) }
  }
  if (cmd === 'popd') {
    return { cd: pushed.length > 0 ? (pushed.pop() ?? null) : '-' }
  }
  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter((a) => a.startsWith('-'))
    const recursive = flags.some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const force = flags.some((f) => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (recursive || force) {
      const targets = args.filter((a) => !a.startsWith('-') || a === '-')
      return withDir({ kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets }, dir)
    }
  }
  if (cmd === 'git') {
    // git 自己的选项在子命令前；-C 改变运行目录
    let gitDir = dir
    let i = 0
    while (i < args.length && (args[i] ?? '').startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) {
        gitDir = joinDir(gitDir, args[i + 1])
        i += 2
      } else if (args[i] === '-c' && i + 1 < args.length) {
        i += 2
      } else {
        i += 1
      }
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (sub === 'reset' && rest.includes('--hard')) {
      return withDir({ kind: 'git-reset', label: 'git reset --hard', args: rest }, gitDir)
    }
    if (sub === 'clean') {
      return withDir({ kind: 'git-clean', label: 'git clean', args: rest }, gitDir)
    }
    if (
      sub === 'push' &&
      rest.some((a) => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))
    ) {
      return withDir({ kind: 'git-push-force', label: 'git push --force', args: rest }, gitDir)
    }
    const stagedOnly =
      sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !stagedOnly) {
      return withDir({ kind: 'git-checkout', label: `git ${sub} -- .`, args: rest }, gitDir)
    }
  }
  const joined = words.join(' ')
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return withDir({ kind: 'migrate', tool: 'alembic', label: 'alembic upgrade' }, dir)
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return withDir({ kind: 'migrate', tool: 'rails', label: 'db:migrate' }, dir)
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return withDir({ kind: 'migrate', tool: 'prisma', label: 'prisma migrate' }, dir)
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return withDir({ kind: 'migrate', tool: 'django', label: 'manage.py migrate' }, dir)
  }
  if (!READ_ONLY.has(cmd) && args.includes('migrate')) {
    return withDir({ kind: 'migrate', tool: 'unknown', label: 'migrate' }, dir)
  }
  return null
}
