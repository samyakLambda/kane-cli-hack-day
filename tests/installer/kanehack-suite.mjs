#!/usr/bin/env node
// End-to-end checks for every kanehack command, run the way an AI agent runs them:
// no TTY, empty stdin, --json, asserting exit codes and JSON. Cross-platform (Node only).
//
//   KANEHACK_API=http://localhost:3300 APPROVE=real:ana@demo.test:demo-pass-1234 node tests/installer/kanehack-suite.mjs
//   KANEHACK_API=http://localhost:3399 APPROVE=mock node tests/installer/kanehack-suite.mjs
//
// Optional: KANEHACK_ENTRY=<path to kanehack.mjs> (default: the installed one in the test HOME
// if TEST_HOME is given and it exists, else packages/kanehack/bin/kanehack.mjs), TEST_HOME
// (a throwaway HOME to use; default a new temp dir, deleted afterwards).
// A fake kane-cli (tests/installer/fake-kane-cli.mjs) is put first on PATH.
// It never touches your real HOME.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexGet, codexMcpStatus, codexSkills, runHelperLikeCodex } from "./codex-probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const WIN = process.platform === "win32";
const API = (process.env.KANEHACK_API ?? "").replace(/\/$/, "");
const APPROVE = process.env.APPROVE ?? "mock";
if (!API) {
  console.error("Set KANEHACK_API to the server under test.");
  process.exit(2);
}
const ownHome = !process.env.TEST_HOME;
const HOME = process.env.TEST_HOME ?? mkdtempSync(join(tmpdir(), "kanehack-suite-"));
const installed = join(HOME, ".kanehack/cli/node_modules/kanehack/bin/kanehack.mjs");
const ENTRY = process.env.KANEHACK_ENTRY ?? (process.env.TEST_HOME && existsSync(installed) ? installed : join(repo, "packages/kanehack/bin/kanehack.mjs"));

// Fake kane-cli first on PATH.
const fakeBin = join(HOME, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
copyFileSync(join(here, "fake-kane-cli.mjs"), join(fakeBin, "fake-kane-cli.mjs"));
if (WIN) writeFileSync(join(fakeBin, "kane-cli.cmd"), `@echo off\r\nnode "%~dp0fake-kane-cli.mjs" %*\r\n`);
else {
  writeFileSync(join(fakeBin, "kane-cli"), `#!/bin/sh\nexec node "${join(fakeBin, "fake-kane-cli.mjs")}" "$@"\n`);
  chmodSync(join(fakeBin, "kane-cli"), 0o755);
}
const PATHKEY = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const VERSION = JSON.parse(readFileSync(join(repo, "packages/kanehack/package.json"), "utf8")).version;
// CODEX_BIN_DIR: where CI installed the real @openai/codex (kept off the default PATH so it
// doesn't change the installer tests). Without it the Codex-binary checks are skipped.
const codexDir = process.env.CODEX_BIN_DIR ?? "";
const baseEnv = { ...process.env, HOME, USERPROFILE: HOME, KANEHACK_API: API, [PATHKEY]: [fakeBin, codexDir, process.env[PATHKEY]].filter(Boolean).join(WIN ? ";" : ":"), NO_COLOR: "1" };
for (const k of ["KANEHACK_TOKEN", "CODEX_HOME"]) delete baseEnv[k];
// A git repo for the commit sha in reports.
const work = join(HOME, "work");
mkdirSync(work, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: work });
spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: work });

