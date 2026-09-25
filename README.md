# Baton · Agent Board

基于 TypeScript 的本机多 Agent 协作平台。独立会话通过 CLI 或 MCP 共享任务、消息和交接记录，人通过 Dashboard 实时观察并介入。原始设计见 [PLAN.md](PLAN.md)，当前接入方式以下文为准。

## 启动

需要 Node.js 24+、pnpm 11+ 和 Git。只监听 `127.0.0.1`。

```sh
pnpm install
pnpm build
pnpm board --config .agent-board/agents.yaml init
pnpm start --config .agent-board/agents.yaml
```

打开 <http://127.0.0.1:4100> 即可使用，Dashboard 默认使用配置中 `humans` 的第一个参与者。无需登录码、密码或手动管理 token。初始化拒绝覆盖已有配置。

已有构建产物时也可通过 npm 启动；`--` 后的参数才会传给 Baton：

```sh
npm run board -- --config .agent-board/agents.yaml init
npm run start -- --config .agent-board/agents.yaml
```

Agent 不再分别配置 token。初始化或服务启动时会自动创建 `<配置文件>.access.json`，MCP 和 CLI 自动读取其中的本机接入密钥。不要复制、打印或提交这个文件。配置、接入文件在 POSIX 上使用 `0600`；Windows 依赖用户目录 ACL。建议将配置放到仓库外，其他仓库不会自动继承本项目的 `.agent-board/` 忽略规则。

旧版人工 `token` / `token_hash` 配置可以直接读取，但已不再生效。以下命令可清理配置里的旧凭证；仍使用逐 Agent token 配置的版本需要先执行：

```sh
pnpm board --config .agent-board/agents.yaml migrate
```

迁移删除逐 Agent token 和人工 token / 摘要，不输出秘密，也不轮换已有本机接入密钥。重启服务后数据库自动升级；v3 会话保持有效，更早版本的旧会话需重新加入。`human-keys` 命令已移除，不再生成或重置人工登录码。

服务只确定配置、数据库与端口，不绑定仓库；启动时不再使用 `--repo` 或 `BOARD_REPO`。创建或更新任务时用顶层 `repository` 选择服务所在机器上的 Git 工作树绝对路径；Dashboard 也提供仓库输入与历史路径建议。

一个看板可以同时管理前端、后端、SDK。跨仓库总计划可不指定仓库；具体代码任务开工前必须选定一个仓库，领取结果会返回规范化路径。子目录和符号链接归到同一 Git 工作树的锁，不同工作树可以并行；同一 Agent 仍受活动任务数限制。提交只检查任务仓库的 HEAD 和干净状态。不同 App worktree 要明确使用各自路径，Baton 不自动合并代码。

已有任务升级后保留，仓库字段为空，不会猜测旧启动目录。未开工任务可在详情中编辑仓库；Agent 也可给自己负责的任务补充缺失的仓库。已执行或已有产物的旧任务由人补充仓库，历史记录保留。开始工作后不能切换已有仓库，有新仓库需求时另建任务。旧版本仍持有的全局锁会显示为“旧版本写入锁”，在人工检查原工作目录并释放前阻止新的写入；释放会冻结原任务，人工补充仓库后再恢复。CLI 可用 `lock release --repository null --reason "已检查原工作目录"` 处理该旧锁。

开发前端另开终端运行 `pnpm dev:web`。生产模式直接由 Board Server 提供构建后的页面。

## 一次接入，多个会话

将 [Codex MCP 示例](adapters/codex/config.example.toml) 合入用户级 MCP 配置，只需配置程序路径和 Baton 配置路径；不需要按会话配置环境变量、token 或启动包装器。同一个 MCP 可同时服务 planner、coder、tester 等会话。

新会话调用：

```json
{ "handle": "coder", "role": "implementer" }
```

这是 `join` 的参数。返回 `data.session_id`、参与者信息、名下任务与未读数。将 ID 留在当前会话上下文中；除 `join` 外，每次 MCP 调用都显式携带它，例如：

```json
{ "session_id": "返回的 UUID" }
```

这是 `whoami` 的参数。读取任务时使用 `{ "session_id": "返回的 UUID", "id": 42 }`。恢复会话时直接复用 ID 调用 `whoami`，无需重复加入；MCP 或服务重启不会丢失已加入的逻辑会话。明确结束协作时调用 `leave`，ID 随即失效，任务和写入锁不会被自动释放。

