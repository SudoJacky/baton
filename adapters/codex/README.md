# Codex App 与 CLI

构建 Baton 并启动服务，将 `config.example.toml` 中的 MCP 程序路径和 `agents.yaml` 路径换成本机绝对路径，再合入用户级 Codex MCP 配置。保留其他配置。只配置一次，不填写 token，不设置逐会话的 `BOARD_AGENT` 或 `BOARD_TOKEN`。

配置使用 stdio 的 `command`、`args`；App 和 CLI 可共享用户级 MCP 设置，见 [OpenAI 官方 MCP 说明](https://learn.chatgpt.com/codex/extend/mcp)。在 App 的 MCP 设置中重新加载连接后，新会话即可使用。MCP 读取与指定配置相邻的自动生成接入文件；该文件不存在时先启动 Baton，旧配置先运行 `agent-board --config <path> migrate`。

## 三个 App 会话

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

角色文件位于 `roles/planner.md`、`roles/coder.md`、`roles/tester.md`。如果使用另一个项目，把文件的绝对路径提供给会话。同一个 MCP 可服务多个仓库；创建任务时传 `repository` 绝对路径，后续按任务返回的路径选择工作目录。App 独立 worktree 必须明确绑定到任务，Baton 不自动同步或合并它们。

## CLI

MCP 不可用时，在 App 的 shell 工具或普通终端也可调用 Baton CLI：

```sh
agent-board --config /path/to/agents.yaml join --handle coder --role implementer --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> inbox --json
```

`agent-board run --as coder -- codex` 仍是可选便利包装器，不是接入前提。包装器创建的 ID 已在 `BOARD_SESSION_ID` 中，使用它即可，无需再 `join`。全局 MCP 从不把这个环境变量作为所有请求的默认身份。

没有模型会话请求时，不发送后台心跳。看板显示最近活动，不能把 MCP 连接存在当作模型在线；`watch` 仍只通知，不自动唤醒其他 App 会话。
