# Baton 高级操作参考

本文件用于手动协议、旧任务和自定义审批策略。默认四工具 worker 只读 [技能入口](../SKILL.md)，不需要此处的 join、收件箱或续租步骤。默认 MCP 是 `workflow` 工具集；以下完整手动工具需在全局 MCP 启动参数中设置 `--profile full`，CLI 始终保留。MCP 另需 `session_id`，CLI 使用 `--session` 并加 `--json`；替换示例中的实际 ID、SHA 和路径。

默认 `approval_mode=plan`：先创建草稿 plan 和代码子任务，再申请计划发布；实现任务须关联计划，批准前不能开工，批准后范围锁定。下文逐任务 gate 示例仅用于 `approval_mode=custom`。`settings.gates` 在 plan 模式不参与判断，`merge_approval` 控制合入任务是否需要额外的发布审批。不要代人修改策略。

CLI 也有 `task dispatch <id> --handle coder --mode implement`、`task complete-plan <id>`、`worker get/message/evidence/submit/review --run-id <id>` 和 `worker stop --run-id <id>`。`worker evidence` 自动汇总本轮检查并展示清单；将返回的路径通过 `--evidence-manifest` 传给 submit/review。`worker review --verdict` 只接受 `approve` 或 `changes_requested`，`--help` 列出合法值和完整示例。只有 MCP 会为派发的 worker 自动续租；单次 CLI 命令不创建后台续租器。

## 入口与返回值

首次加入：

```sh
agent-board --config /path/to/agents.yaml join --handle coder --role implementer --json
```

MCP 对应 `join({handle: "coder", role: "implementer"})`。保留返回的 `data.session_id`；恢复时直接复用，不再 join。后续示例中的业务 JSON **用于 MCP 时另加真实的 `session_id`**；用于 CLI 的 `--data-file` 时不添加这个字段，由命令前缀指定身份：

```sh
agent-board --session <id> whoami --json
agent-board --session <id> settings get --json
agent-board --session <id> inbox --json
agent-board --session <id> task get 42 --include-thread --json
agent-board --session <id> task list --mine --active-only --json
```

后文省略的 `--session` 都需要补上，除非环境已有 `BOARD_SESSION_ID`。只有在 Baton 源码根目录才将 `agent-board` 替换成 `pnpm board`；其他目录使用已确认的客户端绝对路径。`run --as` 是可选包装器，现有 App 会话无需再启动自己的 CLI。单次 `--as` 命令会临时加入和退出，不适合代替当前持久会话。

子 Agent 若继承父角色的 `BOARD_AGENT` / `BOARD_SESSION_ID`，先为自己 `join`；CLI 后续显式传自己的 `--session`，并只在自己的命令进程环境中清除或改正继承的 `BOARD_AGENT`，否则客户端会报身份不匹配。不要修改共享 MCP 或全局环境；MCP 的 `join` 不传 `session_id`，后续调用直接携带子 Agent 自己的 ID。

明确结束协作时用 `leave`；退出只使该 ID 失效，不释放任务或写入锁。会话 ID 不会因为 90 秒没有请求而过期，也不代表人工权限。

CLI 通用入口支持全部 MCP 同名操作，适合数组和对象参数：

```sh
agent-board call update_task --data-file /outside/repository/update.json --json
```

请求文件使用 JSON 序列化器写入 UTF-8（无 BOM），并置于目标仓库外；不要手拼 shell 命令转义用户文本。`call` 的 JSON 包含 `id`；专用命令如 `task update 42` 则用位置参数指定 ID。

成功响应为 `{ "data": ... }`。写操作还可能带 `unread` 和 `urgent`；有紧急项时读取对应收件箱，摘要可能被截断。失败包含 `error.code`、`message`、`next`；CLI 以非零退出码表示失败，MCP 返回 `isError`。

## 常用命令映射

