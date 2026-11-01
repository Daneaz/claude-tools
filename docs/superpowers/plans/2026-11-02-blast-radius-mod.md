# blast-radius mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claude-code-playground 的 Blast Radius 移植进本仓库：拦住危险 Bash 命令、量出影响、等用户「执行 / 取消」，外观换成用户选定的 B 版（无框 + 琥珀色左竖线），文案中文。

**Architecture:** 纯逻辑拆两层：`classify.ts`（命令文本 → `Risk | null`，无 `$`）、`measure.ts`（`Risk` + cwd → `Report`，通过注入的 `run` 函数调外部命令，便于测试）。`register.tsx` 只做 hold 队列、Pane / band 切换和渲染。

**Tech Stack:** Claude Code mod API（TSX，全局 `h`），`claude-code/testing`；运行时依赖 `bash`、`git`、`find`、`du`。

**Spec:** `docs/superpowers/specs/2026-11-02-blast-radius-mod-design.md`（执行者必须先读完）

## Global Constraints

- 原版源码是行为的唯一依据，执行者先取下来对照（Apache-2.0，README 注明改编来源）：
  `gh api -H "Accept: application/vnd.github.raw" repos/anthropics/claude-code-playground/contents/claude-code/mods/blast-radius/hooks/blast-radius.mjs > /tmp/<自选>/blast-radius.mjs`
- 写代码前先调用 `plugin-authoring` skill 查当前 mod API（`$.process.run`、`$.ui.open`、`isPlaced`、`next.signal`、theme key、测试桩写法）；原版是 2.1.280 的 `.mjs`，API 若有出入以当前 API 为准，行为不变。
- mod 目录 `mods/blast-radius/`，结构同 `mods/task-progress/`：`.claude-plugin/plugin.json`、`hooks/hooks.json`（`{ "modules": ["./register.tsx"] }`）、`hooks/*.ts(x)`、`types/index.d.ts`、`test/*.test.ts(x)`。
- `plugin.json`：`{ "name": "blast-radius", "version": "0.1.0", "author": { "name": "Daneaz" }, "description": "Holds risky shell commands (rm -rf, git reset --hard, git clean, force push, migrations) and shows what they would change before they run.", "types": "./types/index.d.ts" }`
- 常量：`PANE_ID = 'blast-radius'`、轮询 `sleep 0.25`、`HOLD_LIMIT_MS = 600_000`、`LIST_MAX = 10`。
- 颜色：琥珀 `#ffb84d`、红 `#ff5f5f`、绿 / 蓝 / dim / 暗同 task-progress（`success`、`suggestion`、`inactive`、`subtle`）。琥珀与红优先找对口 theme key（如 `warning`、`error`），没有再用 hex。
- 字形：左竖线 `▎`、规模胶囊 `▰`（最多 10 个，= `min(count, 10)`；无计数的类型不画）、删除前缀 `−`。
- 中文文案（原样）：`⚠ 拦截`、`1 执行`、`2 取消`、`Claude 在等你决定`、`… 还有 N 个`。摘要例：`删除 9 个文件`、`丢弃 2 个文件的未提交改动`、`清理 N 个未跟踪路径`、`丢掉远端 N 个 commit`、`执行 N 个待跑 migration`。`deny` 文案给模型看，用英文、照搬原版句式。
- 焦点默认在「取消」。永远不经 shell 拼接路径；相对路径给 `find` 前加 `./`。
- 验证命令（全绿才算完）：`claude plugin validate mods/blast-radius`、`tsc -p mods/blast-radius`（无 tsconfig 时按 plugin-authoring 用外部 tsconfig，同 task-progress 做法）、`claude plugin test mods/blast-radius`。
- 代码注释用中文。

## Review Focus

1. 文件名像 `find` 动作（`-delete`）被 glob 匹配到 → 测量时不执行它（Task 2 测试 `rm path that looks like a find action`）。
2. `cd build && rm -rf .` → 在 `build` 里测量；`(cd x && rm -rf y); rm -rf z` 的 `cd` 不外溢（Task 1 测试 `cd follows`、`subshell cd stays inside`）。
3. 同时两个危险调用 → 第二个排队，按钮只回答画出时的那条（Task 3 测试 `second hold waits`）。
4. Esc 中断 / 超时 / 测量抛错 → 一律 `deny`，命令不跑（Task 3 测试 `interrupt denies`、`timeout denies`、`error denies`）。
5. 窄终端 band 模式 → 只画本 mod 报告（独占），按钮可按（Task 3 测试 `band when pane not placed`）。

---

### Task 1: 命令分类 `classify.ts`

**Files:**
- Create: `mods/blast-radius/hooks/classify.ts`、`mods/blast-radius/types/index.d.ts`、`mods/blast-radius/.claude-plugin/plugin.json`、`mods/blast-radius/hooks/hooks.json`、最小 `mods/blast-radius/hooks/register.tsx`（空 `register`，Task 3 补全）
- Test: `mods/blast-radius/test/classify.test.ts`

