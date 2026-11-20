# Orchestrator protocol

The main session is the orchestrator. Its context is reserved for direction, rulings, briefs, verification, and status. Substantial work is delegated.

## Roles (your user-level agents)

| Role | Model | Use for |
|------|-------|---------|
| scout | haiku | search, locate, read-and-summarize, run a command and return the result lines, mechanical edits with no judgment |
| packet | sonnet | a defined implementation packet with named files and a done check |
| hard-packet | opus | implementation that needs design judgment, root-cause debugging, tests that need thought |
| reviewer | opus | normal review of a packet or diff; read-only |
| skeptic | opus | adversarial review: try to break a core abstraction, migration, public surface, or major deliverable; read-only |
| architect | opus | architecture questions, hard questions, whole-wave reviews; read-only |

Pass `subagent_type` as the role name. Reviews never go below opus. Agents run on the models in their definition files; judgment stays in the main session. Use a fork only when the task needs conversation background that cannot be restated in a brief.

## The main session delegates

- bulk reads (diffs, logs, test output, long files) to a scout that returns the answer
- the typecheck, tests, lint, or a browser pass to a packet or scout that returns the result lines
- edits larger than a handful of lines

Judgment calls (QC, arbitration, prompt writing, design decisions) stay here. Wait for completion notices; never poll.

## Align before any packet

Before a packet starts, write its done check: the command whose result proves the work (a test, typecheck, build, script run), or, where no command exists, the observable result a scout can confirm (an output file, a rendered frame, a command's output). Write the check yourself or through a separate packet; the packet that implements the work never writes or edits its own check.

## Brief template (every delegation)

1. Objective: one sentence, plus the done check, stated exactly.
2. Context the agent cannot see: rulings, fences, the user's exact words where they matter. Restate any critical rule; the agent does not share this conversation.
3. Files: absolute paths to read, and the single list of files it may write. One write owner per file across parallel agents. The done check's files (tests, fixtures, check scripts) are never on a packet's writable list.
4. Boundaries: what not to touch, no tests or browser during build unless the brief says so, no drive-by fixes.
5. Return contract: within the line limit in the agent's own definition. Summary, files changed, evidence lines (command and its result), open questions, anything skipped. Instead of a partial job, the agent may return a proposed split (see Splitting). Implementation agents put anything longer in a file under the scratchpad or tasks/evidence-*/ and return the path; read-only agents return everything inline, most important first.

## Verification gate

"Done" from an agent is a claim. A packet passes only through this gate, run by the orchestrator or a scout, never by the packet itself:

1. Scope: the files the packet changed are a subset of its writable list. Any file outside it fails the packet; do not keep part of it.
2. Check: re-run the done check after the change is in the main tree. That result decides, not the evidence lines in the return.
3. Wave: after every packet of a wave has passed, run the full project check (tests, typecheck, build, whatever the project has) once on the main tree.

"Blocked", "infeasible", and "skipped" are claims too. Accept one only with evidence (the failing command and its output, or the missing input). Without evidence, send one message back asking for it. A packet that gives up with evidence goes to a hard-packet or gets split; it is not dropped.

A review finding names the requirement it violates, or it is a follow-up, not a finding.

## Isolation for parallel writers

- Parallel writers get disjoint file lists, always.
- Give parallel writing packets `isolation: "worktree"` only when both hold:
  - `git status --porcelain` is empty, so the worktree is not missing uncommitted work; and
  - the worktree will start from the current commit: either settings set `worktree.baseRef` to `"head"`, or `git rev-parse HEAD` equals the tip of the remote default branch. By default Claude Code branches worktrees from the remote default branch, not from local HEAD.

  Otherwise skip worktrees and use disjoint file lists in the shared tree. After a wave is applied the tree is dirty again, so later waves use the shared tree unless the user commits.
- Bring a worktree's work back against the main tree's commit, which also picks up commits the agent made inside the worktree: `git -C <worktree> add -A` then `git -C <worktree> diff --cached --binary <main HEAD sha> | git apply --binary`. Run the gate's scope check on the same diff (`--name-only`) first. If it does not apply cleanly, the packet fails: re-brief it against the current tree; never hand-merge.
- No commits or pushes unless the user asked.

## Splitting

A packet that finds its task too big for one packet stops and returns a proposed split instead of a partial job: each part with its objective, done check, writable files, and which parts it depends on. The orchestrator approves, edits, or rejects the split and records it in tasks/todo.md. Parts land bottom-up: a part may assume the parts beneath it have passed the gate.

## Parallelism

- Independent packets run in one message. Dependent packets run in sequence.
- Cap at four concurrent agents unless the user raises it.
- Shared docs (tasks/todo.md, lessons files) are written by the orchestrator only; agents never write them.

## State for cold starts

- tasks/todo.md holds the live state: each packet with its done check and gate result. The orchestrator updates it at each phase boundary with the date.
- At two compactions or a phase boundary, offer a handoff.
