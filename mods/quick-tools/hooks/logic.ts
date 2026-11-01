// 纯逻辑：命令输出解析、按钮文字、档位支持。
//
// Step 1 实测（Claude Code 2.1.316；binary strings + 隔离 HOME 下 `claude -p` 实跑）：
// - 切换命令：`/model <id|alias>`、`/effort <level>`、`/effort ultracode on|off`
//   （`/effort ultracode` 不带 on/off 等同 on）。
//   `/effort` usage：`Usage: /effort <low|medium|high|xhigh|max|auto|ultracode [on|off]>`
// - `/model` 成功：Set model to `Opus 5.5` and saved as your default for new sessions
//   （非交互为 `… for this session only`；名字是 display name，外面套反引号）。
// - `/effort <level>`：Set effort level to xhigh (saved as your default for new sessions): …
//   （或 `(this session only)`）；本地 session 下不改 ultracode。
// - ultracode：`Ultracode on (this session only): dynamic workflows on every task. Effort stays medium.`
//   与 `Ultracode off. Effort stays medium.`
// - 报错（原样保留状态）：`Invalid argument: …`、`Ultracode isn't available on …`、
//   `Ultracode needs dynamic workflows enabled …`、`Unable to validate model: …`。
// - 档位：内置 model catalog 里 Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 5.5 都带
//   effort、xhigh_effort、max_effort；`qwe(model)` 只会被 settings 的 maxEffortLevel
//   或组织下发的上限截断，本机两者都没有 → 四个模型都支持全部 5 档。
// - 另外认得：`Effort level set to auto …`（effort 未知）、被上限截断的
//   `Effort 'max' exceeds the cap for … set to 'xhigh' instead …`、`Kept model as …`（不变）。

import type { Effort, ModelKey, Status } from '../types'

// 类型写在 types/index.d.ts（contract 须自包含），这里转出，供 register 与测试使用。
export type { Effort, ModelKey, Status }

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const MODELS: readonly { key: ModelKey; label: string; id: string }[] = [
  { key: 'fable', label: 'Fable', id: 'claude-fable-5-1' },
  { key: 'opus', label: 'Opus', id: 'claude-opus-5-5' },
  { key: 'sonnet', label: 'Sonnet', id: 'claude-sonnet-5-5' },
  { key: 'haiku', label: 'Haiku', id: 'claude-haiku-5-5' },
]

// id（claude-opus-5-5）、alias（opus）、display name（Opus 5.5）都含家族名。
export function modelKeyOf(idOrName: string): ModelKey | null {
  const name = idOrName.toLowerCase()

  return MODELS.find(m => name.includes(m.key))?.key ?? null
}

export function supportedEfforts(_model: ModelKey | null): readonly Effort[] {
  return EFFORTS
}

function asEffort(word: string | undefined): Effort | null {
  return EFFORTS.find(e => e === word) ?? null
}

export function applyCommandResult(
  s: Status,
  command: 'model' | 'effort',
  _args: string,
  output: string,
): Status {
  // 输出可能带 ANSI 样式和前导空白（交互模式的 local-jsx 命令）。
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trimStart()

  if (command === 'model') {
    const name = /^Set model to `([^`]+)`/.exec(text)?.[1]

    // effort 按模型分开存，输出里没有：未知，等下一次主循环 turn.step 报上来。
    return name === undefined ? s : { ...s, model: modelKeyOf(name), effort: null }
  }

  const level = asEffort(
    (/^Set effort level to (\w+)/.exec(text) ?? / set to '(\w+)' instead/.exec(text))?.[1],
  )
  if (level !== null) {
    return { ...s, effort: level }
  }

  if (/^Effort level set to auto\b/.test(text)) {
    return { ...s, effort: null }
  }

  const ultra = /^Ultracode (on|off)\b/.exec(text)?.[1]
  if (ultra !== undefined) {
    const stays = asEffort(/Effort stays (\w+)\./.exec(text)?.[1])

    return { ...s, ultracode: ultra === 'on', effort: stays ?? s.effort }
  }

  return s
}

export function buttonLabel(s: Status, isOpen: boolean): string {
  const model = MODELS.find(m => m.key === s.model)?.label ?? '?'

  return `⚡ ${model} · ${s.effort ?? '?'}${s.ultracode ? ' · ✦' : ''}${isOpen ? ' ▾' : ''}`
}
