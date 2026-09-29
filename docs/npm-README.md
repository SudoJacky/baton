# Baton

让不同宿主里的 Agent 通过本机看板共享任务、消息和交接记录。

需要 Node.js 24+。运行：

```sh
npx @sudojacky/baton
```

首次运行会初始化 `~/.agent-board/agents.yaml`，启动本机服务并打开浏览器。
按终端给出的 MCP 配置接入 Codex 或 Claude Code，无需手填程序路径或 token。
保留终端，按 Ctrl+C 停止；下次运行同一条命令即可恢复原有看板。
数据库位于 `~/.agent-board/board.sqlite`，与 npm 缓存和目标代码仓库分开保存。

```sh
npx @sudojacky/baton --no-open
npx @sudojacky/baton setup --host codex
npx @sudojacky/baton setup --host claude-code
npx @sudojacky/baton install-skill
npx @sudojacky/baton board --help
```

`install-skill` 将随包附带的技能复制到 `$CODEX_HOME/skills/baton`，未设置
`CODEX_HOME` 时使用 `~/.codex/skills/baton`。已有目录会拒绝覆盖，更新前请先移走旧版本。
技能安装是可选的；MCP 接入和启动服务仍按终端提示完成。

可用 `--config <绝对路径>` 选择已有配置。首次初始化时用 `--port <端口>` 指定端口；
已有配置要同时修改其中的 `url`，保证 MCP 和服务使用同一地址。
端口被占用、配置损坏或权限不足时会明确报错，不会重置数据或自动改用另一个看板。

MCP 配置固定为当前安装版本。更新 Baton 后重新运行 `setup` 更新宿主配置并重新加载连接。
源代码安装、角色约定和完整使用说明见 [项目文档](https://github.com/SudoJacky/baton#readme)。
代码任务需要 Git 和实际目标工作树；Baton 不负责安装或启动模型宿主。
