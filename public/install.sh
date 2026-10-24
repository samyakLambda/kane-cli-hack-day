#!/bin/sh
# Kane CLI Hack Day installer: https://kaneclihack.sh/install.sh
# Version: 0.1.9
#
# Read me before you run me. This script:
#   - checks OS/arch, Node, Git, Chrome, OpenAI Codex CLI, Kane CLI, Kane auth,
#     the official Kane CLI skill, the hack skills and whether the event API answers
#   - asks before it installs anything, and only installs the OpenAI Codex CLI
#     (npm i -g @openai/codex, if it's missing), the `kanehack` helper into
#     ~/.kanehack and the hack-os skill into ~/.agents/skills (where Codex reads
#     it), the last two from tarballs whose sha256 is pinned below
#   - if you have Codex, offers to add the event MCP server to it. ~/.codex/config.toml
#     gets the server URL and `kanehack mcp-headers` (which prints the auth header when
#     Codex connects), never the token itself; config.toml is backed up first
#   - to make `kanehack` a command, links it into a folder that is already on your
#     PATH and writable by you (npm's global bin, ~/.local/bin or ~/bin), or offers
#     one line for your shell profile
#   - never uses sudo, never edits your shell profile unless you say yes, never reads your repos,
#     files or chat history, never sends anything except one unauthenticated
#     "is the API up?" request
# Anything missing is reported with the exact command to fix it; you run it.
#
# No terminal (Codex runs it for you, CI)? Every question is a quiet "no" unless you pass --yes:
#   curl -fsSL https://kaneclihack.sh/install.sh | sh -s -- --yes
# Options: --yes (-y) answer yes to every install question · --no-path don't link kanehack or
# touch your profile · --no-skills don't install the hack-os skill · --no-agents don't connect
# Codex to the event server · --site URL another server.
# The same as environment variables: KANEHACK_YES=1 KANEHACK_NO_PATH=1 KANEHACK_NO_SKILLS=1
# KANEHACK_NO_AGENTS=1 KANEHACK_SITE=URL.
# Exit codes: 0 done (problems are listed as ✗ lines) · 1 a download, checksum or install failed · 2 bad option.
set -eu
# `curl … | zsh` works too: behave like sh (word splitting, globbing).
if [ -n "${ZSH_VERSION:-}" ]; then emulate sh; fi

KANEHACK_VERSION="0.1.9"
KANEHACK_SHA256="12943d21362a8b159dba2a5d3c72bbffff0644fe1204940cf97d95eb44340a3a"
SKILLS_SHA256="a0579e787fd20f7b68d8f1d2669309a26c0b935fbaf84b2a528f4900dfe86fae"
DEFAULT_SITE="https://kaneclihack.sh"
SITE="${KANEHACK_SITE:-$DEFAULT_SITE}"
YES="${KANEHACK_YES:-}"
NO_PATH="${KANEHACK_NO_PATH:-}"
NO_SKILLS="${KANEHACK_NO_SKILLS:-}"
NO_AGENTS="${KANEHACK_NO_AGENTS:-}"
case "$YES" in 0|false|no) YES="" ;; esac
case "$NO_PATH" in 0|false|no) NO_PATH="" ;; esac
case "$NO_SKILLS" in 0|false|no) NO_SKILLS="" ;; esac
case "$NO_AGENTS" in 0|false|no) NO_AGENTS="" ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-path) NO_PATH=1 ;;
    --no-skills) NO_SKILLS=1 ;;
    --no-agents) NO_AGENTS=1 ;;
    --site) [ $# -ge 2 ] || { echo "install.sh: --site needs a URL" >&2; exit 2; }; SITE="$2"; shift ;;
    --site=*) SITE="${1#--site=}" ;;
    -h|--help) sed -n '2,29p' "$0" 2>/dev/null || echo "Options: --yes --no-path --no-skills --no-agents --site URL"; exit 0 ;;
    *) echo "install.sh: unknown option $1 (try --yes, --no-path, --no-skills, --no-agents, --site URL)" >&2; exit 2 ;;
  esac
  shift
