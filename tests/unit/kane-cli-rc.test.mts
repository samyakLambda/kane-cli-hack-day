// The hackathon runs on the Kane CLI release candidate: `npm install -g @testmuai/kane-cli@rc`.
// Every place a participant is told how to install Kane CLI says that, and hack-os knows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RC = "npm install -g @testmuai/kane-cli@rc";
// An install of the plain package (not @rc, not the -skill package).
const PLAIN = /npm (?:i|install) -g @testmuai\/kane-cli(?![@\w-])/;

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const read = (f: string) => readFileSync(f, "utf8");

test("installers, kanehack doctor and the readiness check all say @rc", () => {
  for (const f of ["public/install.sh", "public/install.ps1", "packages/kanehack/bin/kanehack.mjs", "src/server/passport.ts"]) {
    assert.ok(read(f).includes(RC), `${f} doesn't say ${RC}`);
    assert.doesNotMatch(read(f), PLAIN, f);
  }
});

for (const base of ["plugin/skills", ".agents/skills"]) {
  test(`${base}: hack-os never tells anyone to install the plain package`, () => {
    for (const f of walk(`${base}/hack-os`).filter((f) => /\.(md|mjs)$/.test(f))) assert.doesNotMatch(read(f), PLAIN, f);
  });

  test(`${base}: hack-os knows the event runs on the release candidate, and how to install or upgrade it`, () => {
    assert.ok(read(`${base}/hack-os/SKILL.md`).includes(RC), "SKILL.md");
    const setup = read(`${base}/hack-os/references/setup.md`);
    assert.ok(setup.includes(RC), "setup.md");
    assert.match(setup, /kane-cli --version/);
    assert.match(setup, /EACCES|permission/i);
    assert.ok(read(`${base}/hack-os/references/help.md`).includes(RC), "help.md");
  });
}
