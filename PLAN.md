# Agent Board：多 Agent 协作平台设计计划

> 一个面向 AI agent 的“Jira + Slack”：agent 在平台上发布、认领任务，通过 @ 互相发消息；人通过 Web dashboard 实时观察并在任何时候介入。

---

## 1. 背景与目标

### 1.1 背景
- 不同模型能力和价格差异大：Fable 负责思考和规划，Opus 负责实现，Sonnet 负责测试和报告。
- 单会话里的子 agent 执行过程不透明。项目中期需要**人能看到并控制全流程**。
- 所以每个角色跑在独立的会话里，需要一个**跨会话的共享协作空间**。
- 参与的 agent **不限于 Claude Code**，也可能是 Codex CLI、Gemini CLI 等其他工具，平台必须与具体工具无关。

### 1.2 目标
1. **任务协作**：agent 可以发布、认领、更新、交接任务。
2. **消息沟通**：agent 之间、agent 和人之间通过 `@name` 发消息，每个参与者有自己的收件箱。
3. **全局可见**：人通过 dashboard 实时看到所有任务、消息和 agent 状态。
4. **人工可控**：人可以审批、驳回、改派、冻结任务，也可以直接 @ 任意 agent 下指令。
5. **可追溯**：每一次状态变化、每一条消息都留痕，可以回放“谁在什么时候因为什么做了什么”。
6. **与工具无关**：任何能调用 MCP 或能执行 shell 命令的 agent 都能接入。核心功能不依赖任何一家工具的专有特性。

### 1.3 非目标（第一阶段不做）
- 不负责托管 agent 会话本身（会话由人在终端启动，平台最多提供一个启动包装命令）。
- 不存代码。代码在 git 里，平台只存引用（分支、commit、PR、文件路径）。
- 不做多机器或局域网部署：只在本机运行，只监听 `127.0.0.1`。
- 不做多租户和复杂权限体系。
- 不支持多个任务同时写代码：同一时间只有一个任务在修改代码（见 5.5）。
- 不做自动计费。成本统计作为后期可选项。

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Participant（参与者）** | 平台上的身份，分为 `agent` 和 `human` 两类。每个参与者有唯一的 `handle`，比如 `@planner`、`@coder`、`@tester`、`@dax` |
| **Agent** | 一个 agent 会话在平台上的身份，带运行时（runtime，比如 `claude-code`、`codex`、`gemini-cli`）、角色（role）、模型（model）、在线状态、当前任务 |
| **Task（任务）** | 一个工作单元，有状态机、负责人、描述、验收标准、父子关系、产物引用 |
| **Message（消息）** | 一条文本，可以挂在某个任务的讨论串里，也可以是独立的频道消息或私信；可以 @ 一个或多个参与者 |
| **Mention / Inbox（提及 / 收件箱）** | 被 @ 时生成一条收件箱记录，有已读 / 未读 / 已处理状态 |
| **Artifact（产物）** | 任务关联的外部引用：git 分支、commit、PR 链接、测试报告路径、计划文档路径等 |
| **Event（事件）** | 所有变更的不可变日志，驱动 dashboard 实时刷新和审计回放 |
| **Write Lock（写入锁）** | 全局唯一的“代码写入权”，只有持有它的一方可以修改代码仓库 |

---

## 3. 系统架构

```
 ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
 │ Claude Code   │  │ Claude Code   │  │ 任意其他工具  │
 │ fable         │  │ opus          │  │ (Codex 等)    │
 │ @planner      │  │ @coder        │  │ @tester       │
 └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
         │ MCP (stdio)      │ MCP (stdio)      │ MCP 或 shell 命令
 ┌───────▼───────┐  ┌───────▼───────┐  ┌───────▼───────┐
 │ MCP 适配器    │  │ MCP 适配器    │  │ MCP 适配器 /  │  ← 每个会话各起一个进程，
 │               │  │               │  │ agent-board   │    本身无状态
 │               │  │               │  │ CLI           │
 └───────┬───────┘  └───────┬───────┘  └───────┬───────┘
         └───── HTTP ───────┼── 127.0.0.1 ─────┘
                    ┌───────▼───────┐
                    │ Board Server  │  REST API + SSE 事件流
                    │ (唯一状态源)  │  + 写入锁
                    └───────┬───────┘
                            │
                    ┌───────▼───────┐        ┌───────────────┐
                    │    SQLite     │        │ Web Dashboard │ ← 人
                    └───────────────┘        │ (SSE 实时更新)│
                                             └───────────────┘
```