**Interfaces:**
- Produces（`types/index.d.ts` 导出，`classify.ts` 再导出）：
  ```ts
  export type Risk =
    | { kind: 'rm'; label: string; targets: string[]; dir?: string }
    | { kind: 'git-reset' | 'git-clean' | 'git-push-force' | 'git-checkout'; label: string; args: string[]; dir?: string }
    | { kind: 'migrate'; tool: 'alembic' | 'rails' | 'prisma' | 'django' | 'unknown'; label: string; dir?: string }
  export type Report = { summary: string; count?: number; extra?: string; lines: ReportLine[]; more?: number; note?: string }
  export type ReportLine = { mark: '−' | 'A' | 'M' | 'D' | '?' | ' '; text: string }
  ```
  `dir` 为命令行里 `cd` / `pushd` / `git -C` 移动后的目录（相对或绝对，`'-'` 表示无法确定）；无移动时省略。
- Produces：`classify(command: string): Risk | null` —— 逐段移植原版 `classify` / `classifySegment` / `tokenize` / `joinDir`（含 `PREFIXES`、`sudo` 选项跳过、`( … )` 作用域）。

- [ ] **Step 1: 写失败测试**（写法同 `mods/task-progress/test/logic.test.ts`）
  - `rm variants`：`rm -rf build` → `{kind:'rm', targets:['build']}`；`rm -r a b`、`rm -f x` 命中；`rm x`（无 -r/-f）→ `null`。
  - `git variants`：`git reset --hard` → `git-reset`；`git clean -fdx` → `git-clean` 且 `args` 含 `-fdx`；`git push -f`、`git push --force-with-lease`、`git push origin +main` → `git-push-force`；`git checkout -- .`、`git restore .` → `git-checkout`。
  - `migrate variants`：`python manage.py migrate` → django；`rails db:migrate` → rails；`alembic upgrade head` → alembic；`npx prisma migrate deploy` → prisma；`./run migrate` → unknown。
  - `harmless`：`ls -la`、`git status`、`git push`、`echo rm -rf x` → `null`。
  - `cd follows`：`cd build && rm -rf dist` → `dir:'build'`；`git -C sub reset --hard` → `dir:'sub'`；`pushd a && popd && rm -rf b` → 无 `dir`。
  - `subshell cd stays inside`：`(cd x && ls); rm -rf y` → `dir` 省略。
  - `cd dash`：`cd - && rm -rf y` → `dir:'-'`。
  - `prefixes`：`sudo rm -rf /tmp/x`、`env rm -rf x`、`nohup rm -rf x` 命中。
- [ ] **Step 2: 运行确认失败** — `claude plugin test mods/blast-radius` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** `classify.ts`、类型合约、清单文件。
- [ ] **Step 4: 运行确认通过** — `claude plugin test mods/blast-radius` → PASS。
- [ ] **Step 5: Commit** — `git add mods/blast-radius && git commit -m "feat(blast-radius): 命令分类与类型合约"`

### Task 2: 测量 `measure.ts`

**Files:**
- Create: `mods/blast-radius/hooks/measure.ts`
- Test: `mods/blast-radius/test/measure.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Risk`、`Report`、`ReportLine`。
- Produces：
  - `type Run = (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>`
  - `measure(run: Run, risk: Risk, cwd: string): Promise<Report>` —— 移植原版 `measure*`（`RM_SCRIPT`、`measureGit`、`measurePush`、`MIGRATION_LISTERS`、`size`），抛错时返回「量不了」的 Report（不抛出）。`count` 填数量（rm 文件数、git 文件数、push commit 数、migration 数），`extra` 填大小或 `+N −N`。
  - `resolveDir(run: Run, sessionCwd: string, dir: string): Promise<string | null>` —— 移植 `CD_SCRIPT`。
  - 摘要与 note 改中文（见 Global Constraints）。
- register 里用 `(argv, o) => $.process.run(argv, o)` 适配成 `Run`（具体参数名以当前 API 为准）。

- [ ] **Step 1: 写失败测试** —— `Run` 用 Node 的 `child_process.execFile` 真跑（若测试环境不能用 Node 内置模块，改用按 argv 回固定输出的桩，并在测试文件头注释说明）；每个测试在临时目录里建文件 / `git init`。
  - `rm counts files`：`build/` 下 3 个文件 → `count 3`、`summary` 含 `删除 3 个文件`、`lines` 3 项 `mark '−'`。
  - `rm caps list`：12 个文件 → `lines.length 10`、`more 2`。
  - `rm path that looks like a find action`：存在文件 `-delete`，`rm -rf *` → 该文件仍存在、`count` 含它。
  - `rm missing path`：目标不存在 → `count` 为 0 或省略，`summary` 含「没有匹配」。
  - `git reset lists changes`：一个新增一个修改 → `lines` 含 `{mark:'A'}`、`{mark:'M'}`，`summary` 含 `丢弃 2 个文件的未提交改动`。
  - `git clean dry run`：两个未跟踪文件 → `count 2`，文件仍存在。
  - `push without fetch`：无 `refs/remotes/origin/main` → `note` 说明需要先 fetch。
  - `not a repo`：非 git 目录做 `git-reset` → 不抛错，`note` 非空。
  - `resolveDir`：存在的子目录 → 绝对路径；不存在 → `null`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 `measure.ts`**。
