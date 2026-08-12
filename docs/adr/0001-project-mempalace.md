# ADR 0001: Project-Local MemPalace

- Status: Accepted
- Date: 2026-08-12
- Issue: MUL-4

## Context

Multica needs durable AI memory without changing the product backend, database, or frontend and without affecting Codex outside this repository. MemPalace stores verbatim content, so accidental global scope, implicit mining, and unreviewed writes are unacceptable.

## Decision

Use three repository-owned layers:

- `.codex/config.toml` registers one optional stdio MCP server for trusted copies of this project.
- `.agents/skills/mempalace-memory/SKILL.md` defines recall, verification, retention, and sensitive-data rules.
- `scripts/mempalace.mjs` provides explicit setup, initialization, mining, diagnosis, and smoke-test commands.

Pin MemPalace to `3.7.0` and Python to `3.12` through `tools/mempalace/pyproject.toml` and `uv.lock`. Store the virtual environment, model cache, configuration, Chroma data, logs, and temporary files under `.mempalace-local/`. Redirect `HOME`, `USERPROFILE`, XDG, Hugging Face, uv, pip, Python, temp, and palace environment variables for every MemPalace child process.

Generate `mempalace.yaml` and an empty `entities.json` from reviewed templates. Do not run MemPalace's entity-discovering initializer. Mining remains explicit, repository-bounded, and dry-run by default. The project adapter always scans from the Git root before narrowing to the requested subtree, so a nested target cannot bypass the root exclusion policy. The template excludes secrets, Multica task context, dependencies, generated output, and local memory data.

Expose only status, search, taxonomy lists, drawer reads, duplicate checks, reviewed drawer/checkpoint writes, and diary reads/writes. Codex prompts on every write tool. Do not expose delete, sync, MCP mine, hook settings, configuration mutation, or logstream tools.

Run one writable MCP process per checkout. The launcher owns a process-lifetime project lock and fails a second writer with an actionable diagnostic. Cross-worktree sharing and parallel writable sessions are outside this version.

Automatic save hooks and the HTTP transport are disabled. Reconsider a loopback-only single-instance HTTP service before supporting multiple writable worktrees or sessions.

## Consequences

- The setup command is the only command that installs the project-local Python runtime and dependencies or prewarms the local embedding model, and it may require network access. It installs Python 3.12 under `.mempalace-local`, validates the native `uv.lock` offline, then syncs from the official PyPI index.
- Normal MCP startup never installs, downloads, or falls back to a user-level palace.
- `pnpm memory:init` creates only reviewed local configuration; it does not mine repository content.
- `pnpm memory:mine:dry-run` previews repository mining. `pnpm memory:mine` is the explicit write path.
- Default tests use a fake MCP executable and do not access PyPI or Hugging Face. Set `MEMPALACE_RUN_REAL_SMOKE=1` for the opt-in persisted-canary smoke test after setup and initialization.
- MemPalace stores original text. Tool approval and skill policy are risk controls, not DLP.

## Verification

1. Snapshot the contents and timestamps of user-level `.codex`, `.agents`, and `.mempalace` before setup; compare the snapshot after setup, initialization, tests, and smoke.
2. Run `pnpm memory:doctor` from the repository root and a nested directory.
3. Verify Codex loads `mempalace` from the root and nested directories only after trusting this project. Verify a neighboring repository has no such project MCP.
4. Run `pnpm memory:mine:dry-run` with an `.env.local` canary and confirm the excluded file is absent. Run the explicit mine and confirm it remains absent from search.
5. Run `MEMPALACE_RUN_REAL_SMOKE=1 pnpm memory:smoke`; it writes a unique sourced canary, restarts stdio MCP in offline mode, and retrieves the same canary with its `multica` wing and source.
6. Verify a missing runtime, a drifted lock, an out-of-project palace or mine path, and a second writer all exit nonzero with an actionable message.

## Rollback

Remove the project MCP configuration, Skill, CLI scripts, dependency files, package scripts, and this ADR. Back up `.mempalace-local/palace` if its memory should be retained, then remove `.mempalace-local` to delete all project memory and runtime data.