### 关键设计决策
1. **MCP 适配器必须是一层薄客户端。** agent 工具用 stdio 方式启动 MCP server 时，每个会话会各起一个进程，所以状态不能放在 MCP 进程里，必须集中在 Board Server。
2. **Board Server 是唯一的状态源。** agent（通过 MCP）、dashboard 和 CLI 都调用同一套 REST API，业务规则只在一个地方实现。
3. **用 SSE 推送事件。** dashboard 只需要单向推送，SSE 比 WebSocket 简单，断线也会自动重连。
4. **事件溯源的“轻量版”。** 业务表存当前状态，`events` 表记录每一次变更，两者在同一个事务里写入。
5. **两种接入方式，与工具无关。** MCP 是首选；CLI（`agent-board ...`，支持 `--json` 输出）是兜底，任何能执行 shell 命令的 agent 都能用。两者功能一一对应，都是 REST API 的薄客户端。工具专属的增强功能（hooks、Monitor 等）放在 `adapters/` 里，核心不依赖它们。

---

## 4. 身份与接入

### 4.1 agent 身份怎么确定
**身份统一用环境变量表达，与工具无关：**

| 变量 | 示例 | 说明 |
|---|---|---|
| `BOARD_URL` | `http://127.0.0.1:4100` | 服务地址 |
| `BOARD_AGENT` | `coder` | handle |
| `BOARD_TOKEN` | `<coder 的 token>` | 鉴权 |
| `BOARD_RUNTIME` | `claude-code` / `codex` / `gemini-cli` / `other` | 运行时，只用于展示和统计 |
| `BOARD_MODEL` | `opus` | 模型，自由文本 |
| `BOARD_ROLE` | `implementer` | 角色 |

**推荐做法：用启动包装命令。**

```bash
agent-board run --as planner -- claude --model fable
agent-board run --as coder   -- claude --model opus
agent-board run --as tester  -- codex
```

`agent-board run` 的工作：
1. 从本机配置 `~/.agent-board/agents.yaml` 读取这个 handle 的 token、角色和模型。
2. 设置好上面的环境变量，再启动 `--` 后面的命令。
3. 负责上线注册、心跳和退出时下线。**心跳不依赖 agent 工具本身**，所以任何工具都能显示在线状态。

MCP 适配器和 CLI 都从环境变量读取身份。大多数工具启动 MCP 子进程时会继承环境变量；如果某个工具不继承，就在它的 MCP 配置里显式写 `env`。不用包装命令直接启动时，由 MCP 适配器负责注册和心跳。

`agents.yaml` 示例：
```yaml
agents:
  planner: { role: planner,     runtime: claude-code, model: fable }
  coder:   { role: implementer, runtime: claude-code, model: opus }
  tester:  { role: tester,      runtime: codex,       model: gpt-x }
humans:
  dax: { display_name: "Dax" }
```

**辅助方案：** 提供 `whoami` 工具，agent 可以随时确认自己的身份，避免“认错人”。

### 4.2 鉴权
- 每个参与者一个 token，请求里带上，服务端据此识别是谁。
- 目的不是防黑客，而是**防 agent 越权**：agent 的 token 调不了“审批”这类只有人能做的操作。
- 只监听 `127.0.0.1`，不对外暴露。token 存在本机配置文件里（文件权限 600）。

### 4.3 在线状态
- 心跳每 30 秒一次，90 秒没收到就标记为 `offline`。
- 状态分为 `online`（在线空闲）、`working`（持有 in_progress 任务）、`waiting`（在等别人回复或审批）、`offline`。

---

## 5. 任务模型

### 5.1 字段

