// dir：命令行里 cd / pushd / git -C 移动后的目录（相对或绝对，'-' 表示无法确定）；无移动时省略
export type Risk =
  | { kind: 'rm'; label: string; targets: string[]; dir?: string }
  | {
      kind: 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout'
      label: string
      args: string[]
      dir?: string
    }
  | { kind: 'migrate'; tool: 'alembic' | 'rails' | 'prisma' | 'django' | 'unknown'; label: string; dir?: string }

export type ReportLine = { mark: '−' | 'A' | 'M' | 'D' | '?' | ' '; text: string }
export type Report = {
  summary: string
  count?: number
  extra?: string
  lines: ReportLine[]
  more?: number
  note?: string
}