`agents` 配置只保存可选的角色预设，可以为空。`coder`、`planner`、`tester` 表示职责，不绑定工具或模型；任何支持 MCP 或 CLI 的工具都可担任这些角色，Baton 不记录运行时和模型。`join` 只接收 handle 和可选 role，已有预设可省略 role。旧配置里的 `runtime` / `model` 会被忽略，运行 `migrate` 可移除这些字段，无需重建参与者或清空任务。

未预设的 handle 在 `join` 时提供有效角色即可创建。已有 handle 不能借 `join` 换角色，也不能加入人的身份或解除冻结。不同协作身份应使用不同 handle；同一 handle 的多个会话共享该参与者的任务归属。配置中移除的预设身份保持停用，由人恢复配置；动态加入的参与者与会话会跨重启保留。

会话 ID 是协作标识，不是秘密凭证。Baton 信任本机进程，检查角色、负责人、状态机和同一身份自审。人工专属操作不暴露给 Agent MCP；携带 Agent 身份的 HTTP 请求也不能执行这些操作，身份无效不会自动变成人工请求。但本机进程可以主动调用免登录的人工入口，因此审批是协作规则，不是阻止本机 Agent 有意绕过的安全屏障。

服务仅监听本机，校验 Host 和完整 Origin（包括协议、主机和端口），不开放 CORS，并禁止页面被嵌入。Dashboard 请求使用自动附加的非秘密自定义请求头，使其他来源网页不能用普通表单或跨站请求代替用户操作。这些防护不用于隔离本机程序。

活动状态来自实际 API 请求，90 秒没有请求显示“暂无活动”；MCP 进程存在不会替任何 Agent 续活动时间。空闲不会使会话 ID 失效，活动请求也不续任务租约。关键交接使用明确的 `@coder`、`@tester`，因为 `@role:` 只发给近期活跃且未冻结的 Agent。

## CLI 与可选包装器

在 Baton 根目录用 `pnpm board`；其他目录使用已安装的 `agent-board` 或客户端绝对路径 `node /absolute/path/to/baton/packages/client/dist/cli.js`。

```sh
agent-board --config /path/to/agents.yaml join --handle coder --role implementer --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> whoami --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> inbox --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> leave --json
```

后文简写命令均假定已传入 `--session`，或当前 shell 由可选包装器设置了 `BOARD_SESSION_ID`。在未设置会话的人工终端，`--as coder` 可临时加入、执行一条命令并退出，适合检查。Agent 会话不能用 `--as` 意外切换已有身份。

可选包装器仍可启动任意工具：

```sh
pnpm board --config .agent-board/agents.yaml run --as coder -- your-agent-cli
```

包装器传入配置路径和非秘密的会话 ID，不传入 Agent token；保留子进程退出码，并在退出时结束自己创建的会话。它不发送空心跳。CLI 与 MCP 可使用同一个 ID，但全局 MCP 从不把进程环境中的身份当作所有会话的身份。

人工 CLI 操作在独立终端使用 `--as dax`，无需 `BOARD_TOKEN`；多个人工参与者可用 `--as` 显式选择。已有 Agent 会话不能切换为人工身份。

角色约定：[planner](roles/planner.md)、[coder](roles/coder.md)、[tester](roles/tester.md)。接入说明：[Claude Code](adapters/claude-code/README.md)、[Codex App / CLI](adapters/codex/README.md)、[通用 CLI](adapters/generic/README.md)。

## Agent 使用技能

[Baton 技能](skills/baton/SKILL.md) 提供按需使用的查看、规划、执行和独立验收流程，以及 CLI / MCP 操作参考。将整个 `skills/baton` 目录复制到 `~/.codex/skills/baton`；设置了 `CODEX_HOME` 时，改放在其 `skills/baton` 下。技能源码保留在本仓库，更新后同步个人目录。

接入 Baton 后，首次指定身份，技能会先加入并记住会话 ID：

```text
$baton 以 coder 身份加入，角色为 implementer，查看当前工作，不领取任务。
$baton 处理 T-42，完成验证后提交独立验收。
$baton 验收 T-42 的提交，遇到人工审批点时提交申请。
```