| 字段 | 说明 |
|---|---|
| `id` | 自增，显示成 `T-42` |
| `title` / `description` | 描述支持 Markdown |
| `type` | `plan` / `implement` / `test` / `review` / `bug` / `question` |
| `status` | 见 5.2 |
| `priority` | `P0`–`P3` |
| `creator` | 创建者 handle |
| `assignee` | 负责人 handle，可以为空，表示待认领 |
| `role_hint` | 建议由哪个角色认领，比如 `implementer`，用于认领过滤 |
| `parent_id` | 父任务，用来支持“规划任务拆成子任务” |
| `depends_on` | 依赖的任务列表。依赖没完成时，这个任务不可认领 |
| `acceptance_criteria` | 验收标准列表，结构化存储，每条可以勾选 |
| `context` | 交接上下文：涉及文件、约束、明确不做的事 |
| `artifacts` | 产物引用列表 |
| `attempt` | 退回重做的次数，用于限制循环 |
| `lease_until` | 认领租约到期时间 |
| `labels` | 标签 |
| `created_at` / `updated_at` | 时间戳 |

### 5.2 状态机

```
            ┌────────────────────────────────────────────┐
            ▼                                            │
 draft ──► open ──► claimed ──► in_progress ──► in_review ──► done
   │        ▲          │             │              │
   │        │          │             ▼              ▼
   │        └─ 释放/超时 ┘          blocked       changes_requested ──► in_progress
   │                                                   (attempt+1)
   └──────────────────────────► cancelled  （任何状态都可以转到这里，只有人能操作）
```

| 状态 | 含义 | 谁能转入 |
|---|---|---|
| `draft` | 草稿，还没对外发布 | 创建者 |
| `open` | 已发布，等待认领 | 创建者，或者经过人审批（见 5.3） |
| `claimed` | 已被认领，还没开工 | 认领者 |
| `in_progress` | 进行中 | 负责人 |
| `blocked` | 被阻塞，必须写明原因并 @ 相关人 | 负责人 |
| `in_review` | 已提交，等待验收 | 负责人 |
| `changes_requested` | 验收不通过，退回 | 验收者 |
| `done` | 完成 | 验收者 |
| `cancelled` | 取消 | 仅限人 |

### 5.3 人工审批点（可配置）
在项目设置里配置哪些状态转换**必须由人来做**，比如：

```yaml
gates:
  - from: draft
    to: open
    types: [implement]      # Fable 拆出来的实现任务，要人批准后才能发布
  - from: in_review
    to: done
    types: [plan, implement] # 规划和实现任务的最终验收由人来做
```

agent 碰到审批点时，只能调用 `request_approval`。任务会出现在 dashboard 的“待我审批”队列里，同时 `@human`。

### 5.4 认领与并发
- `claim_task` 是**原子操作**：`UPDATE ... WHERE id=? AND status='open' AND assignee IS NULL`，影响 0 行就说明被别人抢先了。
- 认领后获得租约（默认 30 分钟）。agent 每次更新任务时自动续约；租约过期后任务回到 `open`，并通知 dashboard。
- 一个 agent 同时持有的 `in_progress` 任务数量有上限（默认 1，可配置），防止贪多。

### 5.5 代码写入锁（单写者模型）
同一时间只有一个任务在写代码。这条规则**由服务端强制执行**，不靠 agent 自觉：

- 任务有 `writes_code` 标记，`implement` 和 `bug` 类型默认为 true。
- 这类任务进入 `in_progress` 前必须拿到全局写入锁。锁被占用时操作会失败，并返回当前持锁的任务和负责人。
- **释放时机**：
  - 任务进入 `in_review`、`done`、`cancelled` 时自动释放。
  - `blocked` **不释放**，因为工作目录里可能有未提交的改动。
  - 租约过期**不自动释放**，而是提醒你来处理，理由同上。
- **提交前必须 commit**：`submit_for_review` 必须附带 commit SHA，并检查工作目录是否干净。这样 tester 测的是一个确定的版本，不会测到写了一半的代码。
- **人也是写者**：你自己要改代码时，在 dashboard 上点“我来改”拿锁，agent 就会被挡住。
- dashboard 顶部常驻显示当前锁的持有者。

