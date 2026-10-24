# Setup and sign-in

Goal: this machine can reach the event server as this person, and Codex has the event tools.

## 1. Check the machine

Run `kanehack doctor --json` and read its checks. Fix only what failed, one at a time, using the fix each check names. The ones that matter most:

- `kane_cli` missing, or a warning that it's older than the release candidate → `npm install -g @testmuai/kane-cli@rc`. The hackathon runs on the release candidate (0.10.0-rc or newer); the plain `@testmuai/kane-cli` is an older release without everything the event uses.
  - `EACCES` or another permission error: never `sudo`. `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to `PATH` (in `~/.zshrc` or `~/.bashrc`), open a new terminal, run the install again.
  - Then `kane-cli --version` should show 0.10.0-rc or newer. Still the old one → another copy comes first on `PATH`: `which -a kane-cli` (Windows: `where kane-cli`) shows it; remove that one or reorder `PATH`.
  - Then `kane-cli whoami`; if not signed in, the person runs `kane-cli login --oauth` and approves in their browser.
- `kane_skill` missing → `npx @testmuai/kane-cli-skill`.
- `codex` → `codex login status`; if not signed in, the person runs `codex login`.
- `testmu_key` failed → step 2 decides whether it matters.
- `api` failed → network problem; check Wi-Fi, then retry.

`kanehack` itself missing → they run the install command: `curl -fsSL https://kaneclihack.sh/install.sh | sh` (Windows: `irm https://www.kaneclihack.sh/install.ps1 | iex`).

Intel Mac: Kane CLI doesn't support it. Send them to the help desk for a loaner or a teammate's machine.

## 2. Sign in (no browser)

1. `kanehack password --check --json`. Exit 2 (nothing saved) → ask them to open **their own terminal window**, not this chat, and run `kanehack password`. It asks twice without showing what they type and keeps it in `~/.kanehack/credentials.json` (mode 600). New to the site: they choose one now (8+ characters); it is also their TestMu AI password. Already registered: the password they chose on the site. Wait until they say it's set. Never ask for it here.
2. Ask: "Have you already registered on kaneclihack.sh?"
   - No → `references/signup-team.md`: `kanehack register` saves the profile and signs this machine in.
   - Yes → `kanehack signin --email <their email> --json`. Exit 0 = signed in. 2 with `WRONG_PASSWORD` = the email or the saved password is wrong: check the email, or they run `kanehack password` again in their terminal. 3 = server unreachable: check the network.

**Fallback only** (sign-in keeps failing, or they'd rather approve in the browser): pair this machine.

1. `kanehack pair --start --json`. Show only `user_code` and `verification_url`; they approve in the browser while signed in to the site.
2. `kanehack pair --wait --timeout 30 --json`. Exit 0 = paired. 4 = still pending: wait and run it again. 3 = server unreachable: check network. 1 = expired or denied: start again.

**Save the TestMu AI key if the site asks for one.** Run `node <skill>/scripts/state.mjs key-required`.

- `false` → skip this part. Doctor's `testmu_key` check will still fail; that's expected, say nothing about it.
- `true`, or `null` (couldn't tell) → `kanehack register` saves the key when the site hands one out. Otherwise the username and key are shown on `/register` once the profile is saved.
  1. Ask them to run `kanehack login` **in their own terminal window**, not in this chat, and paste the username and key there. Never ask for the key here.
  2. `kanehack doctor --json` again: `testmu_key` should pass. If it says the key isn't linked to a Hack Day profile, they finish the profile with `kanehack register`. If `/register` shows no key, send them to the help desk.

If TESTMU_USERNAME / TESTMU_ACCESS_KEY or LT_USERNAME / LT_ACCESS_KEY are set in their environment, they're sent instead of the saved key; a personal LambdaTest key there causes "not accepted". They unset those or use their event key.

## 3. Connect Codex to the event tools

`kanehack connect codex` (it backs up Codex's config; never copies a secret into it). Codex loads the `kane-hack-event` tools only in a **new** session. For the rest of this session use `node <skill>/scripts/event-api.mjs list` and `node <skill>/scripts/event-api.mjs call <tool> --args <file.json>`; for a tool that changes something, add `--confirmed` only after the person approved those exact arguments.

## 4. Done when

`participant_get_status` answers with their name. Go back to `SKILL.md` and route from there.