done
SITE="${SITE%/}"
PREFIX="${HOME}/.kanehack"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then G="$(printf '\033[32m')"; Y="$(printf '\033[33m')"; R="$(printf '\033[31m')"; D="$(printf '\033[2m')"; N="$(printf '\033[0m')"; else G=""; Y=""; R=""; D=""; N=""; fi
pass() { printf '%s✓%s %-12s %s\n' "$G" "$N" "$1" "${2:-}"; }
warn() { printf '%s!%s %-12s %s %s→ %s%s\n' "$Y" "$N" "$1" "${2:-}" "$D" "$3" "$N"; }
fail() { printf '%s✗%s %-12s %s %s→ %s%s\n' "$R" "$N" "$1" "${2:-}" "$D" "$3" "$N"; FAILED=1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Bound commands that could hang (network, auth) when `timeout` exists.
bounded() { if have timeout; then timeout 20 "$@"; else "$@"; fi; }
sha256() { if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1; elif have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else openssl dgst -sha256 "$1" | sed 's/.*= *//'; fi; }
FAILED=0
NO_TTY_SKIPS=0

# A person is there only if our output goes to a terminal and /dev/tty opens.
# (curl | sh has no stdin, so answers come from /dev/tty. Codex and CI have no terminal.)
CAN_ASK=""
if [ -z "${CI:-}" ] && { [ -t 1 ] || [ -t 2 ]; } && { : </dev/tty; } 2>/dev/null; then CAN_ASK=1; fi

ask() {
  if [ -n "$YES" ]; then printf '%s [y/N] y (--yes)\n' "$1"; return 0; fi
  if [ -z "$CAN_ASK" ]; then NO_TTY_SKIPS=$((NO_TTY_SKIPS + 1)); return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  read -r a </dev/tty || a=""
  case "$a" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

echo "Kane CLI Hack Day setup check (installer ${KANEHACK_VERSION})"
[ -n "$YES" ] && echo "Non-interactive: --yes answers every install question."
[ -z "$YES" ] && [ -z "$CAN_ASK" ] && echo "No terminal: install questions are answered no (re-run with --yes to install)."
echo

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin|Linux) pass os "${OS}-${ARCH}" ;;
  *) fail os "${OS}-${ARCH}" "Use install.ps1 on Windows" ;;
esac

if have node; then
  NV="$(node -v 2>/dev/null | sed 's/^v//')"; NMAJ="${NV%%.*}"
  if [ "${NMAJ:-0}" -ge 18 ] 2>/dev/null; then pass node "$NV"; else fail node "$NV" "Install Node 18+ from https://nodejs.org"; fi
else fail node "missing" "Install Node 18+ from https://nodejs.org"; fi

if have git; then pass git "$(git --version | sed 's/git version //')"; else fail git "missing" "Install Git: https://git-scm.com"; fi

CHROME=""
if [ "$OS" = Darwin ]; then
  if [ -d "/Applications/Google Chrome.app" ] || [ -d "${HOME}/Applications/Google Chrome.app" ]; then CHROME=yes; fi
else
  for b in google-chrome google-chrome-stable chromium chromium-browser; do if have "$b"; then CHROME=yes; break; fi; done
fi
if [ -n "$CHROME" ]; then pass chrome; else fail chrome "missing" "Install Google Chrome: Kane drives a real browser"; fi

# OpenAI Codex CLI: the event's coding agent. Missing → offer `npm i -g @openai/codex`
# (never with sudo: if npm's global folder isn't yours, say how to fix that instead).
if have codex; then pass codex "$(bounded codex --version 2>/dev/null | head -n1)"
elif ! have npm; then fail codex "missing" "Install Node (with npm) first, then: npm i -g @openai/codex"
else
  NPM_G="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$NPM_G" ] && { [ -w "$NPM_G/lib/node_modules" ] || { [ ! -e "$NPM_G/lib/node_modules" ] && [ -w "$NPM_G" ]; }; }; then
    if ask "OpenAI Codex CLI is not installed. Install it now (npm i -g @openai/codex)?"; then
      if npm install -g --silent --no-audit --no-fund @openai/codex >/dev/null 2>"${TMPDIR:-/tmp}/kanehack-codex.$$"; then
        rm -f "${TMPDIR:-/tmp}/kanehack-codex.$$"; hash -r 2>/dev/null || true
        if have codex; then pass codex "installed $(bounded codex --version 2>/dev/null | head -n1). Sign in with: codex login"
        else warn codex "installed, but not on your PATH" "Add ${NPM_G%/}/bin to your PATH, then: codex login"; fi
      else
        cat "${TMPDIR:-/tmp}/kanehack-codex.$$" >&2; rm -f "${TMPDIR:-/tmp}/kanehack-codex.$$"
        fail codex "npm install failed" "See the npm output above, or ask at the help desk"
      fi
    else warn codex "not installed" "npm i -g @openai/codex   (then: codex login)"; fi
  else
    fail codex "missing" "npm's global folder (${NPM_G:-unknown}) needs sudo. Don't use sudo: npm config set prefix ~/.npm-global, add ~/.npm-global/bin to PATH, then npm i -g @openai/codex"
  fi