| MCP 操作                    | CLI                    | 用途                               |
| --------------------------- | ---------------------- | ---------------------------------- |
| `join` / `leave`            | `join` / `leave`       | 加入或明确结束协作会话             |
| `get_overview`              | `overview`             | 总览与需要人工介入的项目           |
| `list_participants`         | `participant list`     | 真实 handle、role 和最近活动       |
| `create_task`               | `task create`          | 创建任务或草稿                     |
| `claim_task`                | `task claim 42`        | 认领指定的开放任务                 |
| `claim_next`                | `task next`            | 在授权队列中找下一项符合角色的任务 |
| `update_task`               | `task update 42`       | 开工、续租、阻塞或验收标准勾选     |
| `release_task`              | `task release 42`      | 说明原因并释放不持锁的未提交任务   |
| `submit_for_review`         | `task submit 42`       | 提交交接与产物                     |
| `review_task`               | `task review 42`       | 独立批准或退回                     |
| `request_approval`          | `task approval 42`     | 申请配置中的人工审批               |
| `post_message`              | `message post`         | 任务讨论、频道或私信，三选一       |
| `get_thread`                | `message thread`       | 读取讨论                           |
| `check_inbox` / `mark_read` | `inbox` / `inbox mark` | 读取或处理自己的提及               |
| `get_lock` / `get_events`   | `lock show` / `events` | 检查写入权与审计记录               |

## 规划：create_task

```json
{
  "title": "修复通知断线恢复",
  "description": "服务重启后恢复监听，已交付的消息不重复输出。",
  "type": "implement",
  "role_hint": "implementer",
  "draft": true,
  "acceptance_criteria": ["重启服务后监听能恢复", "已输出的消息不会重复"],
  "repository": "/actual/target/repository"
}
```

顶层 `repository` 才是任务执行仓库，使用服务所在机器的 Git 工作树绝对路径；`context.repository` 不参与执行。跨仓库总计划可省略，代码任务开工前必须通过 `update_task` 补齐。领取结果返回规范化路径，开工后不能切换仓库。创建时 `parent_id` 表示分组，`depends_on` 表示必须先完成的依赖，两者不可替代；列任务时父任务过滤参数叫 `parent`。`implement` / `bug` / `merge` 总是需要写入锁，其他类型需要改仓库时显式设 `writes_code=true`。发布是否审批以当前 gates 为准。

这里的 Git 工作树包含普通仓库的现有工作目录，不要求通过 `git worktree add` 新建目录。默认 coder 与 tester 使用相同的 `repository`，顺序完成实现和验收。

## 执行：claim_task

```json
{ "id": 42 }
```

正常流转是 `open → claimed → in_progress → in_review`。被退回为 `changes_requested` 后，同一负责人读取意见并通过 `update_task(status="in_progress")` 重新开工，不重复认领；`blocked` 只有解决阻塞且未触及返工上限等限制后才恢复。独立 tester 直接验收原 `in_review` 任务，不认领它。不要把已领取当作已开工，不要用通用状态更新跳过提交或验收操作。

## 开工或恢复：update_task

```json
{ "id": 42, "status": "in_progress", "note": "开始修复并验证断线恢复。" }
```

开工成功后写入任务会自动取得该仓库的锁，可用 `get_lock(repository=任务返回的路径)` 核对 `holder` 与 `task_id`。执行中的续租不必改变状态，传 `id` 和有实际信息的 `note` 即可；长命令也应在策略租约内安排续租。

## 阻塞求助：update_task

```json
{
  "id": 42,
  "status": "blocked",
  "note": "已完成复现，但目标环境缺少凭证。请 @human 提供可用的测试接入方式。"
}
```

标记 blocked 保留写入锁与负责人。需要释放时先检查锁；不能因为已经 blocked 就让另一位 Agent 开始修改共享仓库。

## 提交：submit_for_review