- [ ] **Step 4: 运行确认通过** — `claude plugin test mods/blast-radius` → PASS。
- [ ] **Step 5: Commit** — `git commit -m "feat(blast-radius): 测量影响范围"`

### Task 3: hold 队列、Pane / band 与渲染 `register.tsx`

**Files:**
- Modify: `mods/blast-radius/hooks/register.tsx`
- Test: `mods/blast-radius/test/hold.test.tsx`
- 不改 `.claude-plugin/marketplace.json` 与 `README.md`：与 replay-theater 并行开发，两者共用这两个文件，统一由集成任务在两个分支都合入后再改（见末尾「集成」）。

**Interfaces:**
- Consumes: Task 1 `classify`，Task 2 `measure`、`resolveDir`、`Run`。
- Produces: 渲染节点 key（测试用）：`br-title`、`br-summary`、`br-line-<i>`、`br-more`、`br-note`、`proceed`、`cancel`。

行为照搬原版 `register`：模块变量 `held`（一次一个，其他排队）；`tool.call {tool:'Bash'}` → `classify` → 测量 → `$.ui.open({ id: PANE_ID, title: 'Blast Radius', focus: true, rows })` → 轮询直到决定 → 关 pane → `proceed` 时 toast `Blast Radius：放行` 后 `next(e)`，否则 `{ deny }`。`ui.render` Pane（`requestId === PANE_ID`）与 AbovePrompt（`held.where === 'band'`）画同一个 `draw`；AbovePrompt 不拦截时 `return next(e)`，拦截时只返回自己（不组合下层，也不因 `hasSurvey` 让位）。不按 surface 区分。

`draw` 布局按 spec「外观」B 版：每行前置琥珀 `▎`；标题行 `⚠ 拦截`（琥珀粗）+ 命令（亮粗，截断）；空行；影响行 = 红 `▰`×`min(count,10)` + 红粗摘要 + dim `extra`；空行；列表（`−` 红；`A` 绿、`M` 蓝、其他 dim；与目标同名的路径前缀 dim）；`… 还有 N 个` dim；note dim；空行；按钮 `1 执行`、`2 取消`（`autoFocus`）+ dim `Claude 在等你决定`。band 版去掉两处空行。

- [ ] **Step 1: 写失败测试**（engine 桩写法同 `mods/task-progress/test/band.test.tsx`；`process.run` 与 `ui.open` 用桩：`ui.open` 默认回 `{ isPlaced: true }`，`process.run(['sleep',…])` 立即返回）
  - `harmless passes through`：`ls` → 调用到达下层，无 pane。
  - `proceed runs`：`rm -rf build` → pane 渲染含 `br-title` 文本 `⚠ 拦截`、`br-summary`；press `proceed` → 下层收到调用。
  - `cancel denies`：press `cancel` → 结果 `deny` 含 `the user pressed Cancel`，下层未收到。
  - `cancel has focus`：`cancel` 节点 `autoFocus` 为真。
  - `interrupt denies`：中断 signal → `deny` 含 `interrupted`。
  - `timeout denies`：mock clock 越过 600_000ms → `deny` 含 `10 minutes`。
  - `error denies`：`measure` 依赖的 run 桩抛错之外，再让 `ui.open` 抛错 → `deny`。
  - `second hold waits`：两次并发危险调用，第一次未决时第二次 pane 不出现；回答第一次后第二次出现，且第一次的按钮不影响第二次。
  - `band when pane not placed`：`ui.open` 回 `{ isPlaced: false }` → AbovePrompt 渲染含 `proceed`，且不含更低层桩的 `low` 节点；press `proceed` 放行。
  - `band idle passes through`：无拦截时 AbovePrompt 渲染含 `low`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 `register.tsx`**。
- [ ] **Step 4: 全部验证** — `claude plugin validate mods/blast-radius`、`tsc -p mods/blast-radius`、`claude plugin test mods/blast-radius` 全绿；另跑 `claude plugin test mods/quick-tools`、`claude plugin test mods/task-progress` 确认未受影响。
- [ ] **Step 5: Commit** — `git commit -m "feat(blast-radius): hold 队列与面板渲染"`

### 集成（两个 mod 都合入 `main` 后，在新 worktree 里做）

- `.claude-plugin/marketplace.json` 加 `{ "name": "blast-radius", "source": "./mods/blast-radius", "description": <同 plugin.json> }` 与 replay-theater 一项。
- `README.md` mods 节各加一段：用途、安装（同 quick-tools 写法）、按键、已知局限摘要、注明改编自原仓库链接（Apache-2.0）。
- 验证：`claude plugin validate .`（marketplace）与四个 mod 的 `claude plugin test` 全绿。Commit `docs: blast-radius 与 replay-theater 加入 marketplace 与 README`。
