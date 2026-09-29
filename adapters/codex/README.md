# Codex App 与 CLI

使用发行包时运行 `npx @sudojacky/baton` 启动服务，复制终端中的 Codex MCP 配置即可；
也可用 `npx @sudojacky/baton setup --host codex` 单独生成。可选技能通过
`npx @sudojacky/baton install-skill` 安装，已有技能不会覆盖。
更多启动选项见 [初次使用](../../README.md#初次使用)。
源码安装可运行 `node packages/client/dist/launcher.js setup --host codex`，
使用旧配置时附加 `--config <绝对路径>`。以下保留手动接入方式。

构建 Baton 并启动服务，将 `config.example.toml` 中的 MCP 程序路径和 `agents.yaml` 路径换成本机绝对路径，再合入用户级 Codex MCP 配置。保留其他配置。只配置一次，不填写 token，不设置逐会话的 `BOARD_AGENT` 或 `BOARD_TOKEN`。

配置使用 stdio 的 `command`、`args`；App 和 CLI 可共享用户级 MCP 设置，见 [OpenAI 官方 MCP 说明](https://learn.chatgpt.com/codex/extend/mcp)。在 App 的 MCP 设置中重新加载连接后，新会话即可使用。MCP 读取与指定配置相邻的自动生成接入文件；该文件不存在时先启动 Baton，旧配置先运行 `agent-board --config <path> migrate`。

## 一个主会话编排

宿主提供子 Agent 和相应模型时，可在一个主会话中使用 [Baton 技能](../../skills/baton/SKILL.md)：

```text
$baton 由你作为 planner，把当前需求记录到 Baton 并拆成任务。
使用 gpt-6-sol xhigh 子 Agent 实现，使用 gpt-6-luna xhigh 子 Agent 独立验收；由你跟进返工与最终交付。
```

主 Agent 直接调度两个同级子 Agent，不需要手工建立三个 App 会话。主 Agent 调用 dispatch_task 准备身份与任务，再把 run_id 交给子 Agent；子 Agent 只使用 get_task、post_message、submit、review，不需要 join 或自己的 MCP 配置。MCP 自动续租；没有暴露 MCP 时可用 CLI 对应接口，但单次 CLI 命令不会维持自动续租。

默认直接使用项目现有目录和当前分支，无需创建独立 worktree：coder 提交后停止修改，tester 在同目录验收，退回则由原 coder 修复。主 Agent 暂停该目录的其他写入安排，tester 在测试前后核对 HEAD 与目录状态。独立验收仍由不同 Agent 完成；独立目录和额外合并步骤仅在明确需要时使用。

模型与推理强度由宿主的子 Agent 创建调用设置，不写入 Baton 参与者资料。实现交接后 tester 直接验收原任务，失败交回原 coder。默认仅计划在 Dashboard 审批，之后自动推进；可选的 merge 发布审批由设置页控制。共享目录锁延续至独立验收结束，技能不提供后台调度器或自动合入；完整步骤见 [主 Agent 编排](../../skills/baton/references/orchestration.md)。

## 三个独立 App 会话（手动协议）

需要全部手动工具时，在共享 MCP 的 args 中加 `--profile full`；无须逐会话配置。默认 workflow 工具集面向主 Agent 派发与四工具 worker。

在同一个目标仓库分别新建会话，提供对应角色约定和初始指令：

- `$baton 以 planner 身份加入，角色为 planner，准备规划需求。`
- `$baton 以 coder 身份加入，角色为 implementer，处理分配给我的实现任务。`
- `$baton 以 tester 身份加入，角色为 tester，独立验收交接的提交。`

每个会话调用 `join` 并保留各自的 `session_id`，其余 MCP 调用全部携带自己的 ID。例如：

```json
{ "handle": "coder", "role": "implementer" }
```

上面用于 `join`；收到响应后，`whoami` 使用：

```json
{ "session_id": "返回的实际 UUID" }
```

恢复时复用 ID，不重复加入。MCP 或服务重启不改变已持久化的会话；明确结束协作时调用 `leave`。会话 ID 只是本机可信协作中的归属标识，不提供恶意进程隔离。人工审批仍在 Dashboard 完成，Agent MCP 不暴露人工专属操作。

角色文件位于 `roles/planner.md`、`roles/coder.md`、`roles/tester.md`。如果使用另一个项目，把文件的绝对路径提供给会话。同一个 MCP 可服务多个仓库；创建任务时传 `repository` 绝对路径，后续按任务返回的路径选择工作目录。同仓库默认使用现有目录并串行协作；若主动选择 App 独立 worktree，必须明确绑定到任务，Baton 不自动同步或合并它们。

## CLI

MCP 不可用时，在 App 的 shell 工具或普通终端也可调用 Baton CLI：

```sh
agent-board --config /path/to/agents.yaml join --handle coder --role implementer --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> inbox --json
```

`agent-board run --as coder -- codex` 仍是可选便利包装器，不是接入前提。包装器创建的 ID 已在 `BOARD_SESSION_ID` 中，使用它即可，无需再 `join`。全局 MCP 从不把这个环境变量作为所有请求的默认身份。

空闲 MCP 不发送心跳；只有派发的活跃 assignment 自动续租。看板显示最近请求，不能把续租或 MCP 连接当作模型进程存活；`watch` 仍只通知，不自动唤醒其他 App 会话。
