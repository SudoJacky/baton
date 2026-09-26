---
name: baton
description: 使用 Baton 管理主子 Agent 协作：主 Agent 规划并派发 coder/tester，计划批准后执行与验收自动推进。也用于查看或处理已分配的看板任务；不用于开发 Baton 服务本身或无关编码任务。
---

# Baton 协作

Baton 保存任务与证据，主 Agent 用宿主的子 Agent 工具驱动执行。默认共用项目现有目录和当前分支，串行完成实现、独立验收和返工；无需额外 worktree、clone 或合并步骤。

- **收到 `run_id` 的 worker**：只读下方四工具流程，无需加载编排或高级操作参考。
- **主 Agent 编排**：用户要求协作或委派时，读 [编排流程](references/orchestration.md)。默认 coder 使用 `gpt-6-sol` / `xhigh`，独立 tester 使用 `gpt-6-luna` / `xhigh`；用户指定优先。
- **只看状态**：planner 会话通过 `get_task` / `list_tasks` 查询，不派发或改变任务。
- **手动操作旧任务、CLI 或自定义 gates**：按需读 [高级操作参考](references/operations.md)，不把旧协议加到简化 worker 流程中。

## Worker 的四个操作

直接使用主 Agent 给出的 `run_id`，它绑定任务、身份及本轮阶段；不是人的凭证，也不能借用其他 worker 的 ID。共用一个已连接的 MCP，不需要每会话配置。

| 工具           | 参数与用途                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------- |
| `get_task`     | `{run_id}`，读取 `data.task`、讨论、本轮状态和 `data.commit_sha`                              |
| `post_message` | `{run_id,body,kind:"report"}`，向当前任务报告证据或问题，不处理收件箱 ID                      |
| `submit`       | coder：`{run_id,summary,commit_sha}`，提交完整 SHA；非代码任务可不传 SHA                      |
| `review`       | tester：`{run_id,verdict,comments,commit_sha,criteria_passed:[真实criterion ID]}`，通过或退回 |

身份、认领、开工、写入锁由派发接口准备。MCP 自动续租；worker 不再 join、claim、手动续租、勾选标准或申请审批。完成本轮后旧 `run_id` 失效，返工使用新派发结果。MCP 断开后服务保留现场并在租约到期后通知协调者，不证明模型仍在运行。

coder 只在返回的任务为 `in_progress` 时修改，使用任务的 `repository` 作为每条 shell 命令的工作目录。完成相关自测，提交任务改动，使 HEAD 等于提交 SHA 且工作目录干净；保留别人的改动，不通过 reset、stash 或清理文件凑出干净状态。报告文件放到仓库外。`submit` 成功后停止修改并交回主 Agent。

tester 使用指定 SHA 在同目录验证，不修改实现。测试前后核对 HEAD、目录状态和任务；服务端也在派发与批准时检查。通过时在 `criteria_passed` 中列出所有亲自核验的标准 ID，未满足就 `review(verdict="changes_requested")` 并给可定位问题。未运行的检查如实说明。主 Agent 创建同级 tester，coder 不自审、不派生验收者。

若分配的是 `merge` 任务且实际遇到合入冲突，用 `post_message({run_id,body:"冲突文件及现场",escalation:"merge_conflict"})`。服务会停止该 worker、冻结任务并通知人，保留目录和锁。普通问题发任务消息交回协调者；冻结、返工上限和审批不能通过换身份绕过。

## 接入与收尾

优先使用已连接的 Baton MCP。默认 `workflow` 工具集包含上述四工具及 planner 的规划/派发工具；完整手动工具集需全局启动参数 `--profile full`。本机接入文件由客户端读取，不打印或复制；Dashboard 默认使用本地用户。

只有 planner 或手动协议会话需要 `join` 并保留自己的 `session_id`；之后每次规划调用显式携带它。worker 只传 `run_id`，不继承 planner 身份。ID 用于可信本机协作归属，不是进程隔离。

显式使用本技能执行任务时，可以在对应任务讨论内记录必要的证据、交接和求助；不向无关频道或外部应用发消息。最后返回任务 ID、服务端确认的状态、准确 SHA、实际验证和遗留问题。子 Agent 聊天回复不能代替成功的 Baton 提交或验收。