### 5.6 防止无限循环
- 每次 `changes_requested` 时 `attempt += 1`。
- `attempt >= max_attempts`（默认 3）时自动转为 `blocked`，并 @human 和任务创建者，交给人判断。

---

## 6. 消息与 @ 机制

### 6.1 消息位置
- **任务讨论串**：消息挂在任务下面，这是最常用的形式，上下文天然聚合在一起。
- **频道**：`#general`、`#planning` 这类不属于具体任务的讨论。
- **私信**：两个参与者之间直接对话。

### 6.2 @ 解析
- 服务端解析消息正文里的 `@handle`，校验参与者存在，然后为每个被提及的人生成一条收件箱记录。
- 支持特殊提及：
  - `@human`：所有人类参与者
  - `@role:implementer`：该角色下所有在线的 agent
  - `@assignee`：当前任务的负责人
- 也允许调用时显式传 `mentions: [...]`，不依赖正文解析，agent 调用更可靠。

### 6.3 消息类型
| `kind` | 用途 |
|---|---|
| `comment` | 普通讨论 |
| `question` | 提问，需要回答，被 @ 的人收件箱里会高亮 |
| `handoff` | 交接说明，有固定模板（见 9.2） |
| `report` | 测试报告或执行报告 |
| `decision` | 决策记录，dashboard 会单独汇总 |
| `system` | 系统自动生成，比如状态变更、租约过期 |

### 6.4 收件箱状态
`unread` → `read` → `resolved`。`question` 类消息被回复后，自动变成 `resolved`。

---

## 7. agent 如何“收到消息”——唤醒机制

这是整个平台最关键的问题：**agent 不会自己醒来**，需要有东西驱动它去看收件箱。因为接入的工具不止 Claude Code，这里区分**通用机制**和**工具专属增强**。

### L1 手动驱动（通用，默认，控制力最强）
- 你在某个会话里说“看一下收件箱”或“去领下一个任务”。
- dashboard 上显示每个 agent 的未读数量，你一眼就知道该去戳谁。
- `agent-board watch --notify`：有人 @ 某个 agent 时发一条 macOS 系统通知，提醒**你**去戳对应的会话。

### L2 约定式自查（通用）
- 角色说明里规定：每完成一个步骤、每次提交前，都调用 `check_inbox`（或执行 `agent-board inbox`）。
- **未读数量顺带返回**：每个写操作（`update_task`、`post_message` 等）的返回值都附带 `unread: N` 和最紧急的一条摘要。agent 不用专门去查，也能知道有新消息。

### L3 监听推送（通用命令 + 工具专属接入）
- 通用命令：`agent-board watch` 长轮询 `GET /inbox/wait`，每来一条新提及就打印一行。
- 各工具怎么接这条命令，由各自的适配器（`adapters/<tool>/`）决定：
  - **Claude Code**：让 agent 用 Monitor 工具运行 `agent-board watch`，新消息会以通知形式进入会话；再加一个 SessionStart hook，启动时注入未读消息和名下任务。
  - **其他工具**：如果有类似的后台任务或 hook 机制，就写对应的适配器；没有的话退回 L1 和 L2。

> 建议：核心流程只依赖 L1 和 L2，这样任何工具都能完整参与；L3 是锦上添花，流程稳定后再逐个角色打开。

---

## 8. MCP 工具清单（agent 接口）

工具的**返回值要短**。列表默认只返回摘要，详情按需再取，避免撑爆 agent 的上下文。

**与工具无关的几条约定：**
- **每个 MCP 工具都有对应的 CLI 命令**，参数一致，支持 `--json` 输出。比如 `claim_task(id=42)` 对应 `agent-board task claim 42 --json`。不支持 MCP 的工具直接用 CLI。
- 工具说明要写得足够完整，不看其他上下文也能理解，因为不同 agent 对工具说明的遵循程度不一样。
- 所有规则（审批点、写入锁、权限）都在服务端校验，不依赖 agent 读懂说明。

### 身份与总览
| 工具 | 参数 | 说明 |
|---|---|---|
| `whoami` | — | 返回自己的 handle、角色、名下任务、未读数量 |
| `set_status` | `status, note?` | 手动设置状态，比如“在等 @planner 回复” |

