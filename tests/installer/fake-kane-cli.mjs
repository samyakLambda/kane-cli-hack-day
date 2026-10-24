#!/usr/bin/env node
// A stand-in for kane-cli in installer/CLI tests: no browser, no account.
// It answers `--version` and `whoami`, and for `run "<objective>" --agent` prints a
// small valid NDJSON stream (the event names the official Kane CLI skill documents)
// and exits with FAKE_KANE_EXIT (default 0). The objective is echoed back in the
// stream so tests can check that arguments with spaces arrive intact.
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const code = Number(process.env.FAKE_KANE_EXIT ?? 0);
if (argv[0] === "--version") {
  console.log(process.env.FAKE_KANE_VERSION ?? "kane-cli 0.10.0-rc.1");
  process.exit(0);
}
if (argv[0] === "whoami") {
  console.log("fake@kane.test");
  process.exit(Number(process.env.FAKE_KANE_WHOAMI_EXIT ?? 0));
}
const objective = argv[0] === "run" ? (argv[1] ?? "") : argv.join(" ");
const session = randomUUID();
const status = code === 0 ? "passed" : code === 1 ? "failed" : "errored";
const events = [
  { type: "run_start", objective, argv },
  { type: "step", n: 1, action: "navigate", ok: true },
  ...(process.env.FAKE_KANE_NO_END ? [] : [{ type: "run_end", status, one_liner: `${status}: ${objective}`.slice(0, 200), summary: objective, duration: 1.2, session_dir: `.kane/sessions/${session}` }]),
];
for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
process.exit(code);
