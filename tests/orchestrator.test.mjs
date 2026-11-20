import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync, statSync, utimesSync, symlinkSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoHook = join(repo, "hooks", "session-mode.mjs");
const installer = join(repo, "install.mjs");
const agents = readdirSync(join(repo, "agents"));

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const newConfig = () => join(mkdtempSync(join(tmpdir(), "cco-")), "config");

function run(script, args, env, input = "") {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Sends one hook event; returns the injected context, or "" when the hook printed nothing.
function send(hookPath, config, event) {
  const r = run(hookPath, [], { CLAUDE_CONFIG_DIR: config }, JSON.stringify(event));
  assert.equal(r.code, 0, r.err);
  if (!r.out) return "";
  const out = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(out.hookEventName, event.hook_event_name);
  return out.additionalContext;
}

const start = (h, c, session_id, source) => send(h, c, { hook_event_name: "SessionStart", session_id, source });
const prompt = (h, c, session_id, text) => send(h, c, { hook_event_name: "UserPromptSubmit", session_id, prompt: text });

test("hook: vanilla by default; the first prompt decides the mode", () => {
  const c = newConfig();
  assert.match(start(repoHook, c, "s1", "startup"), /^SESSION MODE: VANILLA\. .*starts with "orchestrator"/);
  assert.equal(prompt(repoHook, c, "s1", "fix the login bug"), "");
  assert.equal(prompt(repoHook, c, "s1", "orchestrator please"), "", "a later prompt must not switch modes");
  assert.match(start(repoHook, c, "s1", "compact"), /^SESSION MODE: VANILLA\. Work directly[^"]*$/);
});

test("hook: 'orchestrator' as the first word switches and survives compact and resume", () => {
  const c = newConfig();
  start(repoHook, c, "s1", "startup");
  const ctx = prompt(repoHook, c, "s1", "  Orchestrator: build the export feature");
  assert.match(ctx, /^SESSION MODE: ORCHESTRATOR/);
  assert.match(ctx, /## Verification gate/);
  for (const source of ["compact", "resume"]) assert.match(start(repoHook, c, "s1", source), /ORCHESTRATOR[\s\S]*## Verification gate/);
});

test("hook: the word must lead the first prompt", () => {
  const c = newConfig();
  for (const [id, text] of [["a", "review the orchestrator PR"], ["b", "orchestrators are overrated"], ["c", "don't use orchestrator"]]) {
    assert.equal(prompt(repoHook, c, id, text), "", text);
    assert.match(start(repoHook, c, id, "resume"), /VANILLA/, text);
  }
});

test("hook: sessions are independent; a cleared session starts vanilla", () => {
  const c = newConfig();
  prompt(repoHook, c, "A", "orchestrator go");
  start(repoHook, c, "B", "startup"); // another session in the same project
  assert.match(start(repoHook, c, "A", "compact"), /ORCHESTRATOR/, "session B must not reset session A");
  assert.match(start(repoHook, c, "C", "clear"), /VANILLA.*starts with "orchestrator"/); // /clear issues a new session_id
});

test("hook: a fork inherits its parent's mode from the transcript", () => {
  const c = newConfig();
  const dir = mkdtempSync(join(tmpdir(), "cco-t-"));
  const line = (o) => JSON.stringify(o) + "\n";
  const orch = join(dir, "orch.jsonl");
  writeFileSync(orch, line({ type: "user", message: {} }) +
    line({ attachment: { type: "hook_additional_context", content: ["SESSION MODE: ORCHESTRATOR. This replaces..."] } }));
  const quoted = join(dir, "quoted.jsonl"); // mentions the header only inside ordinary content
  writeFileSync(quoted, line({ type: "user", message: { content: "SESSION MODE: ORCHESTRATOR. in a pasted file" } }));

  // As in Claude Code, the fork's transcript is not on disk yet when the fork starts.
  const ev = (id, source, transcript_path) => ({ hook_event_name: "SessionStart", session_id: id, source, transcript_path });
  const missing = join(dir, "not-written-yet.jsonl");

  assert.equal(send(repoHook, c, ev("F1", "fork", missing)), "", "a fork injects nothing; its copied conversation carries the mode");
  assert.equal(prompt(repoHook, c, "F1", "background task finished"), "", "the next message must not decide a fork's mode");
  assert.equal(send(repoHook, c, ev("F1", "compact", missing)), "", "still undecidable: stay silent");
  assert.match(send(repoHook, c, ev("F1", "compact", orch)), /^SESSION MODE: ORCHESTRATOR[\s\S]*## Verification gate/);
  assert.match(start(repoHook, c, "F1", "resume"), /ORCHESTRATOR/, "the resolved mode is saved");

  send(repoHook, c, ev("F2", "fork", missing));
  assert.match(send(repoHook, c, ev("F2", "compact", quoted)), /^SESSION MODE: VANILLA\. Work directly[^"]*$/);
});

test("hook: resume and compact keep a session's mode file fresh", () => {
  const c = newConfig();
  prompt(repoHook, c, "old", "orchestrator");
  const file = join(c, "session-modes", "old.txt");
  const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  utimesSync(file, longAgo, longAgo);
  start(repoHook, c, "old", "resume");
  assert.ok(statSync(file).mtimeMs > Date.now() - 60000);

  utimesSync(file, longAgo, longAgo);
  start(repoHook, c, "other", "startup"); // startup prunes stale files
  assert.ok(!existsSync(file));
});

test("hook: odd input is harmless", () => {
  const c = newConfig();
  const empty = run(repoHook, [], { CLAUDE_CONFIG_DIR: c }, "");
  assert.equal(empty.code, 0);
  assert.match(empty.out, /VANILLA/);
  assert.equal(run(repoHook, [], { CLAUDE_CONFIG_DIR: c }, "not json").code, 0);
  assert.match(prompt(repoHook, c, "../../etc/x y", "orchestrator"), /ORCHESTRATOR/);
  assert.deepEqual(readdirSync(join(c, "session-modes")).filter((f) => !/^[\w-]+\.txt$/.test(f)), []);
});

test("hook: appends local rules, and falls back to file paths past the context limit", () => {
  const c = newConfig();
  const dir = join(c, "hookcopy");
  cpSync(join(repo, "hooks"), dir, { recursive: true });
  const h = join(dir, "session-mode.mjs");

  writeFileSync(join(dir, "orchestrator-protocol.local.md"), "Never use model X for packets.\n");
  assert.match(prompt(h, c, "s1", "orchestrator"), /## Local rules\n\nNever use model X/);

  writeFileSync(join(dir, "orchestrator-protocol.local.md"), "x".repeat(6000));
  const ctx = prompt(h, c, "s2", "orchestrator");
  assert.ok(ctx.length < 10000, "must stay under Claude Code's 10,000-character cap");
  assert.match(ctx, /too long to inject\. Read these files now.*orchestrator-protocol\.md.*orchestrator-protocol\.local\.md/);
});

test("install: adds both hooks once, keeps other settings, writes a manifest, is idempotent", () => {
  const c = newConfig();
  mkdirSync(c, { recursive: true });
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo other" }] }] },
  };
  writeFileSync(join(c, "settings.json"), JSON.stringify(existing));

  for (let i = 0; i < 2; i++) assert.equal(run(installer, [], { CLAUDE_CONFIG_DIR: c }).code, 0);

  const settings = JSON.parse(readFileSync(join(c, "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, existing.permissions);
  const ours = (name) => settings.hooks[name].flatMap((g) => g.hooks).filter((h) => h.command.includes("session-mode.mjs"));
  assert.equal(ours("SessionStart").length, 1);
  assert.equal(ours("UserPromptSubmit").length, 1);
  assert.ok(settings.hooks.SessionStart.some((g) => g.hooks.some((h) => h.command === "echo other")));
  assert.deepEqual(JSON.parse(readFileSync(join(c, "settings.json.bak"), "utf8")), existing, "a repeat install must not overwrite the backup");
  for (const f of agents) assert.ok(existsSync(join(c, "agents", f)), f);
  assert.ok(JSON.parse(readFileSync(join(c, "claude-code-orchestrator.json"), "utf8")).files["hooks/session-mode.mjs"]);
});

test("install: the registered command runs under bash and PowerShell", () => {
  const c = newConfig();
  assert.equal(run(installer, [], { CLAUDE_CONFIG_DIR: c }).code, 0);
  const command = JSON.parse(readFileSync(join(c, "settings.json"), "utf8")).hooks.SessionStart[0].hooks[0].command;
  const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "sh", source: "startup" });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: c };

  const shells = [];
  // On Windows, test with Git Bash only; a `bash` that resolves to WSL runs Linux, not this machine's paths.
  const uname = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8" });
  const isWslBash = process.platform === "win32" && /linux/i.test(uname.stdout || "");
  if (!uname.error && !isWslBash) shells.push(["bash", ["-c", command]]);
  if (process.platform === "win32") shells.push(["powershell", ["-NoProfile", "-NonInteractive", "-Command", command]]);
  for (const [shell, args] of shells) {
    const r = spawnSync(shell, args, { input, env, encoding: "utf8" });
    if (r.error?.code === "ENOENT") continue; // shell not installed here
    assert.equal(r.status, 0, shell + ": " + r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /VANILLA/, shell);
  }
});

test("install: updates untouched files, refuses edited ones unless --force", () => {
  const c = newConfig();
  const env = { CLAUDE_CONFIG_DIR: c };
  assert.equal(run(installer, [], env).code, 0);

  // Simulate an upgrade: an installed file that matches the manifest gets replaced silently.
  const manifestPath = join(c, "claude-code-orchestrator.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(join(c, "agents", "packet.md"), "old packet\n");
  manifest.files["agents/packet.md"] = sha256("old packet\n");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(run(installer, [], env).code, 0);
  assert.equal(readFileSync(join(c, "agents", "packet.md"), "utf8"), readFileSync(join(repo, "agents", "packet.md"), "utf8"));

  // A file the user edited is refused, and nothing is written.
  writeFileSync(join(c, "agents", "scout.md"), "my own scout\n");
  const before = readFileSync(join(c, "settings.json"), "utf8");
  const refused = run(installer, [], env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /scout\.md/);
  assert.equal(readFileSync(join(c, "agents", "scout.md"), "utf8"), "my own scout\n");
  assert.equal(readFileSync(join(c, "settings.json"), "utf8"), before);

  assert.equal(run(installer, ["--force"], env).code, 0);
  assert.notEqual(readFileSync(join(c, "agents", "scout.md"), "utf8"), "my own scout\n");
});

test("install: refuses bad settings.json before writing anything", () => {
  for (const content of ["{ not json", "null", "[]", '{"hooks": []}', '{"hooks": {"SessionStart": {}}}']) {
    const c = newConfig();
    mkdirSync(c, { recursive: true });
    writeFileSync(join(c, "settings.json"), content);
    const r = run(installer, [], { CLAUDE_CONFIG_DIR: c });
    assert.equal(r.code, 1, content);
    assert.doesNotMatch(r.err, /TypeError/, content);
    assert.equal(readFileSync(join(c, "settings.json"), "utf8"), content);
    assert.ok(!existsSync(join(c, "hooks")) && !existsSync(join(c, "agents")), "nothing copied for " + content);
  }
});

test("install: replaces an older entry for this hook, including old matchers", () => {
  const c = newConfig();
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: '"/old/node" "/old/hooks/session-mode.mjs"' }] }] },
  }));
  assert.equal(run(installer, [], { CLAUDE_CONFIG_DIR: c }).code, 0);
  const groups = JSON.parse(readFileSync(join(c, "settings.json"), "utf8")).hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, undefined);
  assert.doesNotMatch(groups[0].hooks[0].command, /\/old\//);
});

test("uninstall: removes what install added and keeps the rest", () => {
  const c = newConfig();
  mkdirSync(c, { recursive: true });
  const other = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } };
  writeFileSync(join(c, "settings.json"), JSON.stringify(other));
  const env = { CLAUDE_CONFIG_DIR: c };
  assert.equal(run(installer, [], env).code, 0);
  writeFileSync(join(c, "agents", "reviewer.md"), "edited by me\n");

  const r = run(installer, ["--uninstall"], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /kept because you changed them:[\s\S]*reviewer\.md/);
  assert.deepEqual(JSON.parse(readFileSync(join(c, "settings.json"), "utf8")), other);
  assert.ok(!existsSync(join(c, "hooks", "session-mode.mjs")));
  assert.ok(!existsSync(join(c, "agents", "scout.md")));
  assert.ok(existsSync(join(c, "agents", "reviewer.md")));
  assert.ok(!existsSync(join(c, "claude-code-orchestrator.json")));
});

