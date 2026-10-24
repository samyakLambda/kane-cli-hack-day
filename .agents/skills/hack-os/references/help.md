# Help

## 1. Try the quick fixes first

- `help_diagnose` with a `category` and a one-line `symptom` gives first-line fixes from the event docs.
- For Kane CLI errors, follow the official Kane CLI skill's troubleshooting.
- Kane CLI missing, too old, or a command or flag "not recognized": `kane-cli --version`. The hackathon runs on the release candidate, 0.10.0-rc or newer; install or upgrade with `npm install -g @testmuai/kane-cli@rc` (install problems: `references/setup.md`, step 1). Only file an issue once it's on the release candidate.
- Setup problems → `references/setup.md`.

## 2. Kane CLI problem still there → a GitHub issue on LambdaTest/kane-cli

1. Draft it with them: a title, then what they ran, what they expected, what happened, `kane-cli --version`, their OS, and the error output.
2. Write the draft body to a file and run `node <skill>/scripts/issue.mjs --title "<title>" --body-file <file>`. It strips the keys and tokens it recognises, this machine's own saved key and token, emails and home folder paths, and adds `[Hack Day]` to the title. It can miss a secret in an unusual format, so read the cleaned text yourself before showing it.
3. Show them the exact title and the cleaned body (from `body_file`). Issues are public. Ask: "File this on LambdaTest/kane-cli?"
4. Only after a yes:
   - `gh_ready` true → run the command in `gh_argv` exactly. It prints the issue link.
   - Otherwise → give them `url` to open; they press Submit in their browser and tell you the issue link.
5. `node <skill>/scripts/state.mjs add-issue <issue link>`. On later status checks, list their open issues.

## 3. Not a Kane CLI problem

Sign-in, team, activation, credits, Wi-Fi or the venue: `kanehack help "<one line: what's wrong>"` opens a mentor ticket and prints its code (check it later with `kanehack help --status <code>`), or they go to the help desk.
