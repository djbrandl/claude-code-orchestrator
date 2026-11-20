#!/usr/bin/env node
// Claude Code hook for the vanilla/orchestrator session modes. Registered for two events:
//
//   UserPromptSubmit  The first prompt of a session decides its mode: a prompt that starts
//                     with the word "orchestrator" switches to orchestrator mode and injects
//                     the protocol; anything else fixes the session as vanilla.
//   SessionStart      startup, clear: a new session; announce vanilla (the default).
//                     fork: a new session whose copied conversation already carries the
//                     parent's mode. Mark it "inherit" and inject nothing; the copy is not on
//                     disk yet, so the mode is read from it at the first resume or compaction.
//                     resume, compact: re-inject the session's saved mode.
//
// Modes are saved per session as <config>/session-modes/<session_id>.txt, where <config> is
// $CLAUDE_CONFIG_DIR or ~/.claude. Files unused for 30 days are pruned at startup.
//
// The protocol is orchestrator-protocol.md from this folder, followed by
// orchestrator-protocol.local.md when present (personal rules the installer never touches).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const TRIGGER = /^\s*orchestrator\b/i;
const ORCHESTRATOR_HEADER = "SESSION MODE: ORCHESTRATOR.";
const CONTEXT_LIMIT = 9500; // Claude Code caps hook context at 10,000 characters.
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const VANILLA = "SESSION MODE: VANILLA. Work directly; delegate only read-heavy or search-heavy tasks.";

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const modesDir = join(configDir, "session-modes");
const hookDir = dirname(fileURLToPath(import.meta.url));
const protocolFile = join(hookDir, "orchestrator-protocol.md");
const localProtocolFile = join(hookDir, "orchestrator-protocol.local.md");

let event = {};
try {
  event = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // No or malformed input: nothing to act on.
}

const sessionId = String(event.session_id || "");
const modeFile = sessionId
  ? join(modesDir, (/^[\w-]{1,128}$/.test(sessionId) ? sessionId : sha(sessionId)) + ".txt")
  : null;

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function savedMode() {
  try {
    return readFileSync(modeFile, "utf8").trim();
  } catch {
    return "";
  }
}

function saveMode(mode) {
  mkdirSync(modesDir, { recursive: true });
  writeFileSync(modeFile, mode + "\n");
}

function orchestratorContext() {
  const header = ORCHESTRATOR_HEADER + " This replaces any vanilla-mode instruction. Follow this protocol for the whole session.\n\n";
  let protocol = readFileSync(protocolFile, "utf8");
  if (existsSync(localProtocolFile)) {
    protocol += "\n\n## Local rules\n\n" + readFileSync(localProtocolFile, "utf8");
  }
  if (header.length + protocol.length <= CONTEXT_LIMIT) return header + protocol;
  const files = [protocolFile, existsSync(localProtocolFile) ? localProtocolFile : null]
    .filter(Boolean)
    .map((f) => f.replace(/\\/g, "/"));
  return header + "The protocol is too long to inject. Read these files now and follow them: " + files.join(", ");
}

// Reads a forked session's mode from its transcript: orchestrator if this hook injected the
// protocol into the conversation, otherwise vanilla. "" while the transcript is unreadable.
function modeFromTranscript(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split("\n")) {
    if (!line.includes(ORCHESTRATOR_HEADER)) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const a = entry.attachment;
    if (a?.type === "hook_additional_context" && [].concat(a.content).some((c) => String(c).startsWith(ORCHESTRATOR_HEADER))) {
      return "orchestrator";
    }
  }
  return "vanilla";
}

function pruneOldModes() {
  try {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const f of readdirSync(modesDir)) {
      const p = join(modesDir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    // Pruning is best effort.
  }
}

function emit(eventName, context) {
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: context },
  }));
}

function onUserPromptSubmit() {
  if (!modeFile || savedMode()) return; // only the first prompt of a session decides
  const mode = TRIGGER.test(String(event.prompt || "")) ? "orchestrator" : "vanilla";
  saveMode(mode);
  if (mode === "orchestrator") emit("UserPromptSubmit", orchestratorContext());
}

function onSessionStart() {
  const source = event.source || "startup";
  if (source === "startup") pruneOldModes();
  let mode = modeFile ? savedMode() : "";

  if (modeFile && source === "fork" && !mode) {
    saveMode("inherit");
    return;
  }
  if (mode === "inherit") {
    mode = modeFromTranscript(event.transcript_path);
    if (!mode) return; // still unreadable; the copied conversation keeps carrying the mode
    saveMode(mode);
  }
  if (mode && (source === "resume" || source === "compact")) {
    const now = new Date();
    try { utimesSync(modeFile, now, now); } catch {} // keep active sessions out of the prune
  }

  if (mode === "orchestrator") {
    emit("SessionStart", orchestratorContext());
  } else {
    emit("SessionStart", VANILLA + (mode ? "" : ' If the user\'s first message starts with "orchestrator", the orchestrator protocol will follow it and replaces this.'));
  }
}

if (event.hook_event_name === "UserPromptSubmit") onUserPromptSubmit();
else if (event.hook_event_name === "SessionStart" || !event.hook_event_name) onSessionStart();