fi

if have kane-cli; then
  KV=$(bounded kane-cli --version 2>/dev/null | head -n1)
  # The hackathon runs on the release candidate (0.10.0-rc or newer): 0.0-0.9 gets the upgrade command.
  case " $KV" in
    *[!0-9.]0.[0-9].*) warn kane_cli "$KV: older than the hackathon's release candidate" "npm install -g @testmuai/kane-cli@rc" ;;
    *) pass kane_cli "$KV" ;;
  esac
  if bounded kane-cli whoami >/dev/null 2>&1; then pass kane_auth; else fail kane_auth "signed out" "kane-cli login"; fi
else
  fail kane_cli "missing" "npm install -g @testmuai/kane-cli@rc   (no sudo: set an npm prefix in your home if it asks)"
  warn kane_auth "skipped" "Install Kane CLI first"
fi

SKILL=""
for d in .agents/skills/kane-cli .codex/skills/kane-cli; do if [ -f "${HOME}/${d}/SKILL.md" ]; then SKILL=yes; fi; done
if [ -n "$SKILL" ]; then pass kane_skill; else warn kane_skill "not found" "npx @testmuai/kane-cli-skill"; fi

# Where Codex looks for personal skills. One per line, so a HOME with spaces in it works.
skill_dirs() {
  echo "${HOME}/.agents/skills"
}
SKILL_DIRS="$(skill_dirs | sed 's/$/,/' | tr '\n' ' ' | sed 's/, *$//')"
# Installer 0.1.2 also copied the skills into ~/.codex/skills. Codex reads that folder as well as
# ~/.agents/skills, so it listed every hack-* skill twice: those copies (marked .bundle-version) go.
CODEX_DIR="${CODEX_HOME:-${HOME}/.codex}"
LEGACY_SKILLS="${CODEX_DIR}/skills"
# Bundles up to 0.1.4 installed these 12 skills (marked by hack-onboard/.bundle-version); hack-os replaces them.
OLD_SKILLS="hack-onboard hack-doctor hack-team hack-idea hack-harness hack-verify hack-progress hack-help hack-demo hack-showcase hack-gtm hack-submit"
# Missing, installed by an older bundle, or the old 12 still there: re-offer (the marker file names the bundle version).
NEED_SKILLS="$({ skill_dirs | while IFS= read -r d; do
  if [ ! -f "${d}/hack-os/SKILL.md" ] || [ ! -f "${d}/hack-gtm/SKILL.md" ] || ! grep -qx "$KANEHACK_VERSION" "${d}/hack-os/.bundle-version" 2>/dev/null || [ -f "${d}/hack-onboard/.bundle-version" ]; then echo yes; fi
done; if [ -f "${LEGACY_SKILLS}/hack-onboard/.bundle-version" ]; then echo yes; fi; } | head -n1)"
if [ -z "$NEED_SKILLS" ]; then pass hack_skills "${KANEHACK_VERSION}"; else warn hack_skills "not found or older" "Offered below"; fi

# One unauthenticated request: 401 means the API is up and wants a token.
if have curl; then
  CODE="$(curl -sL -o /dev/null -w '%{http_code}' --max-time 10 "${SITE}/api/v1/kane/runs" || true)"
  case "$CODE" in 401|200|403) pass api "${SITE} (HTTP ${CODE})" ;; *) fail api "HTTP ${CODE:-000}" "Check your network; the web app is ${SITE}" ;; esac
else warn api "curl missing" "Install curl"; fi

echo
# ── decide what to install, download and verify everything, then install ──
WANT_KH=""; WANT_SKILLS=""; KH_HAVE=""
if [ -x "${PREFIX}/bin/kanehack" ] && "${PREFIX}/bin/kanehack" version 2>/dev/null | grep -qx "$KANEHACK_VERSION"; then
  KH_HAVE=1
  pass kanehack "${KANEHACK_VERSION} already installed in ${PREFIX}"
