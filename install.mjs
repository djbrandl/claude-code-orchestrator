#!/usr/bin/env node
// Installs or removes claude-code-orchestrator in your Claude Code user config.
//
//   node install.mjs              install, or update an earlier install
//   node install.mjs --force      also overwrite installed files you have changed
//   node install.mjs --uninstall  remove everything this installer added
//
// Target: $CLAUDE_CONFIG_DIR, or ~/.claude when that is unset. A manifest of installed file
// hashes (claude-code-orchestrator.json) lets updates replace untouched files while refusing
// to overwrite files you have edited.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HOOK_MARKER = "session-mode.mjs";
const EVENTS = ["SessionStart", "UserPromptSubmit"];

const repoDir = dirname(fileURLToPath(import.meta.url));
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const settingsFile = join(configDir, "settings.json");
const manifestFile = join(configDir, "claude-code-orchestrator.json");
const version = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")).version;

// Installed files, as paths relative to both the repo and the config dir.
const FILES = [
  "hooks/session-mode.mjs",
  "hooks/orchestrator-protocol.md",
  ...readdirSync(join(repoDir, "agents")).filter((f) => f.endsWith(".md")).map((f) => "agents/" + f),
];

const args = process.argv.slice(2);
const unknown = args.filter((a) => !["--force", "--uninstall"].includes(a));
if (unknown.length) fail("unknown option: " + unknown.join(" "));
const force = args.includes("--force");

function fail(message) {
  console.error("error: " + message);
  process.exit(1);
}

const slash = (p) => p.replace(/\\/g, "/");
const hashOf = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
const isOurs = (h) => [h?.command, ...(Array.isArray(h?.args) ? h.args : [])]
  .some((part) => typeof part === "string" && part.includes(HOOK_MARKER));

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path + " is not valid JSON (" + err.message + "); fix it and run again");
  }
}

// Writes via a temp file and rename, following a symlinked file (e.g. dotfiles) to its target.
function writeJsonAtomic(path, value) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = target + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, target);
}

function readManifest() {
  const manifest = readJson(manifestFile, { files: {} });
  const ok = manifest && typeof manifest === "object" && manifest.files && typeof manifest.files === "object";
  if (!ok) fail(manifestFile + " is damaged; delete it and run again with --force");
  return manifest;
}

function readSettings() {
  const settings = readJson(settingsFile, {});
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    fail(settingsFile + " must contain a JSON object");
  }
  if (settings.hooks !== undefined && (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    fail(settingsFile + ': "hooks" must be an object');
  }
  for (const name of EVENTS) {
    const groups = settings.hooks?.[name];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some((g) => !g || typeof g !== "object" || (g.hooks !== undefined && !Array.isArray(g.hooks)))) {
      fail(settingsFile + ': "hooks.' + name + '" is not in the expected format (an array of {matcher, hooks: [...]})');
    }
  }
  return settings;
}

// Removes this package's hook entries; returns how many were removed.
function removeOurHooks(settings) {
  let removed = 0;
  for (const name of EVENTS) {
    const groups = settings.hooks?.[name];
    if (!groups) continue;
    for (const g of groups) {
      const before = (g.hooks ?? []).length;
      g.hooks = (g.hooks ?? []).filter((h) => !isOurs(h));
      removed += before - g.hooks.length;
    }
    settings.hooks[name] = groups.filter((g) => g.hooks.length);
    if (!settings.hooks[name].length) delete settings.hooks[name];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

// Writes settings only when they changed, backing up the previous version first.
function saveSettings(original, settings) {
  if (JSON.stringify(settings) === original) return false;
  if (existsSync(settingsFile)) copyFileSync(settingsFile, settingsFile + ".bak");
  writeJsonAtomic(settingsFile, settings);
  return true;
}

function install() {
  // Validate everything before writing anything.
  const hadSettingsFile = existsSync(settingsFile);
  const settings = readSettings();
  const original = JSON.stringify(settings);
  const manifest = readManifest();
  const hookPath = slash(join(configDir, "hooks", "session-mode.mjs"));
  if (/[$`"]/.test(hookPath)) {
    fail("the config path " + hookPath + " contains $, ` or \", which hook shells would expand; set CLAUDE_CONFIG_DIR to a plain path");
  }
  const plan = FILES.map((rel) => {
    const src = join(repoDir, rel);
    const dest = join(configDir, rel);
    const current = hashOf(dest);
    const incoming = hashOf(src);
    let action = "copy";
    if (current === incoming) action = "same";
    else if (current && current !== manifest.files?.[rel]) action = "changed";
    return { rel, src, dest, incoming, action };
  });
  const changed = plan.filter((p) => p.action === "changed");
  if (changed.length && !force) {
    fail(
      "these files exist and differ from what this installer put there:\n  " +
      changed.map((p) => slash(p.dest)).join("\n  ") +
      "\nMove your versions aside, or run with --force to replace them." +
      "\n(Personal protocol rules belong in hooks/orchestrator-protocol.local.md, which is never touched.)"
    );
  }

  for (const p of plan) {
    if (p.action === "same") continue;
    mkdirSync(dirname(p.dest), { recursive: true });
    copyFileSync(p.src, p.dest);
  }

  const hadHooks = removeOurHooks(settings) > 0;
  const command = `node "${hookPath}"`;
  settings.hooks ??= {};
  for (const name of EVENTS) {
    (settings.hooks[name] ??= []).push({ hooks: [{ type: "command", command }] });
  }
  const wroteSettings = saveSettings(original, settings);
  writeJsonAtomic(manifestFile, {
    package: "claude-code-orchestrator",
    version,
    files: Object.fromEntries(plan.map((p) => [p.rel, p.incoming])),
  });

  const updated = plan.filter((p) => p.action !== "same").length;
  console.log(`claude-code-orchestrator ${version} installed into ${slash(configDir)}`);
  console.log(`  files: ${updated} written, ${plan.length - updated} already current`);
  const backupNote = hadSettingsFile ? " (previous version saved as settings.json.bak)" : " (new file)";
  console.log("  settings.json: " + (!wroteSettings ? "hooks already current" : `hooks ${hadHooks ? "updated" : "added"}${backupNote}`));
  const nodeCheck = spawnSync("node", ["--version"], { encoding: "utf8" });
  if (nodeCheck.status !== 0) {
    console.log("warning: `node` is not on this shell's PATH. The hooks run `node`, so make sure Claude Code's environment can find it.");
  }
  console.log('Start a new Claude Code session. Begin your first message with "orchestrator" to use orchestrator mode.');
}

function uninstall() {
  const settings = readSettings();
  const original = JSON.stringify(settings);
  const manifest = readManifest();

  const removedHooks = removeOurHooks(settings);
  if (removedHooks) saveSettings(original, settings);

  const kept = [];
  for (const rel of FILES) {
    const dest = join(configDir, rel);
    const current = hashOf(dest);
    if (!current) continue;
    if (current === manifest.files?.[rel] || current === hashOf(join(repoDir, rel))) unlinkSync(dest);
    else kept.push(slash(dest));
  }
  if (existsSync(manifestFile)) unlinkSync(manifestFile);

  console.log("claude-code-orchestrator uninstalled from " + slash(configDir));
  console.log("  settings.json: " + (removedHooks ? "hooks removed (previous version saved as settings.json.bak)" : "no hooks found"));
  if (kept.length) console.log("  kept because you changed them:\n    " + kept.join("\n    "));
  console.log("  left in place: hooks/orchestrator-protocol.local.md (if any) and session-modes/");
}

if (args.includes("--uninstall")) uninstall();
else install();