test("install: refuses a damaged manifest and a config path the shell would expand", () => {
  const c = newConfig();
  assert.equal(run(installer, [], { CLAUDE_CONFIG_DIR: c }).code, 0);
  writeFileSync(join(c, "claude-code-orchestrator.json"), "null");
  const r = run(installer, [], { CLAUDE_CONFIG_DIR: c });
  assert.equal(r.code, 1);
  assert.match(r.err, /damaged/);
  assert.doesNotMatch(r.err, /TypeError/);

  const odd = join(mkdtempSync(join(tmpdir(), "cco-")), "con$fig");
  const r2 = run(installer, [], { CLAUDE_CONFIG_DIR: odd });
  assert.equal(r2.code, 1);
  assert.match(r2.err, /would expand/);
  assert.ok(!existsSync(join(odd, "hooks")));
});

test("install: writes through a symlinked settings.json", (t) => {
  const c = newConfig();
  mkdirSync(c, { recursive: true });
  const real = join(dirname(c), "dotfiles-settings.json");
  writeFileSync(real, "{}");
  try {
    symlinkSync(real, join(c, "settings.json"), "file");
  } catch {
    return t.skip("symlinks not permitted here");
  }
  assert.equal(run(installer, [], { CLAUDE_CONFIG_DIR: c }).code, 0);
  assert.ok(lstatSync(join(c, "settings.json")).isSymbolicLink());
  assert.match(readFileSync(real, "utf8"), /session-mode.mjs/);
});
