# Build

## Start building

1. Only after the idea step: `participant_get_status` shows `idea.saved` true and they've seen the idea check (or turned it down). Otherwise go to `references/idea.md` first.
2. `node <skill>/scripts/state.mjs set-build building`
3. Say exactly: "You're ready to build. Use Kane as you work. Say `$hack-os ready to submit` when you're done."
4. End the turn. Don't wait, sleep, poll or set timers. Building takes hours.

## While building

- **Test with Kane**: use the official Kane CLI skill (`kane-cli`) to pick and write the command. A command or flag Kane doesn't recognize usually means an older Kane CLI: `kane-cli --version`, then `npm install -g @testmuai/kane-cli@rc`. Run it with the person's go-ahead. If `~/.kanehack/os/idea-check.json` exists, its example objectives and Kane upgrade path are a good first run and next step; warn before anything that costs credits.
- **Record a run for the team**: first `kanehack consent status`. If consent isn't given, ask whether they agree to send a redacted run summary; only if yes, `kanehack consent yes`. Then `kanehack report -- kane-cli run "<objective>" --agent` (the Kane command after `--` exactly as the Kane skill wrote it). Its output is Kane's NDJSON plus a final `kanehack_report` line: `reported: true` means the team's Proof tab has it. A failed test is still a real result; don't hide it.
- **Team's runs so far**: `kanehack status`.
- **Stuck**: `references/help.md`.

Keep your notes at `building` the whole time; help and test requests don't change it.

## "Ready to submit"

1. `node <skill>/scripts/state.mjs set-build ready`
2. `node <skill>/scripts/state.mjs check-version`. If there's a newer skill, ask them to re-run the install command and start a new Codex session, then carry on.
3. Call `submission_preflight`. "Already finalized" → tell them it's in and give the receipt, and stop.
4. Otherwise show what it lists as missing, and the list under "Submission and launch assets" in `SKILL.md`. For the posts, blog, Hacker News post, deck and video, hand over to `$hack-gtm`: tell them to type `$hack-gtm` (or ask "write our launch posts") and give it the project details you already know.
5. The captain finalizes on the Submit tab, `https://kaneclihack.sh/t/<team-slug>/submit`. Submissions lock at 18:00 Pacific; final evaluation is 16:00–17:00 at their table.
