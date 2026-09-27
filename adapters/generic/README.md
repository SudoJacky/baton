# 通用 CLI 接入

在工具可执行 shell 命令时，先加入，再在后续命令显式传入会话 ID：

```sh
agent-board --config /path/to/agents.yaml join --handle coder --role implementer --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> whoami --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> inbox --json
agent-board --config /path/to/agents.yaml --session <返回的UUID> task next --role-hint implementer --json
```

`join` 返回的 ID 不是秘密，不需要逐 Agent 凭证配置。本机接入密钥由服务初始化并由客户端自动读取。角色约定见 `roles/coder.md`；恢复时复用原 ID，结束协作时调用 `leave`。活动请求不续任务租约。

派发 worker 直接使用 `run_id`，无需 join。派发回执的 `integration.worker_get` 提供可运行命令与 argv；报告目录使用 `evidence_directory`。`agent-board doctor --run-id <id> --json` 检查接入及任务绑定，`agent-board --session <id> doctor --json` 返回恢复待办。单次 CLI 不维持续租，自检会明确提示；应由持续连接的 MCP 或宿主负责 `worker heartbeat`，不能把成功读取任务当作续租已就绪。

需要直接启动一个外部 CLI 时，可选用：

```sh
agent-board --config /path/to/agents.yaml run --as coder -- your-agent-cli
```

包装器传入 `BOARD_CONFIG`、`BOARD_URL`、`BOARD_AGENT` 与 `BOARD_SESSION_ID`，子命令可省略 `--session`。它不传 Agent token，也不发送心跳；退出时结束自己创建的会话并保留子进程退出码。

现有会话通过 `--as` 指定的 handle 必须与其 ID 对应的身份一致。Dashboard 默认使用本地用户，独立人工终端可用 `--as <人工 handle>`，无需登录码。Agent 必须使用自己的会话，不借人工入口绕过审批；这属于本机可信协作约定，不提供进程隔离。

完整命令通过 `agent-board --help` 和子命令 `--help` 查看。结构化业务参数可用 `agent-board --session <id> call update_task --data-file input.json --json`；ID 在全局参数中，业务 JSON 不包含 `session_id`。

`agent-board --session <id> watch` 持续输出提及的 JSON 行，`--notify` 请求桌面通知；不会自动启动模型或向其他会话注入输入。
