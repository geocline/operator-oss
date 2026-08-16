You are working in `/Users/geo/Claude Projects/operator`.

Start by reading `HANDOFF.md`, then follow its pointers to `AGENTS.md` if
present, `CLAUDE.md`, the harness-admission design, and the August 13 Kimi Code
research report.

Before editing, run `git status --short` in both Operator and
`/Users/geo/Claude Projects/LiteLLM server`. Do not revert, delete, overwrite,
or stage unrelated dirty/untracked files. Do not use `git add .`.

Execute cross-harness testing waves 1–4 in order. Begin with Wave 0: build the
reusable opt-in admission runner test-first, then run Kimi K3 and DeepSeek V4
Pro through the existing Claude Code/LiteLLM adapter. Do not change gateway
harness/admission metadata until the exact pairing has passed and a sanitized
evidence artifact exists.