elif ! have node || ! have npm; then
  warn kanehack "not installed" "Install Node (with npm) first, then re-run this script"
elif [ -x "${PREFIX}/bin/kanehack" ] && ask "Upgrade the kanehack helper in ${PREFIX} to ${KANEHACK_VERSION} (no sudo)?"; then
  WANT_KH=1
elif [ ! -x "${PREFIX}/bin/kanehack" ] && ask "Install the kanehack helper ${KANEHACK_VERSION} into ${PREFIX} (no sudo)?"; then
  WANT_KH=1
else
  warn kanehack "skipped" "Re-run this script when you're ready"
fi

if [ -n "$NEED_SKILLS" ]; then
  if [ -n "$NO_SKILLS" ]; then warn hack_skills "skipped (--no-skills)" "Re-run without --no-skills to add them"
  elif ! have curl; then warn hack_skills "skipped" "Install curl, then re-run"
  elif ask "Install the Kane Hack OS skills (hack-os, hack-gtm) into ${SKILL_DIRS}?"; then WANT_SKILLS=1
  else warn hack_skills "skipped" "Re-run this script when you're ready"; fi
fi

TMP=""
if [ -n "$WANT_KH" ] || [ -n "$WANT_SKILLS" ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  BAD=""
  if [ -n "$WANT_KH" ]; then
    TGZ="${TMP}/kanehack-${KANEHACK_VERSION}.tgz"
    if ! curl -fsSL --max-time 60 --retry 2 --retry-delay 2 --retry-connrefused -o "$TGZ" "${SITE}/kanehack-${KANEHACK_VERSION}.tgz"; then fail kanehack "download failed" "Check your network and re-run (${SITE}/kanehack-${KANEHACK_VERSION}.tgz)"; BAD=1
    else
      GOT="$(sha256 "$TGZ")"
      if [ "$GOT" != "$KANEHACK_SHA256" ]; then fail kanehack "checksum mismatch" "Don't use this download; tell the help desk (got ${GOT})"; BAD=1; fi
    fi
  fi
  if [ -n "$WANT_SKILLS" ]; then
    STGZ="${TMP}/hack-skills-${KANEHACK_VERSION}.tgz"
    if ! curl -fsSL --max-time 60 --retry 2 --retry-delay 2 --retry-connrefused -o "$STGZ" "${SITE}/hack-skills-${KANEHACK_VERSION}.tgz"; then fail hack_skills "download failed" "Check your network and re-run"; BAD=1
    else
      GOT="$(sha256 "$STGZ")"
      if [ "$GOT" != "$SKILLS_SHA256" ]; then fail hack_skills "checksum mismatch" "Don't use this download; tell the help desk (got ${GOT})"; BAD=1; fi
    fi
  fi
  if [ -n "$BAD" ]; then
    echo "${R}Nothing was installed.${N}"
    exit 1
  fi
  if [ -n "$WANT_KH" ]; then
    mkdir -p "${PREFIX}/cli" "${PREFIX}/bin"
    if ! npm install --silent --no-audit --no-fund --prefix "${PREFIX}/cli" "$TGZ" >"${TMP}/npm.log" 2>&1; then
      cat "${TMP}/npm.log" >&2
      fail kanehack "npm install failed" "See the npm output above, or ask at the help desk"
      exit 1
    fi
    ln -sf "${PREFIX}/cli/node_modules/kanehack/bin/kanehack.mjs" "${PREFIX}/bin/kanehack"
    chmod +x "${PREFIX}/cli/node_modules/kanehack/bin/kanehack.mjs" 2>/dev/null || true
    KH_HAVE=1
    pass kanehack "${KANEHACK_VERSION} → ${PREFIX}/bin/kanehack (sha256 verified)"
  fi
  if [ -n "$WANT_SKILLS" ]; then
    # Only hack-os and hack-gtm are written; your other skills are left alone. The old bundle's 12
    # folders go first, and only when its marker says we installed them: its hack-gtm is one of them.
    if ! skill_dirs | while IFS= read -r d; do
      if [ -f "${d}/hack-onboard/.bundle-version" ]; then
        for s in $OLD_SKILLS; do rm -rf "${d:?}/${s}"; done
      fi
      mkdir -p "$d" && tar -xzf "$STGZ" -C "$d" && echo "$KANEHACK_VERSION" > "${d}/hack-os/.bundle-version" || exit 1
    done; then
      fail hack_skills "couldn't unpack" "Check that your skill folders are writable"
      exit 1
    fi
    pass hack_skills "hack-os, hack-gtm → ${SKILL_DIRS} (sha256 verified). Start a new Codex session to load it."
    # Only the old 12. Checked now, not before the loop: when ~/.codex/skills is the same folder as
    # ~/.agents/skills the loop has already removed the marker, so the fresh hack-gtm stays.
    if [ -f "${LEGACY_SKILLS}/hack-onboard/.bundle-version" ]; then
      for s in $OLD_SKILLS; do rm -rf "${LEGACY_SKILLS:?}/${s}"; done
      pass codex_skills "removed the old copies in ${LEGACY_SKILLS} (Codex reads ~/.agents/skills; two copies listed each skill twice)"
    fi
  fi
fi

# Point kanehack at this server when it isn't the default one.
if [ -n "$KH_HAVE" ] && [ "$SITE" != "$DEFAULT_SITE" ]; then
  KANEHACK_CFG_API="$SITE" node -e '
    const fs = require("fs"), p = require("path").join(require("os").homedir(), ".kanehack", "config.json");
    let c = {}; try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (c.api !== process.env.KANEHACK_CFG_API) {
      c.api = process.env.KANEHACK_CFG_API;
      fs.writeFileSync(p, JSON.stringify(c, null, 2), { mode: 0o600 });
      fs.chmodSync(p, 0o600);
    }' && pass server "kanehack will talk to ${SITE}"
fi

echo
# ── make `kanehack` a command in this terminal and new ones ──
# curl | sh can't change your shell's PATH, so link into a folder that is already on PATH
# and writable by you. Never sudo, never replace a different kanehack.
KH="${PREFIX}/bin/kanehack"
on_path() { case ":${PATH}:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }
is_ours() {
  # $1 resolves to our install: it's ~/.kanehack/bin/kanehack, or a link to it (or to its target).
  [ "$1" = "${PREFIX}/bin/kanehack" ] && return 0
  t="$(readlink "$1" 2>/dev/null || true)"
  [ "$t" = "${PREFIX}/bin/kanehack" ] || [ "$t" = "${PREFIX}/cli/node_modules/kanehack/bin/kanehack.mjs" ]
}
if [ -n "$KH_HAVE" ] && [ -x "${PREFIX}/bin/kanehack" ]; then
  FOUND="$(command -v kanehack 2>/dev/null || true)"
  LINKED=""
  CONFLICT=""
  if [ -n "$FOUND" ] && is_ours "$FOUND"; then
    KH="kanehack"; LINKED=1
    pass command "kanehack → ${FOUND}"
  elif [ -n "$NO_PATH" ]; then
    echo "${D}--no-path: kanehack is not linked; use the full path below.${N}"
  elif [ -n "$FOUND" ]; then
    CONFLICT=1
    warn command "another kanehack is on PATH" "${FOUND} isn't this install; left alone (PATH not changed). Use the full path below, or remove it"
  else
    LINK_DIR=""
    NPM_BIN=""
    if have npm; then NPM_BIN="$(npm prefix -g 2>/dev/null || true)"; [ -n "$NPM_BIN" ] && NPM_BIN="${NPM_BIN%/}/bin"; fi
    for d in "$NPM_BIN" "${HOME}/.local/bin" "${HOME}/bin"; do
      if [ -n "$d" ] && [ -d "$d" ] && [ -w "$d" ] && on_path "$d" && [ ! -e "${d}/kanehack" ]; then LINK_DIR="$d"; break; fi
    done
    if [ -n "$LINK_DIR" ] && ask "Make \`kanehack\` a command (link into ${LINK_DIR})?"; then
      if ln -s "${PREFIX}/bin/kanehack" "${LINK_DIR}/kanehack" 2>/dev/null; then
        KH="kanehack"; LINKED=1
        pass command "kanehack → ${LINK_DIR}/kanehack (works in this terminal now)"
      else
        warn command "couldn't link into ${LINK_DIR}" "Use the full path below"
      fi
    elif [ -z "$LINK_DIR" ]; then
      echo "${D}No folder on your PATH is writable without sudo (tried npm's global bin, ~/.local/bin, ~/bin).${N}"
    fi
  fi
  # Not a command yet: offer the profile line for new terminals (asked, never silent).
  if [ -z "$LINKED" ] && [ -z "$NO_PATH" ] && [ -z "$CONFLICT" ] && ! on_path "${PREFIX}/bin"; then
    SH_NAME="${SHELL:-}"; SH_NAME="${SH_NAME##*/}"
    case "$SH_NAME" in
      zsh) RC="${HOME}/.zshrc" ;;
      bash) if [ "$OS" = Darwin ]; then RC="${HOME}/.bash_profile"; else RC="${HOME}/.bashrc"; fi ;;
      *) RC="" ;;
    esac
    LINE='export PATH="$HOME/.kanehack/bin:$PATH"  # kanehack'
    if [ -n "$RC" ] && grep -qF '.kanehack/bin' "$RC" 2>/dev/null; then
      echo "${D}${RC} already adds kanehack to PATH: new terminals have it.${N}"
    elif [ -n "$RC" ] && ask "Add ~/.kanehack/bin to your PATH in ${RC}?"; then
      printf '\n%s\n' "$LINE" >> "$RC"
      pass path "added to ${RC} for new terminals. In this one: export PATH=\"\$HOME/.kanehack/bin:\$PATH\""
    elif [ "$SH_NAME" = fish ]; then
      echo "${Y}kanehack isn't on your PATH.${N} For fish, run once: fish_add_path ~/.kanehack/bin"
    else
      echo "${Y}kanehack isn't on your PATH.${N} Use the full path below, or run: export PATH=\"\$HOME/.kanehack/bin:\$PATH\""
    fi
  fi