let failures = 0;
let n = 0;
function check(name, cond, detail = "") {
  n++;
  if (cond) console.log(`ok ${n} - ${name}`);
  else {
    failures++;
    console.log(`not ok ${n} - ${name}${detail ? `\n  # ${String(detail).split("\n").join("\n  # ")}` : ""}`);
  }
}

/** Run kanehack like an agent's Bash tool does: no TTY, empty stdin. */
function kh(argv, env = {}) {
  const r = spawnSync(process.execPath, [ENTRY, ...argv], { cwd: work, env: { ...baseEnv, ...env }, encoding: "utf8", input: "", timeout: 150_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", json, show: `exit=${r.status}\nstdout: ${(r.stdout ?? "").slice(0, 1500)}\nstderr: ${(r.stderr ?? "").slice(0, 1500)}` };
}
const lastLine = (s) => {
  const lines = s.trim().split(/\r?\n/);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
};

async function approve(code, decision = "approve") {
  if (APPROVE === "mock") {
    const r = await fetch(`${API}/__mock/${decision}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_code: code }) });
    return r.ok;
  }
  const [, email, password] = APPROVE.split(":");
  const r = spawnSync(process.execPath, [join(here, "approve-pair.mjs"), API, email, password, code, decision], { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) console.log(`  # approve-pair: ${r.stdout}${r.stderr}`);
  return r.status === 0;
}

const objective = `Open the site & find the "schedule" page`;
console.log(`# kanehack suite: ${ENTRY}\n# server ${API} (${APPROVE === "mock" ? "mock" : "real app"}), HOME ${HOME}, ${process.platform} node ${process.version}`);

try {
  // ── basics, unpaired ──
  let r = kh(["version"]);
  check(`version prints ${VERSION}`, r.code === 0 && r.out.trim() === VERSION, r.show);
  r = kh(["--json", "version"]);
  check("version --json", r.code === 0 && r.json?.version === VERSION, r.show);
  r = kh(["--help"]);
  check("--help lists pair --start/--wait and exit codes", r.code === 0 && r.out.includes("pair --start") && r.out.includes("Exit codes"), r.show);
  r = kh(["nope", "--json"]);
  check("unknown command exits 2 with USAGE", r.code === 2 && r.json?.error?.code === "USAGE", r.show);
  r = kh(["doctor", "--json"]);
  const api0 = r.json?.checks?.find((c) => c.id === "api");
  check("doctor --json (unpaired): parseable, api reachable-not-paired", [0, 1].includes(r.code) && api0?.status === "warn" && /not paired/.test(api0?.detail ?? ""), r.show);
  check("doctor --json: fake kane-cli found and authed", r.json?.checks?.find((c) => c.id === "kane_cli")?.status === "pass" && r.json?.checks?.find((c) => c.id === "kane_auth")?.status === "pass", r.show);
  {
    const old = kh(["doctor", "--json"], { FAKE_KANE_VERSION: "kane-cli 0.9.0" });
    const kc = old.json?.checks?.find((c) => c.id === "kane_cli");
    check("doctor: Kane CLI older than the release candidate → warn with npm install -g @testmuai/kane-cli@rc", kc?.status === "warn" && kc?.fix === "npm install -g @testmuai/kane-cli@rc", old.show);
  }
  check("doctor: no ANSI colors when not a TTY", !/\x1b\[/.test(r.out + r.err), r.show);
  r = kh(["doctor"]);
  check("doctor (text): plain lines on stderr", r.err.includes("node") && !/\x1b\[/.test(r.err), r.show);
  r = kh(["status", "--json"]);
  check("status unpaired → exit 2 NOT_PAIRED", r.code === 2 && r.json?.error?.code === "NOT_PAIRED", r.show);
  r = kh(["pair", "--wait", "--json"]);
  check("pair --wait with nothing pending → exit 2", r.code === 2 && r.json?.error?.code === "NO_PENDING_PAIRING", r.show);
  r = kh(["pair", "--token", "nonsense", "--json"]);
  check("pair --token with a malformed token → exit 2", r.code === 2, r.show);
  r = kh(["pair", "--token", "khk_" + "x".repeat(32), "--json"]);
  check("pair --token with an unknown token → exit 2 UNAUTHENTICATED", r.code === 2 && r.json?.error?.code === "UNAUTHENTICATED", r.show);

  // ── no-browser sign-in: password, register, signin, claim (mock server only) ──
  if (APPROVE === "mock") {
    const creds = join(HOME, ".kanehack/credentials.json");
    const PW = "suite-pass-1234";
    r = kh(["password", "--json"]);
    check("password without a terminal → exit 2 NEEDS_TERMINAL (never asked for in an agent)", r.code === 2 && r.json?.error?.code === "NEEDS_TERMINAL" && /own terminal/.test(r.err), r.show);
    r = kh(["password", "--check", "--json"]);
    check("password --check with none saved → exit 2", r.code === 2 && r.json?.stored?.password === false, r.show);
    r = kh(["register", "--name", "Suite Person", "--email", "suite@demo.test", "--linkedin", "suite-person", "--x", "@suiteperson", "--json"]);
    check("register with no saved password → exit 2 NO_PASSWORD, pointing at kanehack password", r.code === 2 && r.json?.error?.code === "NO_PASSWORD" && /kanehack password/.test(r.err), r.show);
    r = kh(["claim", "--json"]);
    check("claim before signing in → exit 2 NOT_SIGNED_IN", r.code === 2 && r.json?.error?.code === "NOT_SIGNED_IN", r.show);
    // What `kanehack password` writes after the hidden prompt (the prompt itself needs a TTY: interactive.py).
    mkdirSync(join(HOME, ".kanehack"), { recursive: true });
    writeFileSync(creds, JSON.stringify({ password: PW }), { mode: 0o600 });
    r = kh(["password", "--check", "--json"]);
    check("password --check with one saved → exit 0", r.code === 0 && r.json?.stored?.password === true, r.show);
    r = kh(["register", "--name", "Suite Person", "--json"]);
    check("register with missing fields → exit 2 USAGE naming them", r.code === 2 && r.json?.error?.code === "USAGE" && /--email/.test(r.err), r.show);
    r = kh(["register", "--name", "Suite Person", "--email", "suite@demo.test", "--linkedin", "suite-person", "--x", "@suiteperson", "--json"]);
    check("register → exit 0, signed in, no browser", r.code === 0 && r.json?.status === "registered" && r.json?.signed_in === true, r.show);
    check("register never prints the token or the password", !/khk_/.test(r.out + r.err) && !r.out.includes(PW) && !r.err.includes(PW), r.show);
    const cfgPath = join(HOME, ".kanehack/config.json");
    const cfgAfter = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
    check("register saved the token and email in config.json", /^khk_/.test(cfgAfter.token ?? "") && cfgAfter.email === "suite@demo.test");
    r = kh(["claim", "--json"]);
    check("claim → exit 0 outcome claimed", r.code === 0 && r.json?.outcome === "claimed", r.show);
    check("claim never prints the password", !r.out.includes(PW) && !r.err.includes(PW), r.show);
    writeFileSync(creds, JSON.stringify({ password: "not-the-password-1" }), { mode: 0o600 });
    r = kh(["signin", "--json"]);
    check("signin with the wrong saved password → exit 2 WRONG_PASSWORD", r.code === 2 && r.json?.error?.code === "WRONG_PASSWORD", r.show);
    r = kh(["register", "--name", "Suite Person", "--email", "suite@demo.test", "--linkedin", "suite-person", "--x", "@suiteperson", "--json"]);
    check("register an existing email with another password → exit 2, suggests signin", r.code === 2 && /kanehack signin --email suite@demo\.test/.test(r.err), r.show);
    writeFileSync(creds, JSON.stringify({ password: PW, testmu_password: "testmu-other-pass" }), { mode: 0o600 });
    r = kh(["signin", "--json"]);
    check("signin (email from config) → exit 0 signed_in", r.code === 0 && r.json?.status === "signed_in" && !/khk_/.test(r.out + r.err), r.show);
    r = kh(["claim", "--json"]);
    check("claim uses the separate TestMu AI password when one is saved", r.code === 2 && r.json?.outcome === "error", r.show);
    r = kh(["password", "--forget", "--testmu", "--json"]);
    const left = existsSync(creds) ? JSON.parse(readFileSync(creds, "utf8")) : {};
    check("password --forget --testmu keeps the main password", r.code === 0 && left.password === PW && !("testmu_password" in left), r.show);
    r = kh(["password", "--forget", "--json"]);
    check("password --forget removes the file", r.code === 0 && !existsSync(creds), r.show);
  }

  // ── pairing, agent style ──
  r = kh(["pair", "--start", "--json"]);
  const start = r.json;
  check("pair --start --json → exit 0 with code + URL", r.code === 0 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(start?.user_code ?? "") && /\/pair\?code=/.test(start?.verification_url ?? ""), r.show);
  check("pair --start doesn't print the device code", !/khp_/.test(r.out + r.err), r.show);
  const pending = join(HOME, ".kanehack/pending-pair.json");
  check("pending pairing saved", existsSync(pending));
  if (!WIN && existsSync(pending)) check("pending pairing file is mode 600", (statSync(pending).mode & 0o777) === 0o600, (statSync(pending).mode & 0o777).toString(8));
  r = kh(["pair", "--wait", "--timeout", "0", "--json"]);
  check("pair --wait before approval → exit 4 pending", r.code === 4 && r.json?.status === "pending" && r.json?.next === "kanehack pair --wait", r.show);
  check("approve the code (" + (APPROVE === "mock" ? "mock control" : "real /passport/login + /pair forms") + ")", await approve(start?.user_code));
  r = kh(["pair", "--wait", "--timeout", "60", "--json"]);
  check("pair --wait after approval → exit 0 paired", r.code === 0 && r.json?.status === "paired", r.show);
  check("token never printed to an agent", !/khk_/.test(r.out + r.err), r.show);
  const cfgFile = join(HOME, ".kanehack/config.json");
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
  check("config.json has the token and api", /^khk_/.test(cfg.token ?? "") && cfg.api === API, JSON.stringify({ ...cfg, token: cfg.token ? "khk_…" : null }));
  if (!WIN && existsSync(cfgFile)) check("config.json is mode 600", (statSync(cfgFile).mode & 0o777) === 0o600);
  check("pending pairing cleared", !existsSync(pending));
  r = kh(["token"]);
  check("token prints the saved token on stdout", r.code === 0 && r.out.trim() === cfg.token, r.code);

  // ── agents: kanehack mcp-headers + connect codex (an isolated CODEX_HOME per case) ──
  r = kh(["mcp-headers"]);
  check("mcp-headers (paired): one JSON object with the bearer header, nothing else", r.code === 0 && r.json?.Authorization === `Bearer ${cfg.token}` && Object.keys(r.json ?? {}).length === 1, r.code);
  const emptyHome = join(HOME, "unpaired-home");
  mkdirSync(emptyHome, { recursive: true });
  r = kh(["mcp-headers"], { HOME: emptyHome, USERPROFILE: emptyHome });
  check("mcp-headers (unpaired): exit 2, nothing on stdout, says kanehack pair on stderr", r.code === 2 && r.out === "" && r.err.includes("kanehack pair"), r.show);
  const codexCase = (name, toml) => {
    const d = join(HOME, `codex-${name}`);
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    if (toml !== undefined) writeFileSync(join(d, "config.toml"), toml);
    return d;
  };
  const toml = (d) => readFileSync(join(d, "config.toml"), "utf8");
  const baks = (d) => readdirSync(d).filter((f) => f.endsWith(".bak")).length;
  const mcpUrl = `${API}/mcp`;
  let cx = codexCase("absent");
  r = kh(["connect", "codex", "--check", "--json"], { CODEX_HOME: cx });
  check("connect codex --check with no config → exit 1 absent", r.code === 1 && r.json?.state === "absent", r.show);
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  check("connect codex with no config.toml → added, no backup", r.code === 0 && r.json?.state === "added" && r.json?.backup === null && toml(cx).includes(`url = "${mcpUrl}"`), r.show);
  cx = codexCase("existing", '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n');
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  let t = toml(cx);
  check("connect codex next to other servers → added, backup made, others kept", r.code === 0 && r.json?.state === "added" && baks(cx) === 1 && t.startsWith('# my settings\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n') && t.includes("[mcp_servers.kane-hack-event]"), r.show + "\n" + t);
  check("codex config: url + http_headers_helper (kanehack mcp-headers), no token", t.includes(`url = "${mcpUrl}"`) && /http_headers_helper = ".*kanehack.*mcp-headers"/.test(t) && !t.includes(cfg.token) && !/khk_/.test(t), t);
  const helperLine = t.split(/\r?\n/).find((l) => l.startsWith("http_headers_helper"));
  const helper = JSON.parse(helperLine.slice(helperLine.indexOf("=") + 1).trim());
  r = { ...runHelperLikeCodex(helper, baseEnv) };
  check(`the helper runs the way Codex runs it (${WIN ? "cmd /Q /D /C" : "sh -c"}, PATH + home only) → the bearer header`, r.code === 0 && r.json?.Authorization === `Bearer ${cfg.token}`, `exit=${r.code} stderr=${r.stderr.slice(0, 500)} helper=${helper}`);
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  check("connect codex again → current, file and backups unchanged (idempotent)", r.code === 0 && r.json?.state === "current" && toml(cx) === t && baks(cx) === 1, r.show);
  r = kh(["connect", "codex", "--check", "--json"], { CODEX_HOME: cx });
  check("connect codex --check → exit 0", r.code === 0 && r.json?.state === "current", r.show);
  r = kh(["doctor", "--json"], { CODEX_HOME: cx });
  check("doctor --json: codex_mcp pass for that config", r.json?.checks?.find((c) => c.id === "codex_mcp")?.status === "pass", r.show);
  const theirs = '[mcp_servers.kane-hack-event]\nurl = "https://example.com/mcp"\n';
  cx = codexCase("different", theirs);
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  check("a different server named kane-hack-event → exit 2 MCP_NAME_TAKEN, untouched, no backup", r.code === 2 && r.json?.error?.code === "MCP_NAME_TAKEN" && toml(cx) === theirs && baks(cx) === 0, r.show);
  r = kh(["doctor", "--json"], { CODEX_HOME: cx });
  check("doctor: codex_mcp warns with the remove-then-connect fix", /codex mcp remove kane-hack-event/.test(r.json?.checks?.find((c) => c.id === "codex_mcp")?.fix ?? ""), r.show);
  cx = codexCase("inline", '[mcp_servers]\nkane-hack-event = { url = "https://example.com/mcp" }\n');
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  check("kane-hack-event in an inline table → left alone (exit 2)", r.code === 2 && r.json?.state === "unrecognized", r.show);
  cx = codexCase("old", 'model = "x"\r\n\r\n[mcp_servers.kane-hack-event]\r\nurl = "https://www.kaneclihack.sh/mcp"\r\nbearer_token_env_var = "KANEHACK_TOKEN"\r\ntool_timeout_sec = 120\r\n\r\n[mcp_servers.kane-hack-event.tools.x]\r\napproval_mode = "approve"\r\n');
  r = kh(["connect", "codex", "--json"], { CODEX_HOME: cx });
  t = toml(cx);
  check("old env-var setup (CRLF) → updated: helper added, env var dropped, own keys + subtable + CRLF kept", r.code === 0 && r.json?.state === "updated" && t.includes("http_headers_helper") && !t.includes("bearer_token_env_var") && t.includes("tool_timeout_sec = 120\r\n") && t.includes("[mcp_servers.kane-hack-event.tools.x]") && !/[^\r]\n/.test(t), t);
  r = kh(["report"]);
  check("report with no command prints a copy-paste example", r.code === 2 && r.err.includes('Example: kanehack report -- kane-cli run "Open https://kaneclihack.sh and find the schedule" --agent'), r.show);

  // ── the real Codex binary (CI installs @openai/codex into CODEX_BIN_DIR) ──
  const codexEnv = { ...baseEnv, CODEX_HOME: join(HOME, ".codex") };
  const hasCodex = spawnSync("codex", ["--version"], { env: codexEnv, encoding: "utf8", shell: WIN }).status === 0;
  if (!hasCodex) console.log("# skip: codex isn't on PATH (set CODEX_BIN_DIR), real-Codex checks not run");
  else {
    rmSync(codexEnv.CODEX_HOME, { recursive: true, force: true });
    r = kh(["connect", "codex", "--json"], { CODEX_HOME: codexEnv.CODEX_HOME });
    check("connect codex with codex on PATH → added and verified with codex mcp get", r.code === 0 && r.json?.verified_with_codex === true && /codex/.test(r.json?.codex_cli ?? ""), r.show);
    const g = codexGet(codexEnv);
    check("codex mcp get kane-hack-event --json: streamable_http, our url, helper set, no bearer env var", g.code === 0 && g.json?.transport?.type === "streamable_http" && g.json?.transport?.url === mcpUrl && Boolean(g.json?.transport?.http_headers_helper) && g.json?.transport?.bearer_token_env_var === null, g.out);
    // Skills: Codex reads ~/.agents/skills. Installed there by the installer (TEST_HOME) or copied here.
    // On Windows Codex finds ~ through the OS profile folder, not USERPROFILE: in CI (a throwaway runner)
    // the skills are copied under the real profile for this one check and removed again.
    const agentsSkills = join(WIN ? process.env.USERPROFILE : HOME, ".agents/skills");
    const copied = [];
    if (!WIN || process.env.CI)
      for (const d of readdirSync(join(repo, "plugin/skills"))) {
        if (existsSync(join(agentsSkills, d))) continue;
        cpSync(join(repo, "plugin/skills", d), join(agentsSkills, d), { recursive: true });
        if (WIN) copied.push(join(agentsSkills, d));
      }
    const sk = codexSkills(codexEnv, work);
    for (const c of copied) rmSync(c, { recursive: true, force: true });
    const names = Object.keys(sk.hack);
    check("codex debug prompt-input lists the hack-os and hack-gtm skills once each", sk.code === 0 && names.sort().join() === "hack-gtm,hack-os" && sk.hack["hack-os"] === 1 && sk.hack["hack-gtm"] === 1, JSON.stringify(sk));
    const st = await codexMcpStatus(codexEnv);
    check("codex app-server: kane-hack-event connects through the helper and lists the event tools", !st.error && st.toolsError === null && st.tools.length > 0 && (APPROVE !== "mock" || st.tools.includes("readiness_report")), JSON.stringify(st).slice(0, 1500));
    if (APPROVE === "mock") {
      const seen = await (await fetch(`${API}/__mock/mcp`)).json();
      check("the mock saw Codex's MCP requests with a valid bearer (initialize, tools/list)", seen.methods.includes("initialize") && seen.methods.includes("tools/list"), JSON.stringify(seen));
    }
    r = kh(["doctor", "--json"], { CODEX_HOME: codexEnv.CODEX_HOME });
    const dc = (id) => r.json?.checks?.find((c) => c.id === id)?.status;
    check("doctor with Codex: codex, codex_skills, codex_mcp all pass", dc("codex") === "pass" && dc("codex_skills") === "pass" && dc("codex_mcp") === "pass", r.show);
  }

  // A second machine pairs with the plain interactive-style command and is denied.
  r = kh(["pair", "--start", "--json"]);
  const denied = r.json?.user_code;
  await approve(denied, "deny");
  r = kh(["pair", "--wait", "--timeout", "30", "--json"]);
  check("denied code → exit 1 PAIR_EXPIRED, token kept", r.code === 1 && r.json?.error?.code === "PAIR_EXPIRED" && JSON.parse(readFileSync(cfgFile, "utf8")).token === cfg.token, r.show);

  // ── paired commands ──
  r = kh(["doctor", "--json"]);
  check("doctor --json (paired): api pass", r.json?.checks?.find((c) => c.id === "api")?.status === "pass" && r.json?.paired === true, r.show);
  r = kh(["doctor", "--report", "--json"]);
  check("doctor --report --json: readiness envelope included", r.json?.readiness && r.json.readiness.status !== "error", r.show);
  r = kh(["status", "--json"]);
  check("status --json → exit 0 with runs[]", r.code === 0 && Array.isArray(r.json?.runs), r.show);
  const before = r.json?.runs?.length ?? 0;
  r = kh(["status"]);
  check("status (text) → exit 0", r.code === 0, r.show);
  r = kh(["consent", "status", "--json"]);
  check("consent status: undecided", r.code === 0 && r.json?.consent === null, r.show);
  r = kh(["report", "--json", "--", "kane-cli", "run", objective, "--agent"]);
  check("report without consent (no TTY): Kane exit 0, nothing sent", r.code === 0 && lastLine(r.out)?.reason === "consent_needed", r.show);
  check("report passes Kane's NDJSON through on stdout", r.out.includes('"type":"run_end"'), r.show);
  r = kh(["consent", "yes", "--json"]);
  check("consent yes --json", r.code === 0 && r.json?.consent === true, r.show);

  r = kh(["report", "--json", "--", "kane-cli", "run", objective, "--agent"]);
  let s = lastLine(r.out);
  check("report (passing run) → exit 0, reported, source verified", r.code === 0 && s?.type === "kanehack_report" && s?.reported === true && s?.status === "passed" && s?.source_verified === true, r.show);
  const runId = s?.run_id;
  check("report: argument with spaces, & and quotes reached kane-cli intact", r.out.includes(JSON.stringify(objective)), r.out.slice(0, 400));
  r = kh(["report", "--json", "--", "kane-cli", "run", "Check the login form rejects a bad password", "--agent"], { FAKE_KANE_EXIT: "1" });
  s = lastLine(r.out);
  check("report (failing run) → exit 1, recorded as failed", r.code === 1 && s?.reported === true && s?.status === "failed", r.show);
  r = kh(["report", "--json", "--", "kane-cli", "run", "Nothing finishes", "--agent"], { FAKE_KANE_EXIT: "0", FAKE_KANE_NO_END: "1" });
  s = lastLine(r.out);
  check("report (exit 0 but no completion event) → not a pass", r.code === 0 && s?.completion_event === null && s?.status !== "passed", r.show);
  r = kh(["report", "--json", "--", "definitely-not-a-command-kh"]);
  check("report with a missing command → exit 127", r.code === 127, r.show);
  r = kh(["report", "--json"]);
  check("report with no command → exit 2", r.code === 2, r.show);
  r = kh(["report", "--no-upload", "--json", "--", "kane-cli", "run", "local only", "--agent"]);
  check("report --no-upload → not sent", r.code === 0 && lastLine(r.out)?.reason === "no_upload", r.show);

  r = kh(["status", "--json"]);
  const mine = r.json?.runs?.find((x) => x.id === runId);
  check("status shows the reported runs", r.code === 0 && (r.json?.runs?.length ?? 0) >= Math.min(before + 3, 10) && Boolean(mine), r.show);
  check("the run's objective survived intact on the server", mine?.objective === objective, JSON.stringify(mine?.objective));

  r = kh(["help", "--json", "Kane can't find Chrome on my laptop after an update", "--category", "kane_cli"]);
  // The ticket code (H-0042) is data.id; data.ticket_id is the numeric row id (src/server/mcp-adapters.ts).
  const ticket = r.json?.data?.id;
  check("help \"…\" --json → ticket H-…", r.code === 0 && r.json?.ok === true && /^H-\d+$/.test(String(ticket)), r.show);
  r = kh(["help", "--status", String(ticket), "--json"]);
  check("help --status <id> --json → exit 0", r.code === 0 && r.json?.ok === true, r.show);
  r = kh(["help", "--status", "not a ticket", "--json"]);
  check("help --status with a malformed id → exit 2 (checked locally)", r.code === 2 && r.json?.error?.code === "USAGE", r.show);
  r = kh(["help", "x", "--json"]);
  check("help with too short a summary → exit 2", r.code === 2, r.show);
  r = kh(["submit", "--preflight", "--json"]);
  check("submit --preflight --json → exit 0 if ready else 1, data.ready boolean", typeof r.json?.data?.ready === "boolean" && r.code === (r.json.data.ready ? 0 : 1), r.show);
  r = kh(["submit", "--json"]);
  check("submit without --preflight → exit 2", r.code === 2, r.show);
  r = kh(["consent", "no", "--json"]);
  check("consent no", r.code === 0 && r.json?.consent === false, r.show);
  r = kh(["report", "--json", "--", "kane-cli", "run", objective, "--agent"]);
  check("report after consent no → nothing sent", r.code === 0 && lastLine(r.out)?.reason === "consent_no", r.show);
  kh(["consent", "yes"]);
  r = kh(["hook", "status", "--json"]);
  check("hook status --json → off", r.code === 0 && r.json?.hook === "off", r.show);
  r = kh(["hook", "enable", "--json"]);
  check("hook enable → exit 2, nothing enabled", r.code === 2 && r.json?.hook === "off", r.show);

  // ── error paths ──
  r = kh(["status", "--json"], { KANEHACK_TOKEN: "khk_" + "y".repeat(32) });
  check("rejected token → exit 2 UNAUTHENTICATED", r.code === 2 && r.json?.error?.code === "UNAUTHENTICATED", r.show);
  r = kh(["help", "--status", "H-0001", "--json"], { KANEHACK_TOKEN: "khk_" + "y".repeat(32) });
  check("rejected token on an MCP command → exit 2", r.code === 2, r.show);
  const down = "http://127.0.0.1:9";
  r = kh(["status", "--json"], { KANEHACK_API: down });
  check("server down: status → exit 3 UNREACHABLE", r.code === 3 && r.json?.error?.code === "UNREACHABLE", r.show);
  r = kh(["pair", "--start", "--json"], { KANEHACK_API: down });
  check("server down: pair --start → exit 3", r.code === 3, r.show);
  r = kh(["doctor", "--json"], { KANEHACK_API: down });
  check("server down: doctor api check fails", r.code === 1 && r.json?.checks?.find((c) => c.id === "api")?.status === "fail", r.show);
  r = kh(["report", "--json", "--", "kane-cli", "run", "while the server is down", "--agent"], { KANEHACK_API: down });
  check("server down: report keeps Kane's exit code and says why", r.code === 0 && lastLine(r.out)?.reason === "unreachable", r.show);

  // Redirects: a 308 to the same site (apex → www) is followed with the token; another site is refused.
  const u = new URL(API);
  // The redirecting hosts run in their own process: kh() blocks this one while kanehack runs.
  const proxy = (target, port) =>
    new Promise((ok, no) => {
      const child = spawn(process.execPath, [join(here, "mock-server.mjs"), "--port", String(port), "--redirect-to", target], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.on("data", (b) => String(b).includes("listening") && ok({ port, close: () => child.kill() }));
      child.on("error", no);
      setTimeout(() => no(new Error("redirect proxy didn't start")), 10_000);
    });
  let www = false;
  try {
    await lookup(`www.${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}`);
    www = u.hostname === "localhost";
  } catch {}
  if (www) {
    const p1 = await proxy(`${u.protocol}//www.localhost:${u.port}`, 3391);
    r = kh(["status", "--json"], { KANEHACK_API: `http://localhost:${p1.port}`, KANEHACK_TOKEN: cfg.token });
    check("308 localhost → www.localhost (same site) followed with the token", r.code === 0 && Array.isArray(r.json?.runs), r.show);
    p1.close();
  } else console.log("# skip: www.localhost doesn't resolve here, same-site redirect not tested");
  const p2 = await proxy(`http://127.0.0.1:${u.port}`, 3392);
  r = kh(["status", "--json"], { KANEHACK_API: `http://localhost:${p2.port}`, KANEHACK_TOKEN: cfg.token });
  check("308 to a different host → refused, exit 3 REDIRECT (token not forwarded)", r.code === 3 && r.json?.error?.code === "REDIRECT", r.show);
  p2.close();

  if (APPROVE === "mock") {
    await fetch(`${API}/__mock/revoke`, { method: "POST" });
    r = kh(["status", "--json"]);
    check("revoked token → exit 2", r.code === 2 && r.json?.error?.code === "UNAUTHENTICATED", r.show);
    r = kh(["doctor", "--json"]);
    check("revoked token: doctor api fail with re-pair fix", r.json?.checks?.find((c) => c.id === "api")?.fix?.includes("kanehack pair"), r.show);
  }

  // Bounded wait for agents: plain `kanehack pair` without a TTY returns (exit 4) instead of polling for 10 minutes.
  const t0 = Date.now();
  r = kh(["pair", "--timeout", "3", "--json"]);
  check("plain pair without a TTY returns in bounded time → exit 4 pending", r.code === 4 && Date.now() - t0 < 30_000, r.show);
} finally {
  console.log(`1..${n}\n# ${n - failures}/${n} passed`);
  if (ownHome) rmSync(HOME, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