```json
{
  "id": 42,
  "summary": "已实现断线恢复。固定版本测试通过；已输出消息不重复。请独立核对验收标准。",
  "reviewer": "tester",
  "artifacts": [
    { "kind": "commit", "ref": "REPLACE_WITH_VERIFIED_FULL_HEAD_SHA" },
    { "kind": "file", "ref": "/outside/repository/report.txt" }
  ]
}
```

摘要中的“通过”必须替换为实际结果。代码任务必须提交一个完整的 40 或 64 位 SHA，不能提交分支名、短 SHA 或示例占位符。使用目标仓库的 `git rev-parse HEAD` 和 `git status --porcelain --untracked-files=all` 核实；纯手动流程成功提交后释放锁，管理的 worker 保留至验收结束。只读任务可交付报告，不强制创建代码 commit。`reviewer` 是可选字段；只填写已注册且独立的真实 handle。新 tester 尚未加入时可省略，由主 Agent 随后调度有验收权限的 tester，不用借身份提前注册。

## 共享目录验收

默认不创建副本，在任务的现有仓库目录验收。独立性来自不同的 coder 与 tester 身份及实际检查，不来自目录隔离。

1. 主 Agent 确认 coder 已停止修改，同目录暂不派发下一项写入工作。纯手动任务的 `submit_for_review` 释放锁；通过 `dispatch_task` 管理的任务会保留验收期锁。tester 读取 `get_lock(repository=任务路径)`，发现其他任务持锁或外部写者时先协调。
2. tester 读取任务及最新交接，确认仍为本次 `in_review`。在任务的 `repository` 中运行以下只读命令；HEAD 必须等于本次提交的完整 SHA，status 必须为空：

   ```sh
   git rev-parse HEAD
   git status --porcelain --untracked-files=all
   ```

3. 运行既定测试并核对语义标准，不修改源文件、测试文件、依赖声明或 lockfile。报告和临时数据输出到仓库外；已有忽略目录中的常规构建缓存可以使用。命令如果会改动受版本管理的文件或产生未忽略文件，先让 coder 在持锁任务中调整测试配置并重新提交，不能由 tester 顺手改代码。
4. 测试结束后、勾选标准和提交结论前，再核对任务状态、本次交接 SHA、HEAD、status 和写入占用。任何不一致都停止本轮验收，报告实际观察并交主 Agent 协调；不能将结果算作原提交通过，也不自动 checkout、reset、stash 或清理现场。

测试失败但版本与目录未变化时，按正常流程退回 coder。需要隔离时由用户明确选择，再使用单独 worktree 或临时 clone；它们不是本流程的必需步骤。

## 验收标准：update_task

```json
{
  "id": 42,
  "criteria_check": [{ "id": 7, "checked": true }],
  "note": "已在提交版本上复现服务重启场景。"
}
```

`7` 必须来自 `get_task.acceptance_criteria[].id`，不是标准在列表中的序号。只有待验收阶段的独立验收者可勾选，负责人不可以；验收者如需附报告，可发任务 `post_message(kind="report")`，不要混入只有任务负责人可用的修改字段。

## 验收结论：review_task

```json
{
  "id": 42,
  "verdict": "changes_requested",
  "comments": "服务重启后仍重复输出已交付消息。报告中记录了复现命令与实际输出，请修复游标保存。"
}
```

全部标准已核验且勾选时才用 `verdict="approve"`。`submit_for_review` / `review_task` 自带任务消息，不额外发送相同报告。退回会增加 attempt，达到策略上限后转 blocked 并通知人。

最终通过的操作先按 `get_settings.gates` 分支：无 gate 时调用 `review_task(approve)`；命中 `in_review → done` 的人工 gate 时，先在任务中用 `post_message(kind="report")` 写明独立验收通过的证据，再 `request_approval(to_status="done")`。此时不调用会被拒绝的 `review_task(approve)`，也不宣称已经写入批准 verdict；任务仍为 `in_review`，直到人批准且服务端确认 `done`。

## 人工审批：request_approval

```json
{ "id": 42, "to_status": "done", "reason": "独立验证已通过并逐项勾选，请确认最终验收。" }
```

