---
"executor": patch
---

`executor import-v1` now moves Executor 1's local (stdio) MCP servers. Each becomes an app, with
Executor 1's tool policies as its approval rules, whose command the background Executor keeps,
starts on first use and keeps running, and serves to that app alone over loopback, with Executor
1's non-secret environment. Servers that took credentials
in environment variables, or ran through Executor 1's Codex app-server adapter, still cannot move.