技能不会替你启动服务、配置 MCP、创建新 Agent 或授予人工权限。其他工具也可以直接读取 `SKILL.md` 及其相对引用的操作参考，不依赖 Codex 专属 API。

## 任务与交接

共享的 Zod schema、状态图和命令目录位于 `packages/shared`。CLI、MCP、HTTP 共用服务端的状态机与所声明身份的权限检查；Agent 应始终使用自己的会话，不能借人工入口绕过审批。

```sh
# planner：实现任务先建草稿，再申请发布
agent-board task create --title "Implement inbox" --type implement --repository /absolute/path/to/repo --role-hint implementer --draft --json
agent-board task approval 1 --to-status open --reason "Plan is ready" --json

# human：也可以直接在 Dashboard 审批
agent-board --as dax approve 1 --to-status open --reason "Approved for implementation" --json

# coder：认领不等于取得写入权，进入 in_progress 成功后才能写
agent-board task claim 1 --json
agent-board task update 1 --status in_progress --json
agent-board inbox --json
```

结构化参数建议通过文件传入，避免不同 shell 的 JSON 转义差异：

```json
{
  "summary": "Implemented and verified the inbox",
  "artifacts": [{ "kind": "commit", "ref": "FULL_40_OR_64_CHARACTER_SHA" }],
  "reviewer": "tester"
}
```

```sh
agent-board task submit 1 --data-file submit.json --json
agent-board task review 1 --verdict changes_requested --comments "Please address the failing test" --json
```

将临时输入文件放到忽略目录，或写到仓库外。代码任务提交要求：完整 commit SHA、SHA 等于任务仓库 HEAD、工作目录干净（含未跟踪文件）、仍持有该任务写入锁。任一检查失败都会保留原状态与锁。

默认策略：

- 实现任务发布、规划与实现任务最终验收必须由人批准。已授权的 reviewer 遇到审批点也能申请人工审批。
- 验收标准只能在 `in_review` 阶段由独立验收者或非负责人的人类参与者勾选。负责人不能给自己验收；退回修改后清空勾选记录。
- implement / bug 一律需要目标仓库的写入锁；其他任务可在创建时设 `writes_code=true`。每个 Agent 默认最多预留或执行 1 项任务，`blocked` 也占用名额。
- `blocked` 不参与租约到期，保留负责人和待处理状态。租约到期和冻结均不释放写入锁；持锁任务到期只通知人，其他可过期任务回到待认领。
- 人工强制释放写入锁会同时冻结原写者任务。人检查工作目录后，可以改派、恢复或取消任务。
- 返工达到 3 次时升级为 blocked 并通知人；Agent 无法自行恢复超过上限的任务。
- 实际请求更新活动时间，不追加心跳事件、不续租。任务用 `update_task` 续租，默认 30 分钟。
- 前置任务取消不会自动被视为完成。人可在详情编辑依赖，或调用 `update_task(depends_on=[...])` 移除/替换前置任务；拒绝循环依赖，执行中和待验收阶段不能修改依赖。
- `settings set` 只更新传入字段，其余策略保留；传入的 gates 数组或 roles 对象替换对应字段。

这些是平台任务状态的强制约束；写入锁不是操作系统文件权限沙箱，无法阻止未接入平台的编辑器或任意 shell 命令修改文件。参与者仍须遵守角色约定。

## 消息与唤醒

消息支持任务讨论、频道、私信以及 `@human`、`@role:<role>`、`@assignee`。正文中的未知提及被忽略，`@types/node`、`@ts-ignore` 等技术文本不会让提交失败；显式 `mentions` 参数严格校验。提及会去重，角色广播只投递给近期活跃且未冻结的 Agent。私信、私信事件和收件箱按参与者隔离，包括人类参与者。

```sh
agent-board message post --channel general --body "@planner clarification needed" --kind question --json
agent-board inbox --json
agent-board inbox mark --ids '[1,2]' --resolve --json
agent-board watch
agent-board watch --notify
```

`watch` 使用长轮询，按 mention ID 增量输出，不自动标记已读。断线后以 1–30 秒退避重连，保留游标；可用 `--since` 恢复先前进程的游标。鉴权等不可重试错误明确退出。回复 question 时传 `reply_to`，自动解决回复者对应的提及并通知提问者。桌面通知失败会输出诊断，消息监听继续运行。

