---
"executor": patch
---

`executor import-v1` moves a local Executor 1 setup into Executor 2. It reads Executor 1's data
directory (`~/.executor`, or `--from`) and, per workspace, turns each integration into an app,
generated as Executor Cloud's v1 import generates it, with Executor 1's tool policies as its
approval rules, and each connection into an account holding its `auth.json` credential, linked
to that app. `--dry-run` reports what each item would become, and why, and writes nothing.
The background Executor runs the import and reports what it did with each item; it records what
moved, so running it again moves only what has not, and never replaces a version of an app you
deployed yourself. No credential value is ever printed; `--json` prints the report for programs.