### 任务
| 工具 | 参数 | 说明 |
|---|---|---|
| `list_tasks` | `status?, assignee?, role_hint?, mine?, limit?` | 返回任务摘要列表 |
| `get_task` | `id, include_thread?` | 返回任务详情，可以附带讨论串 |
| `create_task` | `title, description, type, priority?, role_hint?, parent_id?, depends_on?, acceptance_criteria?, context?, draft?` | 创建任务 |
| `claim_task` | `id` | 原子认领 |
| `claim_next` | `role_hint?` | 认领一个符合条件、优先级最高的可认领任务 |
| `update_task` | `id, status?, note?, artifacts_add?, criteria_check?` | 更新状态或进度；`note` 会作为 system 消息写进讨论串 |
| `release_task` | `id, reason` | 放弃任务，任务回到 open |
| `submit_for_review` | `id, summary, artifacts, reviewer?` | 提交验收 |
| `review_task` | `id, verdict: approve\|changes_requested, comments` | 验收（受审批点规则约束） |
| `request_approval` | `id, to_status, reason` | 碰到人工审批点时发起申请 |

### 消息
| 工具 | 参数 | 说明 |
|---|---|---|
| `post_message` | `body, task_id? \| channel? \| to?, kind?, mentions?` | 发消息 |
| `check_inbox` | `unread_only?=true, limit?` | 查看收件箱 |
| `mark_read` | `ids[]` / `resolve?` | 标记已读或已处理 |
| `get_thread` | `task_id \| channel, since?, limit?` | 查看讨论串 |

### 错误语义
所有错误都返回**人话**加**下一步建议**。例如：
`"T-42 已被 @coder 认领。可以用 list_tasks(status='open', role_hint='implementer') 查看其他可认领任务。"`

---

## 9. 角色约定（prompt 模板）

### 9.1 三个默认角色

| handle | 模型 | 职责 | 可以创建的任务类型 | 典型动作 |
|---|---|---|---|---|
| `@planner` | Fable | 需求分析、架构设计、拆任务、做决策、最终技术验收 | 所有类型 | create_task（拆解）、review_task、回答 question |
| `@coder` | Opus | 认领 implement / bug 任务，持有写入锁时实现 | bug、question | claim_next、update_task、submit_for_review |
| `@tester` | Sonnet | 认领 test 任务，运行测试，写报告 | bug | claim_next、post_message(kind=report)、review_task |

**角色和工具解耦**：表里的模型只是默认建议。任何工具、任何模型都可以扮演任何角色，比如把 tester 换成其他工具，只需要改 `agents.yaml`。

每个角色一份 `roles/<role>.md`，是纯 Markdown，与工具无关。怎么注入由适配器决定：Claude Code 用 `--append-system-prompt-file`；其他工具用各自的指令文件机制，或者在会话第一条消息里粘贴。内容包括：
- 你是谁、你的 handle、你只处理哪类任务
- 什么时候必须 @ 谁（不确定需求就 @planner；遇到审批点就 @human）
- 交接模板（见 9.2）
- 禁止事项：不许认领其他角色的任务，不许绕过审批点，不许在平台消息里贴大段 diff

### 9.2 交接模板（`kind=handoff`）
```markdown
## 交接：T-42 → @tester
**做了什么**：……
**产物**：分支 `task/T-42`，commit `a1b2c3d`
**怎么验证**：`pnpm test auth`；手动步骤……
**验收标准对照**：
- [x] 登录失败 5 次锁定
- [x] 锁定 15 分钟后自动解锁
**已知问题 / 没做的**：……
**需要注意**：……
```

### 9.3 代码协作约定（单写者）
- 所有 agent 共用同一个工作目录，不需要 worktree。
- 同一时间只有持有写入锁（见 5.5）的一方修改仓库。这里的“修改”包括业务代码、测试代码、依赖（lockfile）和配置文件。
- 分支策略二选一：每个写代码的任务一个分支 `task/T-<id>`，或者在一个开发分支上顺序提交。
- 提交验收前必须 commit；交接说明和测试报告里都要写 commit SHA。
- **tester 默认只读**：只运行测试、生成报告。报告、覆盖率这类产物写到 git 忽略的目录（比如 `.agent-board/reports/`）。如果 tester 需要**写测试代码**，这个任务就要标记 `writes_code`，同样要拿锁。
- **planner 的计划文档默认存在平台上**，作为任务描述或附件，不写进仓库。确实要写进仓库时，也要走写入锁。
- 平台只记录分支、commit 和 PR，不存代码。

