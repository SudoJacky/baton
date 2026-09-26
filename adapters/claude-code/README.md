# Claude Code

构建并启动 Baton，把 `mcp.example.json` 中的两个路径改成本机绝对路径，合入工具的 MCP 配置。只需配置一次，不传每个 Agent 的 token 或环境身份。

默认采用 [主 Agent 派发流程](../../skills/baton/references/orchestration.md)，worker 使用 run_id 和四个简化工具，MCP 自动续租。需要下方手动协议时，在全局 MCP args 加 `--profile full`。

手动新会话提供对应的 `roles/planner.md`、`roles/coder.md` 或 `roles/tester.md`，调用 `join({handle, role})` 并保存返回的 `session_id`。角色不绑定工具或模型。后续每次 MCP 调用必须携带自己的 ID；恢复时调用 `whoami({session_id})`，明确结束时调用 `leave({session_id})`。不要把共享 MCP 的进程生命周期当作一个模型会话的生命周期。

可选地通过 `agent-board --config /path/to/agents.yaml run --as planner -- claude` 启动，复用包装器传入的 `BOARD_SESSION_ID`。仅在这种已绑定 ID 的环境下，才可使用 `settings.example.json` 的 SessionStart hook；它调用 CLI 输出当前身份与收件箱。普通 App/MCP 接入不需要该 hook。保留已有配置；工具 Hook 行为见 [官方参考](https://code.claude.com/docs/en/hooks)。

后台监听能力由工具自身提供。可以用 `agent-board --session <id> watch` 输出通知，但 Baton 不自动启动或唤醒模型。人工审批通过独立 Dashboard 完成。