只对当前状态存在的 gate 申请：草稿发布用 `to_status="open"`，最终验收用 `done`。服务端审批是必要约束；聊天里的一般授权不会自动改变看板状态。不用 `transition_task`、`approve` 或 `put_settings` 绕过 gate。

## 消息与游标

`post_message` 的 `task_id`、`channel`、`to` 必须且只能填一个。关键收件人可放在显式 `mentions`，例如 `human` 或实际 handle；`mentions` 严格校验，正文中的未知 `@types/node` 等技术文本则忽略。`@assignee` 只在有负责人的任务上下文中有意义。

| 读取对象 | 游标与处理方式                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------ |
| 任务     | `list_tasks(limit=50, offset=0)`，需要更多时增加 offset；自己的待办加 `mine=true, active_only=true`    |
| 未读提及 | `check_inbox` 默认返回自己的未读；`mark_read.ids` 用返回的 mention ID，`resolve=true` 只用于已处理事项 |
| 提问回复 | `post_message.reply_to` 用 `mention.message.id`；保持原任务/频道/私信目的地                            |
| 增量提及 | `wait_inbox(timeout=15, since=最后收到的mention ID)`；保留尚未处理的事项，不把游标推进当作已读         |
| 最近活动 | `get_events(order="desc", limit=50)`；翻到更早用上一页最后一项 event ID 作为 `before`                  |
| 最近讨论 | `get_thread` 不传 since 返回最近一页；增量读取的 since 是 message ID                                   |

三种 ID 不可混用。`watch --since` 也使用 mention ID，并在断线后自动重连；进程结束后需要自行保存游标。用户明确要求值守时才保持长期监听。

## 错误处理

先读错误的 `code` 与 `next`，再核对服务端当前状态。网络超时可能发生在服务端已经提交之后，创建任务、发消息、提交验收等操作不要盲目重复。

| 情况                                                        | 行动                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `already_claimed` / `not_assignee`                          | 重新读任务；不覆盖别人的认领，仅在获准处理队列时找下一项                      |
| `task_limit` / `no_eligible_task`                           | 检查自己的活动任务和依赖，不靠囤积 blocked 任务继续认领；无工作就说明等待原因 |
| `repository_required` / `invalid_repository`                | 确认服务所在机器的 Git 工作树绝对路径，给任务补齐；不能依赖服务启动目录       |
| `legacy_write_lock` / `repository_locked`                   | 保留现场，由人处理旧锁；已开工任务更换仓库需要新建任务                        |
| `dependencies_pending`                                      | 检查前置任务；取消不等于完成，由人移除或替换依赖                              |
| `write_lock_held` / `write_lock_required`                   | 读锁和相关任务，保留现场，协调当前持有者或人；Agent 不强制解锁                |
| `approval_required`                                         | 依据当前状态申请对应 gate，停止该状态转换，等待人实际处理                     |
| `agent_frozen` / `task_frozen` / `attempt_limit`            | 停止受限写操作、读取消息和任务；不换身份或改策略规避限制                      |
| `dirty_worktree` / `commit_not_head`                        | 检查任务仓库、实际 HEAD 和改动归属；保留他人文件，问题未解决不重提            |
| `task_changed`                                              | Git 验证期间任务被修改；重读任务、锁和权限，条件重新成立后才重试              |
| `criteria_incomplete` / `self_review` / `reviewer_required` | 读取标准和验收者信息，由有权限的独立验收者处理                                |
| `session_not_found`                                         | 重新加入前核对用户指定身份；加入后读取已有工作，不能重做已提交操作            |
| 鉴权失败 / 连接失败                                         | 报告当前入口与具体错误，不显示接入密钥、不转用人工入口；连接恢复后先读状态    |

人的强制解锁、改派、冻结、依赖修复和策略设置交给 Dashboard 或用户明确授权的人工操作。缺少授权时给出任务 ID、阻塞证据和建议动作，不修改数据库或配置来代办。