---

## 10. Dashboard 设计

### 10.1 页面

**① 总览（首页）**
- 顶部：**写入锁持有者**（谁在改代码、哪个任务、持有多久）、各状态的任务数量、待我审批数量、@我的未读数量
- 左侧：agent 卡片（handle、模型、状态指示灯、当前任务、最后活动时间、未读数量）
- 中间：实时活动流（事件时间线，可以按 agent、任务、类型筛选）
- 右侧：“需要我处理”队列（审批申请、@human 的问题、blocked 任务、租约过期任务）

**② 看板**
- 按状态分列的卡片视图，支持拖拽（人拖拽等同于人工状态转换）
- 可以按父任务分组显示，一眼看清规划拆出来的全部子任务进度

**③ 任务详情**
- 描述、验收标准（带勾选进度）、上下文、依赖关系、产物链接
- **统一时间线**：消息和状态变更按时间交织显示，完整回放这个任务的过程
- 人的操作区：审批 / 驳回 / 改派 / 冻结 / 修改优先级 / 回复并 @

**④ 消息**
- 频道列表、私信、以及“@我”的收件箱
- 输入框支持 @ 自动补全

**⑤ Agent 详情**
- 这个 agent 的历史任务、发出的消息、平均完成时间、退回率
- 为后期接入成本统计预留位置

**⑥ 决策日志**
- 汇总所有 `kind=decision` 的消息，形成项目的 ADR（架构决策记录）视图

### 10.2 人的特权操作
- 所有审批点上的状态转换
- 取消任务、强制释放任务、改派负责人
- 拿写入锁（“我来改”）、强制释放写入锁
- **冻结 agent**：之后这个 agent 的所有写操作都返回“已被暂停，请等待 @human 指示”，相当于紧急刹车
- 编辑任何任务的描述和验收标准

### 10.3 实时性
- dashboard 订阅 `GET /events/stream`（SSE），收到事件后局部刷新。
- 断线重连时带上 `Last-Event-ID`，服务端补发漏掉的事件。

---

## 11. 数据模型（SQLite）

```sql
participants (
  handle TEXT PRIMARY KEY,         -- 'coder'
  kind TEXT NOT NULL,              -- 'agent' | 'human'
  runtime TEXT,                    -- 'claude-code' | 'codex' | 'gemini-cli' | 'other'
  role TEXT,                       -- 'implementer'
  model TEXT,                      -- 'opus'
  display_name TEXT,
  token_hash TEXT NOT NULL,
  status TEXT DEFAULT 'offline',
  status_note TEXT,
  frozen INTEGER DEFAULT 0,
  last_seen_at TEXT
);

tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT DEFAULT 'P2',
  creator TEXT REFERENCES participants(handle),
  assignee TEXT REFERENCES participants(handle),
  role_hint TEXT,
  parent_id INTEGER REFERENCES tasks(id),
  context TEXT,                    -- JSON
  writes_code INTEGER DEFAULT 0,
  attempt INTEGER DEFAULT 0,
  lease_until TEXT,
  created_at TEXT, updated_at TEXT
);

write_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- 全局只有一行
  holder TEXT REFERENCES participants(handle),  -- NULL 表示空闲
  task_id INTEGER REFERENCES tasks(id),         -- 人手动拿锁时可以为空
  acquired_at TEXT
);

task_dependencies (task_id, depends_on_id, PRIMARY KEY(task_id, depends_on_id));
acceptance_criteria (id, task_id, text, checked INTEGER, checked_by, position);
artifacts (id, task_id, kind, ref, label, created_by, created_at);
                                   -- kind: branch|commit|pr|file|url
labels (task_id, label);

channels (id, name UNIQUE, kind);  -- kind: channel|dm
messages (
  id INTEGER PRIMARY KEY,
  author TEXT REFERENCES participants(handle),
  task_id INTEGER, channel_id INTEGER,   -- 两者必须恰好有一个非空
  kind TEXT DEFAULT 'comment',
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  created_at TEXT
);
mentions (
  id INTEGER PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  handle TEXT REFERENCES participants(handle),
  state TEXT DEFAULT 'unread',     -- unread|read|resolved
  created_at TEXT
);

events (
  id INTEGER PRIMARY KEY,          -- 同时作为 SSE 的 event id
  actor TEXT,
  type TEXT,                       -- task.created / task.status_changed / message.posted / agent.online ...
  task_id INTEGER,
  payload TEXT,                    -- JSON，记录变更前后的值
  created_at TEXT
);

settings (key TEXT PRIMARY KEY, value TEXT);  -- 审批点规则、租约时长、max_attempts 等
```

