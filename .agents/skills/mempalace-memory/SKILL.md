---
name: mempalace-memory
description: Recall and preserve Multica project decisions with the project-local MemPalace MCP. Use when a task asks what was decided, tried, constrained, or completed previously; when prior project context may affect a change; or when a confirmed durable decision, constraint, or implementation result should be retained for later work.
---

# MemPalace Memory

Use the repository-scoped `mempalace` MCP as historical context. Treat the current repository and its documentation as the authority for the current implementation.

## Recall

1. Call `mempalace_search` before answering questions about prior decisions, attempts, constraints, or results. Keep the query short and specific.
2. Use `mempalace_list_wings` and `mempalace_list_rooms` only when the relevant scope is unclear.
3. Use `mempalace_get_drawer` when the complete stored item is needed.
4. Cite the returned wing, room, and source when using a memory.
5. Verify claims about the current implementation against code, tests, ADRs, and current documentation. When memory conflicts with the repository, follow the repository and describe the memory as stale.
6. State when no relevant memory exists or when the MCP is unavailable. Do not fill gaps from model memory.

Do not search for greenfield work that has no plausible historical context.

## Save

Save only information that is both confirmed and useful beyond the current task:

- accepted architecture or product decisions;
- durable project constraints and operating rules;
- verified implementation outcomes, including the relevant code or documentation source;
- explicit superseding decisions that make an older memory stale.

Before writing:

1. Remove secrets and transient context.
2. Call `mempalace_check_duplicate` for a single item when semantic duplication is plausible.
3. Prefer `mempalace_add_drawer` when a repository-relative `source_file` can be recorded.
4. Use `mempalace_checkpoint` only for multiple independently confirmed items.
5. Use `mempalace_diary_write` only for durable session continuity, not a raw transcript or work log.
6. Let the MCP approval prompt surface. Never bypass or suppress write approval.

Use the `multica` wing. Choose `decisions`, `implementation`, or `operations` as the room. Store concise confirmed facts, not raw transcripts or speculative summaries. MemPalace preserves the text you submit verbatim.

## Never Save

- secrets, tokens, credentials, private keys, or API keys;
- environment variable values or local authentication state;
- `.env*` contents, raw logs, command output dumps, or stack traces;
- user-provided sensitive content unless the user explicitly requests retention after seeing the risk;
- local absolute paths, detected person names, or machine-specific configuration;
- temporary task prompts, issue runtime context, scratch notes, hypotheses, or unverified claims;
- content from `.multica*`, `.context`, `.agent_context`, build output, dependencies, or `.mempalace-local`.

MemPalace stores original text rather than a privacy-preserving summary. Approval and this skill reduce risk but do not provide content-level DLP. When uncertain, do not save.

## Operations

Use the project CLI for explicit maintenance only:

```bash
pnpm memory:doctor
pnpm memory:mine:dry-run
```

Do not install MemPalace globally, change user-level Codex or skill configuration, enable lifecycle hooks, start the HTTP transport, or expose maintenance and deletion tools through MCP.