包装器和 MCP 处理 SIGINT / SIGTERM / SIGHUP，MCP 还处理 stdin 关闭。关闭 MCP 连接不会结束共享的逻辑会话；由 `leave` 明确结束。包装器退出时若服务不可达，会报告清理失败并保留子进程退出码；活动状态在 90 秒无请求后变为不活跃，任务租约和写入锁仍按各自规则处理。

`watch` 本身不启动或唤醒模型。Claude Code 的 SessionStart 配置、可选的后台监听接入见 `adapters/`；无此能力的工具使用人工提醒与步骤间自查。`templates/start-team.sh` 是可选的 tmux 三角色启动脚本。

提供一个可选、无需 LLM 的只读测试执行模板：

```sh
agent-board run --as tester -- node /absolute/path/to/baton/templates/readonly-tester.ts -- node --test
```

它自动认领 tester 任务，按任务的 `repository` 选择仓库，读取任务或同仓库已完成依赖上的 commit SHA，在临时本地 clone 中检出该版本，运行**人在启动时指定**的命令，将报告保存到仓库外 `~/.agent-board/reports/<仓库路径摘要>/`，通过后提交独立验收。可用 `--reports <目录>` 指定仓库外位置；仓库内路径会被拒绝。失败会 blocked 并 @human，不自动勾选标准。`--once` 只处理一次。测试环境需要依赖安装时，请让启动命令指向你自己的准备与测试脚本；模板不会猜测包管理器或执行任务正文中的命令。Windows 下使用真实可执行文件（如 `node`、`pnpm.exe`），或显式提供 shell 及其参数。

## Dashboard

- 总览：任务计数、各仓库写入锁、参与者状态、实时活动、审批 / 阻塞 / 到期任务与提问。
- 看板：按状态分列、仓库、负责人和父任务过滤、父任务分组标题、分页、指针或键盘拖拽。
- 任务详情：验收标准、上下文、依赖、产物、统一时间线；审批、驳回、改派、冻结、优先级与内容编辑。
- 收件箱按最新消息游标分页；总览先筛选提问再分页，不会被普通消息挤掉。
- 提及建议支持 handle、`@role:`、方向键选择、Enter / Tab 确认和 Escape 关闭。
- 参与者活动、冻结 / 恢复、完成数、平均完成时间和退回率。平均完成时间从首次开工到验收通过，包含等待和返工；退回率为请求修改次数除以全部验收次数，按验收时负责人归属。旧事件缺少负责人时使用任务当前负责人，无样本显示「—」。
- 活动流倒序读取一页，按需翻页；SSE 从总览 `event_cursor` 开始，重连用 Last-Event-ID 补发。Dashboard 无需登录；Agent 请求携带本机接入密钥与会话 ID，token 不进入 URL。服务端保留原子事务提交后的事件日志。

HTTP 同时接受 `/tasks` 与 `/api/tasks` 风格；客户端使用 `/api`。CLI 覆盖全部操作，Agent MCP 不提供人工专属工具。完整 REST 路径和工具描述见 `packages/shared/src/index.ts`。错误统一包含 `code`、`message`、`next`。写操作额外返回 `unread` 与最紧急的未读摘要。

## 验证与实现边界

```sh
pnpm build
pnpm typecheck
pnpm test
```

测试覆盖真实 HTTP、SQLite 持久化、并发认领、事务回滚、角色权限、审批与自审限制、写入锁与租约、真实 Git 工作树校验、私信隔离、SSE 重连、长轮询、真实 CLI 子进程与 MCP stdio。

SQLite 使用 Node 24 的内置 `node:sqlite` 和版本化 SQL migration，没有引入 Drizzle 与原生扩展编译；Node 当前仍会打印 SQLite experimental 提示。前端采用 React、Vite、TanStack Query、Tailwind 和 dnd-kit；界面组件在仓库内实现。

阶段 4 的成本采集、GitHub 自动同步和全文搜索尚未实现。这里不托管模型会话，不存代码，不做远程部署或自动计费。实际模型是否能按角色约定完成语义任务，需要使用你本机可用的模型与工具单独验收。