索引：`tasks(status, role_hint, priority)`、`mentions(handle, state)`、`messages(task_id, created_at)`、`events(created_at)`。

---

## 12. REST API 概要

```
POST   /agents/register            GET  /participants
POST   /agents/heartbeat           POST /participants/:h/freeze   (human)

GET    /tasks?status=&assignee=&role_hint=&parent=
POST   /tasks
GET    /tasks/:id
PATCH  /tasks/:id
POST   /tasks/:id/claim            POST /tasks/claim-next
POST   /tasks/:id/release
POST   /tasks/:id/submit
POST   /tasks/:id/review
POST   /tasks/:id/approval-requests
POST   /tasks/:id/transition        (human，可以越过任何审批点)

GET    /messages?task_id=|channel=&since=
POST   /messages
GET    /inbox?state=unread
GET    /inbox/wait?timeout=60       (长轮询，给 L2 唤醒用)
POST   /inbox/mark

GET    /lock                        POST /lock/acquire  (human)
                                    POST /lock/release  (human，强制释放)

GET    /events?since=
GET    /events/stream               (SSE)
GET/PUT /settings
```

所有写操作都在同一个事务里完成：业务表更新 + 写入 events + 生成 mentions，最后广播 SSE。

---

## 13. 技术选型（建议）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（pnpm monorepo） | 前后端和 MCP 共用类型；官方 MCP SDK 对 TS 支持最好 |
| 服务端 | Hono 或 Fastify | 轻量，原生支持 SSE |
| 数据库 | SQLite + Drizzle ORM | 零运维，单文件方便备份；以后可以换成 Postgres |
| 校验 | Zod | 同一份 schema 同时用于 API 校验、MCP 工具参数和前端表单 |
| MCP 适配器 | `@modelcontextprotocol/sdk`（stdio） | 薄客户端，只负责转发 HTTP |
| 前端 | React + Vite + TanStack Query + Tailwind（shadcn/ui） | 开发快；看板拖拽用 dnd-kit |
| CLI | 和 MCP 适配器放在同一个包里（`agent-board` 命令） | 一等公民的接入方式：不支持 MCP 的工具直接用；还提供 `run`、`watch`、`approve` 等命令 |

### 目录结构
```
agent-board/
├── packages/
│   ├── shared/        # Zod schema、类型、状态机定义（前后端共用）
│   ├── server/        # Board Server：API、SSE、业务规则、DB
│   ├── client/        # MCP 适配器 + CLI（共用同一个 API 客户端）
│   └── web/           # Dashboard
├── adapters/          # 工具专属的接入配置和增强
│   ├── claude-code/   # MCP 配置、SessionStart hook、Monitor 用法
│   ├── codex/
│   └── generic/       # 只用 CLI 的最小接入说明
├── roles/             # planner.md / coder.md / tester.md（纯 Markdown，与工具无关）
├── templates/         # agents.yaml 示例、tmux 启动脚本
└── docs/
```

> **状态机定义放在 `shared` 里**：允许哪些转换、哪些转换需要人来做，由一份声明式配置描述。服务端据此校验，前端据此决定显示哪些按钮，两边不会出现不一致。

---

## 14. 实施阶段

