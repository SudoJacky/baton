#!/usr/bin/env bash
set -euo pipefail
# Run from the project root after building. Each role may use a different CLI.
command -v tmux >/dev/null
command -v agent-board >/dev/null
tmux new-session -d -s baton 'agent-board run --as planner -- claude'
tmux split-window -h -t baton 'agent-board run --as coder -- claude'
tmux split-window -v -t baton 'agent-board run --as tester -- codex'
tmux select-layout -t baton tiled
printf '%s\n' 'Dashboard: http://127.0.0.1:4100 (start the server separately; select a repository on each task).'
tmux attach-session -t baton
