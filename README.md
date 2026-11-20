# claude-code-orchestrator

A two-mode switch for [Claude Code](https://claude.com/claude-code) sessions:

- **Vanilla** (default): Claude works directly and only hands off bulk reading and searching.
- **Orchestrator**: the main session becomes a lead. It plans, writes the pass/fail check for each piece of work, hands the pieces to specialised subagents, and accepts nothing until it has re-run the check itself.

Start the first message of a session with `orchestrator` to switch. The mode stays with that session through compaction and resume.

## Why

In November 2026 Anthropic had 1,000 Claude agents reproduce a formal proof of Fermat's Last Theorem in under 29 hours ([write-up](https://claude.dev/blog/safely-scaling-multi-agent-teams-with-fable-5-2/), [earlier run](https://www.anthropic.com/research/formalizing-fermats-last-theorem)). Strip away the scale and the method comes down to a few habits:

1. **A checker decides when work is done.** There, Lean's proof checker; here, your tests, typecheck, build, or another observable result. An agent saying "done" is a claim, not a result.
2. **Shared state lives in one place**, not in any agent's memory.
3. **Workers are isolated**, and their work lands only if it merges cleanly.
4. **Workers split tasks that are too big** instead of handing back half a job.
5. **"Impossible" needs evidence.** In that run, agents judged 47 of 60 statements infeasible, and most were proved anyway.

This package applies those habits at the scale of a feature: one lead and at most four agents at a time.

## Install

Requires Claude Code and Node.js 20 or newer, with `node` on your `PATH`.

```sh
git clone https://github.com/djbrandl/claude-code-orchestrator.git
cd claude-code-orchestrator
node install.mjs
```

The installer:

- copies the hook, the protocol and six agents into your Claude Code user config (`~/.claude`, or `$CLAUDE_CONFIG_DIR` if set);
- adds two hooks (`SessionStart` and `UserPromptSubmit`) to `settings.json`, saving the previous version as `settings.json.bak` whenever it changes the file.

It leaves your other settings and hooks alone, and checks everything before writing anything.

**Updating:** `git pull` then `node install.mjs` again. Files you haven't touched are replaced. Files you have edited are left alone and listed; to replace them too, run `node install.mjs --force`.

**Removing:** `node install.mjs --uninstall` removes the hooks and every file you haven't edited.

## Usage

| First message of the session | Result |
|---|---|
| starts with the word `orchestrator` (e.g. `orchestrator: add CSV export`) | Orchestrator mode for this session |
| anything else | Vanilla mode for this session |

Only the first message counts. To change modes, start a new session or run `/clear`. A forked or branched session keeps its parent's mode.

## What orchestrator mode does

**Roles.** Six agents, each on a model chosen for the job:

| Agent | Model | Job |
|---|---|---|
| `scout` | Haiku | search, read and summarise, run a command and report the result, mechanical edits |
| `packet` | Sonnet | a well-scoped change with named files and a done check |
| `hard-packet` | Opus | changes that need design judgment or root-cause debugging |
| `reviewer` | Opus | read-only review of finished work |
| `skeptic` | Opus | read-only adversarial review: tries to break the work |
| `architect` | Opus | read-only design and architecture questions |

**The loop.**

1. **Align.** Before any work goes out, the lead writes its done check. The agent doing the work never writes or edits its own check.
2. **Brief.** Each handoff states the objective, the done check, the files the agent may change (never the check's files), the boundaries, and the return format.
3. **Gate.** A piece of work passes only if:
   - it changed nothing outside its file list, and
   - the lead's own re-run of the check passes.

   After each batch of parallel work, the full project check runs once.
4. **Isolate.** Parallel workers get their own git worktree only when that copy is guaranteed to start from your current commit; otherwise they share the tree with separate file lists. See below.
5. **Split.** An agent facing a task too big for one handoff returns a proposed split rather than a partial job.
6. **Track.** `tasks/todo.md` in the project holds the live state, so a fresh session can pick up where the last one stopped.

The full rules are in [`hooks/orchestrator-protocol.md`](hooks/orchestrator-protocol.md).

### Worktree isolation

Claude Code branches agent worktrees from your remote's default branch unless you set:

```json
{ "worktree": { "baseRef": "head" } }
```

The protocol uses worktrees only when your working tree has no uncommitted changes and the worktree will start from your current commit. That means either this setting is on, or your current commit is the remote default branch. Otherwise workers share the tree with separate file lists. Setting `baseRef` to `"head"` in `settings.json` lets parallel work on feature branches use worktrees.

## Customising

- **Personal rules:** put them in `hooks/orchestrator-protocol.local.md` inside your Claude Code config folder. They are appended to the protocol, and the installer never overwrites or removes that file.
  - Hook context is capped at 10,000 characters. If the protocol plus your rules exceed that, Claude is told to read both files instead.
- **Models and agent behaviour:** edit the files in your config's `agents/` folder. Updates then leave them alone unless you use `--force`.
- **Concurrency:** the protocol caps parallel agents at four. Ask for more in a session, or change the cap in the protocol.

## How it works

`hooks/session-mode.mjs` handles both hook events:

- **First `UserPromptSubmit` of a session:** saves the session's mode. If it is orchestrator mode, the hook injects the protocol alongside your message.
- **`SessionStart` on `startup` and `clear`:** tells Claude the session starts in vanilla mode.
- **`SessionStart` on `fork`:** keeps the parent's mode. The copied conversation already carries it, and the hook records it from that copy at the first resume or compaction.
- **`SessionStart` on `resume` and `compact`:** re-injects the saved mode, including the full protocol for orchestrator sessions.

Modes are stored as one small file per session in `session-modes/`. Files for sessions unused for 30 days are pruned.

## Development

```sh
npm test
```

The tests use temporary config folders and never touch your real Claude Code config.

## License

[MIT](LICENSE)