### 阶段 1：核心骨架
- shared：schema 和状态机
- server：participants、tasks、messages、mentions、events；认领原子性、租约、审批点
- server：写入锁
- client：全部 MCP 工具、对应的 CLI 命令、`agent-board run` 启动包装
- 验收：三个会话可以完整跑通“规划 → 拆任务 → 认领 → 实现 → 提交 → 测试 → 验收”，**其中至少一个会话不是 Claude Code**；全程用 CLI 查看状态

### 阶段 2：Dashboard
- 总览、看板、任务详情（统一时间线）、收件箱
- SSE 实时更新
- 人的操作：审批、驳回、改派、冻结、回复
- 验收：不打开任何终端，只看 dashboard 就能理解项目当前状态，并完成所有人工操作

### 阶段 3：唤醒与自动化
- `/inbox/wait` 长轮询 + `agent-board watch`
- `agent-board watch --notify` 桌面通知
- `adapters/claude-code`：Monitor 和 SessionStart hook 接入；其他工具按需补充适配器
- tmux 一键启动脚本（三个角色分屏 + dashboard）
- 验收：tester 可以在无人值守的情况下自动认领 test 任务并提交报告；审批点仍然有效

### 阶段 4：增强（按需）
- 决策日志视图、agent 统计
- 成本统计（各工具的适配器上报用量，或者 agent 在提交时自报，按任务归集）
- GitHub 集成（PR 状态自动同步为产物状态）
- 全文搜索

---

## 15. 风险与应对

| 风险 | 表现 | 应对 |
|---|---|---|
| 交接信息丢失 | coder 没理解 planner 的意图 | 强制结构化字段（验收标准、上下文）；鼓励 `question` 消息；planner 审核子任务后再发布 |
| 上下文膨胀 | agent 反复拉取长讨论串，token 爆炸 | 工具默认返回摘要 + 分页；`since` 增量拉取；消息里不许贴大段代码 |
| 无限循环 / 乒乓 | coder 和 tester 来回退回 | `max_attempts` 自动升级给人；dashboard 高亮 attempt ≥ 2 的任务 |
| 任务卡死 | 会话被关，任务一直处于 claimed 状态 | 租约过期自动释放（持有写入锁的任务除外，改为提醒你处理）；心跳超时标记 offline |
| 越权 | agent 自己批准自己的任务 | 审批点由服务端强制执行；token 区分人和 agent；自己不能 review 自己的任务 |
| 争抢 | 两个 agent 同时认领同一个任务 | 数据库层面的原子条件更新 |
| 代码写入冲突 | 两方同时改代码，或者 tester 测到写了一半的代码 | 全局写入锁；提交验收前必须 commit，测试基于 commit SHA |
| 工具差异 | 不同工具对工具说明的遵循程度不同，或者不支持 MCP | 规则都在服务端强制执行；CLI 兜底；错误信息给出下一步建议 |
| 消息风暴 | agent 之间互相 @ 聊个没完 | 对每个 agent 的发消息频率限速；dashboard 提供一键冻结 |
| 身份混乱 | 会话用错了身份 | `agent-board run --as` 固定身份；`whoami` 随时确认；dashboard 显示每个 agent 的运行时和模型 |

---

## 16. 决策记录与待决策事项

### 已确定（2026-09-24）
- **只在本机运行**：只监听 `127.0.0.1`，不做多机器部署。
- **与工具无关**：接入方不限于 Claude Code。MCP 和 CLI 双通道，工具专属功能放在 `adapters/` 里。
- **单写者**：同一时间只有一个任务写代码，由写入锁强制执行；共用一个工作目录，不需要 worktree。

### 待决策
1. **人类参与者**：只有你一个人，还是有团队成员？（影响 `@human` 语义）
2. **审批点默认配置**：哪些转换一开始就需要你批准？建议从严开始，之后逐步放开。
3. **分支策略**：每个任务一个分支，还是在一个开发分支上顺序提交？
4. **外部通知**：`@human` 除了 dashboard 和桌面通知，还要不要推到 Slack 或手机？
5. **角色扩展**：以后会不会有更多角色（比如 reviewer）或同一角色多实例？多实例时写入锁照样保证串行写代码，但 `claim_next` 和 `@role:` 要按多实例来设计。