fi

# ── connect Codex to the event MCP server ──
# kanehack does the editing (and backs up ~/.codex/config.toml first). Codex's config gets the
# URL plus `kanehack mcp-headers`, which prints the auth header when Codex connects: the token
# itself is never written there or printed here. A different server with that name is left alone.
AGENTS_SHOWN=""
connect_agent() { # $1 codex  $2 display name  $3 where it's written
  rc=0; "${PREFIX}/bin/kanehack" connect "$1" --check >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) pass "${1}_mcp" "$2 already connected to the event server (kane-hack-event)" ;;
    2) warn "${1}_mcp" "another kane-hack-event server is configured; left alone" "Run ${KH} connect $1 to see it" ;;
    *)
      if ask "Connect $2 to the event server (adds kane-hack-event to $3; no token is stored)?"; then
        rc=0; "${PREFIX}/bin/kanehack" connect "$1" || rc=$?
        if [ "$rc" -eq 0 ]; then pass "${1}_mcp" "$2 → kane-hack-event (pair, then start a new $2 session)"
        else warn "${1}_mcp" "not connected" "${KH} connect $1"; fi
      else warn "${1}_mcp" "not connected" "${KH} connect $1"; fi
      ;;
  esac
}
if [ -z "$NO_AGENTS" ]; then
  if have codex || [ -d "$CODEX_DIR" ]; then
    AGENTS_SHOWN=1
    if [ -n "$KH_HAVE" ] && [ -x "${PREFIX}/bin/kanehack" ]; then connect_agent codex Codex "${CODEX_DIR}/config.toml"
    else warn codex_mcp "not connected" "Install kanehack first (re-run this script), then: kanehack connect codex"; fi
  fi
fi

echo
echo "Next, in this terminal:"
echo "  1. ${KH} pair        link this machine to your passport (approve the code it shows in your browser)"
echo "  2. ${KH} doctor      re-check your setup"
echo "  3. ${KH} report -- kane-cli run \"Open ${SITE} and find the schedule\" --agent"
echo "     (your first Kane run, sent to your team's Proof tab)"
if [ -n "$AGENTS_SHOWN" ]; then echo 'Then in Codex: start a new session and type $hack-os'; fi
echo "Web: ${SITE}/passport"
if [ "$NO_TTY_SKIPS" -gt 0 ]; then
  SITE_ARG=""; [ "$SITE" != "$DEFAULT_SITE" ] && SITE_ARG=" --site ${SITE}"
  echo
  echo "${Y}There was no terminal to ask, so ${NO_TTY_SKIPS} install step(s) were skipped.${N} To install without prompts, run:"
  echo "  curl -fsSL ${SITE}/install.sh | sh -s -- --yes${SITE_ARG}"
fi
[ "$FAILED" -eq 0 ] || echo "${Y}Some checks failed. Fix them with the commands above, or ask at the help desk.${N}"
exit 0
