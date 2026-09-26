# 主 Agent 编排

用户要求主子 Agent 协作时使用。主 Agent 是 planner，负责实际启动、跟进和停止子 Agent；Baton 的 `dispatch_task` 仅准备任务和执行身份，不启动模型。主会话停止后没有后台调度器继续工作。

## 计划只审批一次

1. planner 首次 `join`，保留自己的 `session_id`；恢复时 `whoami`，查询已有计划和 `get_settings`，避免重复建任务。
2. 创建顶层 `plan`，默认进入草稿。先建齐全部子任务，用 `parent_id` 关联计划；每个代码任务提前选定 `repository`，写清范围、验收标准、测试命令与必要上下文。`depends_on` 只引用真正需要先完成的工作，不要另建依赖原实现完成的验收任务。
3. `request_approval({session_id,id:计划ID,to_status:"open",reason})` 后等待 Dashboard 的“批准计划”。默认 `approval_mode="plan"`：批准覆盖已定义的子任务，普通实现和最终验收不再各自审批。空计划和仓库未选齐的计划不能批准；批准前禁止开工，批准后范围、验收标准、依赖与仓库锁定。新增或改动范围使用后续计划，不能悄悄追加到已批准计划。
4. 用户有分支合入需求时，提前把 `merge` 类型子任务放入计划并依赖已验收的实现，记录目标分支。`merge_approval=true` 时在依赖完成后申请该任务发布审批；关闭时派发会自动发布。默认在现有分支工作，无需强加合入任务。Baton 不自行执行 Git merge。
5. 若现有看板为 `approval_mode="custom"`，保留用户配置并按真实 gates 处理，必要时使用高级操作参考；不要代人修改审批策略。新的默认模式不改变已存在任务的状态或冒充旧计划已获批。

## 派发与循环

主 Agent 保留“任务 ID → 宿主子 Agent → 本轮 run_id”的对应。默认同仓库串行，不创建 worktree、clone 或新分支。不同仓库的独立任务可按用户授权并行。

`dispatch_task({session_id,id:任务ID,handle:"coder",mode:"implement"})` 会准备 coder 身份、原子认领/恢复、开工并取得写入锁，返回 `run_id` 和任务上下文。**成功后再调用宿主的 spawn 工具**，把结果交给子 Agent；重复派发同一活跃任务返回同一 run_id，不能据此重复启动模型。

Codex 有相应工具时，实际创建调用使用下列参数；替换任务包，不仅在提示中写模型名字：

```json
{
  "task_name": "coder_t42",
  "model": "gpt-6-sol",
  "reasoning_effort": "xhigh",
  "fork_turns": "none",
  "message": "替换为下方 coder 任务包"
}
```

```json
{
  "task_name": "tester_t42",
  "model": "gpt-6-luna",
  "reasoning_effort": "xhigh",
  "fork_turns": "none",
  "message": "替换为下方 tester 任务包"
}
```

coder 返回后通过 planner 的 `get_task({session_id,id,include_thread:true})` 核对真实状态与交接；`in_review` 时调用 `dispatch_task({session_id,id,handle:"tester",mode:"review"})`，再启动同级 tester。tester 使用自己的 run_id，直接验收原任务。模型或宿主委派能力不可用时说明缺口，不悄悄替换模型或声称已启动。

| 服务端状态                           | 下一步                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| 计划草稿                             | 等待唯一的计划审批，不派发编码                                                                |
| `open`，或未设审批 gate 的子任务草稿 | 依赖完成后派发 coder                                                                          |
| `in_progress`                        | 跟进已有 worker，MCP 自动续租                                                                 |
| `in_review`                          | 确认 coder 已停止修改，派发独立 tester                                                        |
| `changes_requested`                  | 保持原任务与 attempt，重新 dispatch 原 coder handle，传新的 run_id；可 follow-up 已有子 Agent |
| `done`                               | 推进依赖任务，不重复申请最终完成审批                                                          |
| `blocked` / frozen                   | 读原因；返工上限或合入冲突交给人，不能换任务或身份重置计数                                    |

管理的代码任务从开工到验收结束一直保留仓库锁，包括 coder 与 tester 交接间隙；外部编辑器仍能改文件，主 Agent 也应停止同目录其他写者。MCP 仅为活跃 assignment 续租，不要求模型发进度心跳。worker 完成后自动停止续租。

宿主启动失败或 worker 提前退出时，先确认旧执行者已停止，再 `stop_worker({session_id,run_id,reason})`，保留现场。编码中止后任务 blocked，可查清原因后重新派发原 handle；验收中止后任务保持 in_review，可重新派发验收。MCP 重启或网络中断时，读取原 run_id：仍 active 可继续并恢复自动续租；expired/stopped 需重新派发。主 Agent 不能仅凭一个挂着的 MCP 推断 worker 还在运行。

## 最小任务包

coder：

```text
使用 <绝对路径>/baton/SKILL.md 的四工具 worker 流程。
本轮 run_id=<派发结果>，任务=T-<id>，主协调者=<planner handle>。
仓库=<task.repository>；范围、验收、命令=<派发上下文>。
直接使用现有目录与当前分支，不创建 worktree、clone 或任务分支。
get_task 核对后实现并自测，保留他人改动；提交后用 submit 附完整 commit_sha。
交接后停止修改，返回服务端状态和证据，不自审或继续派生 Agent。
```

tester：

```text
使用 <绝对路径>/baton/SKILL.md 的四工具 worker 流程。
本轮 run_id=<独立验收派发结果>，任务=T-<id>，commit_sha=<派发结果>。
仓库=<同一个 task.repository>；验证依据与命令=<上下文>。
get_task 核对后在同目录独立验证，测试前后核对 HEAD、干净状态和任务版本。
不修改实现，不创建副本；异常先报告，不能通过 checkout/reset/stash/clean 改造现场。
通过用 review 携带全部已核验 criteria_passed，失败直接 changes_requested 并记录可定位证据。
返回真实服务端状态及检查结果，不再另行申请默认的最终验收审批。
```

子 Agent 无需 join、session_id、手动续租或收件箱操作；共享 MCP 即可。缺少 MCP 时可用 CLI 的对应接口，但单次 CLI 请求不会维持自动续租，完整手动协议见操作参考，不能声称享有 MCP 的自动管理。

## 收尾

返工次数达到配置上限时服务端自动 blocked 并通知人。合入冲突由实际执行 Git 的 merge worker 通过 `post_message(escalation="merge_conflict")` 报告，服务端冻结并通知人；不擅自解冻。产生新 SHA 后重新提交独立验收。

全部子任务 done（或已由人取消）后，planner 核对总计划标准并 `complete_plan({session_id,id,summary,criteria_passed:[已验证的计划标准ID]})`，不再自建一轮计划终验。`done` 表示相应任务通过；只有实际 merge 任务及 Git 证据才能证明分支已合入。

最终报告计划/任务 ID、完成范围、独立测试证据、实际 SHA 和遗留问题。只派发不算完成；在主会话有效期间跟进至交付或明确阻塞。测试证明工具闭环，不等于真实模型已完成该业务。
