# Kane CLI Hack Day installer for Windows: https://www.kaneclihack.sh/install.ps1
# Version: 0.1.9
#
# Read me before you run me. This script checks Node, Git, Chrome, the OpenAI
# Codex CLI, Kane CLI, Kane auth, the official Kane CLI skill, the hack skills
# and whether the event API answers. It asks before installing anything, and
# only installs the OpenAI Codex CLI (npm i -g @openai/codex, if missing), the
# `kanehack` helper into %USERPROFILE%\.kanehack and the hack-os skill into
# .agents\skills (where Codex reads it), the last two from tarballs whose
# sha256 is pinned below. To make `kanehack` a command it puts a small
# kanehack.cmd shim in npm's global folder (already on your PATH), or offers to add
# .kanehack\bin to your user PATH. If you have Codex, it offers to add the event
# MCP server to it: .codex\config.toml gets the URL and `kanehack mcp-headers`
# (prints the auth header when Codex connects), never the token; config.toml is
# backed up first. No admin rights, no reading your repos or
# chat history.
#
# No terminal (Codex runs it for you, CI)? Every question is a quiet "no" unless you say yes:
#   $env:KANEHACK_YES = "1"; irm https://www.kaneclihack.sh/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://www.kaneclihack.sh/install.ps1))) -Yes
# Options (or environment variables): -Yes (KANEHACK_YES=1) · -NoPath (KANEHACK_NO_PATH=1)
# · -NoSkills (KANEHACK_NO_SKILLS=1) · -NoAgents (KANEHACK_NO_AGENTS=1: don't connect
# Codex to the event server) · -Site URL (KANEHACK_SITE).
# A failed download, checksum or install stops with an error (a non-zero exit for
# `powershell -File` / `pwsh -c`); it never closes your PowerShell window.
param([switch]$Yes, [switch]$NoPath, [switch]$NoSkills, [switch]$NoAgents, [string]$Site)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Windows PowerShell 5.1 downloads crawl with the progress bar on
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$KanehackVersion = "0.1.9"
$KanehackSha256 = "12943d21362a8b159dba2a5d3c72bbffff0644fe1204940cf97d95eb44340a3a"
$SkillsSha256 = "a0579e787fd20f7b68d8f1d2669309a26c0b935fbaf84b2a528f4900dfe86fae"
function EnvOn($name) { $v = [Environment]::GetEnvironmentVariable($name); [bool]($v -and ($v -notmatch '^(0|false|no)$')) }
$Yes = $Yes -or (EnvOn "KANEHACK_YES")
$NoPath = $NoPath -or (EnvOn "KANEHACK_NO_PATH")
$NoSkills = $NoSkills -or (EnvOn "KANEHACK_NO_SKILLS")
$NoAgents = $NoAgents -or (EnvOn "KANEHACK_NO_AGENTS")
# The www host directly: Windows PowerShell 5.1 doesn't follow the apex's 308 redirect.
$DefaultSite = "https://www.kaneclihack.sh"
if (-not $Site) { $Site = if ($env:KANEHACK_SITE) { $env:KANEHACK_SITE } else { $DefaultSite } }
$Site = $Site.TrimEnd("/")
# The same home folder kanehack (Node's os.homedir()) uses.
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$Prefix = Join-Path $UserHome ".kanehack"
$script:Failed = $false
$script:NoTtySkips = 0

function Pass($id, $info = "") { Write-Host ("✓ {0,-12} {1}" -f $id, $info) -ForegroundColor Green }
function Warn($id, $info, $fix) { Write-Host ("! {0,-12} {1} → {2}" -f $id, $info, $fix) -ForegroundColor Yellow }
function Fail($id, $info, $fix) { Write-Host ("✗ {0,-12} {1} → {2}" -f $id, $info, $fix) -ForegroundColor Red; $script:Failed = $true }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# A person is there only in an interactive host whose input isn't redirected.
$NonInteractiveArg = [Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }
$CanAsk = [Environment]::UserInteractive -and -not $NonInteractiveArg -and -not $env:CI
try { if ([Console]::IsInputRedirected) { $CanAsk = $false } } catch {}

function Ask($question) {
  if ($Yes) { Write-Host "$question [y/N] y (-Yes)"; return $true }
  if (-not $CanAsk) { $script:NoTtySkips++; return $false }
  try { $a = Read-Host "$question [y/N]" } catch { $script:NoTtySkips++; return $false }
  return ($a -match '^(y|yes)$')
}

Write-Host "Kane CLI Hack Day setup check (installer $KanehackVersion)"
if ($Yes) { Write-Host "Non-interactive: -Yes answers every install question." }
elseif (-not $CanAsk) { Write-Host "No terminal: install questions are answered no (re-run with -Yes to install)." }
Write-Host ""
Pass "os" "windows-$env:PROCESSOR_ARCHITECTURE"

if (Have node) {
  $nv = (node -v).TrimStart("v"); $major = [int]($nv.Split(".")[0])
  if ($major -ge 18) { Pass "node" $nv } else { Fail "node" $nv "Install Node 18+ from https://nodejs.org" }
} else { Fail "node" "missing" "Install Node 18+ from https://nodejs.org" }

if (Have git) { Pass "git" ((git --version) -replace "git version ", "") } else { Fail "git" "missing" "Install Git: https://git-scm.com" }

$chromePaths = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
if ($chromePaths | Where-Object { $_ -and (Test-Path $_) }) { Pass "chrome" } else { Fail "chrome" "missing" "Install Google Chrome: Kane drives a real browser" }

# OpenAI Codex CLI: the event's coding agent. Missing -> offer `npm i -g @openai/codex`.
if (Have codex) { Pass "codex" }
elseif (-not (Have npm)) { Fail "codex" "missing" "Install Node (with npm) first, then: npm i -g @openai/codex" }
elseif (Ask "OpenAI Codex CLI is not installed. Install it now (npm i -g @openai/codex)?") {
  $codexLog = Join-Path ([IO.Path]::GetTempPath()) "kanehack-codex.log"
  & npm install -g --silent --no-audit --no-fund "@openai/codex" *> $codexLog
  if ($LASTEXITCODE -eq 0) {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    if (Have codex) { Pass "codex" "installed. Sign in with: codex login" }
    else { Warn "codex" "installed, but not on PATH yet" "Open a new terminal, then: codex login" }
  } else {
    Get-Content $codexLog | Write-Host
    Fail "codex" "npm install failed" "See the npm output above, or ask at the help desk"
  }
  Remove-Item $codexLog -ErrorAction SilentlyContinue
}
else { Warn "codex" "not installed" "npm i -g @openai/codex   (then: codex login)" }

if (Have kane-cli) {
  $kv = [string]((kane-cli --version) | Select-Object -First 1)
  # The hackathon runs on the release candidate (0.10.0-rc or newer): 0.0-0.9 gets the upgrade command.
  if ($kv -match '(?<![\d.])0\.\d\.') { Warn "kane_cli" "$kv`: older than the hackathon's release candidate" "npm install -g @testmuai/kane-cli@rc" } else { Pass "kane_cli" $kv }
  kane-cli whoami *> $null
  if ($LASTEXITCODE -eq 0) { Pass "kane_auth" } else { Fail "kane_auth" "signed out" "kane-cli login" }
} else {
  Fail "kane_cli" "missing" "npm install -g @testmuai/kane-cli@rc"
  Warn "kane_auth" "skipped" "Install Kane CLI first"
}

$skill = @(".agents\skills\kane-cli", ".codex\skills\kane-cli") | Where-Object { Test-Path (Join-Path $UserHome "$_\SKILL.md") }
if ($skill) { Pass "kane_skill" } else { Warn "kane_skill" "not found" "npx @testmuai/kane-cli-skill" }

# Where Codex looks for personal skills.
$skillDirs = @(Join-Path $UserHome ".agents\skills")
# Installer 0.1.2 also copied the skills into .codex\skills. Codex reads that folder as well as
# .agents\skills, so it listed every hack-* skill twice: those copies (marked .bundle-version) go.
$CodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $UserHome ".codex" }
$legacySkills = Join-Path $CodexDir "skills"
# Bundles up to 0.1.4 installed these 12 skills (marked by hack-onboard\.bundle-version); hack-os replaces them.
$OldSkills = @("hack-onboard", "hack-doctor", "hack-team", "hack-idea", "hack-harness", "hack-verify", "hack-progress", "hack-help", "hack-demo", "hack-showcase", "hack-gtm", "hack-submit")
$hasLegacy = Test-Path (Join-Path $legacySkills "hack-onboard\.bundle-version")
function SkillsCurrent($d) {
  $marker = Join-Path $d "hack-os\.bundle-version"
  (Test-Path (Join-Path $d "hack-os\SKILL.md")) -and (Test-Path (Join-Path $d "hack-gtm\SKILL.md")) -and (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $KanehackVersion) -and -not (Test-Path (Join-Path $d "hack-onboard\.bundle-version"))
}
$needSkills = $hasLegacy -or (@($skillDirs | Where-Object { -not (SkillsCurrent $_) }).Count -gt 0)
if (-not $needSkills) { Pass "hack_skills" $KanehackVersion } else { Warn "hack_skills" "not found or older" "Offered below" }

# One unauthenticated request: 401 means the API is up and wants a token.
try {
  $r = Invoke-WebRequest -Uri "$Site/api/v1/kane/runs" -Method Get -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
  $code = [int]$r.StatusCode
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
}
if (@(200, 401, 403) -contains $code) { Pass "api" "$Site (HTTP $code)" } else { Fail "api" "HTTP $code" "Check your network; the web app is $Site" }

Write-Host ""
$bin = Join-Path $Prefix "bin"
$cmdShim = Join-Path $bin "kanehack.cmd"
$entry = Join-Path $Prefix "cli\node_modules\kanehack\bin\kanehack.mjs"
function InstalledVersion { if (Test-Path $entry) { try { (& node $entry version 2>$null | Select-Object -First 1) } catch { $null } } }
function WriteShims($dir) {
  # kanehack.cmd for PowerShell and cmd; an extensionless sh shim for Git Bash.
  Set-Content -Path (Join-Path $dir "kanehack.cmd") -Value "@echo off`r`nnode `"$entry`" %*" -Encoding ASCII
  $posix = $entry -replace '\\', '/'
  [IO.File]::WriteAllText((Join-Path $dir "kanehack"), "#!/bin/sh`nexec node `"$posix`" `"`$@`"`n")
}

$wantKh = $false; $wantSkills = $false; $khHave = $false
$cur = InstalledVersion
if ($cur -eq $KanehackVersion -and (Test-Path $cmdShim)) { $khHave = $true; Pass "kanehack" "$KanehackVersion already installed in $Prefix" }
elseif (-not ((Have node) -and (Have npm))) { Warn "kanehack" "not installed" "Install Node (with npm) first, then re-run this script" }
elseif ($cur -and (Ask "Upgrade the kanehack helper in $Prefix from $cur to $KanehackVersion (no admin)?")) { $wantKh = $true }
elseif (-not $cur -and (Ask "Install the kanehack helper $KanehackVersion into $Prefix (no admin)?")) { $wantKh = $true }
else { Warn "kanehack" "skipped" "Re-run this script when you're ready" }

if ($needSkills) {
  if ($NoSkills) { Warn "hack_skills" "skipped (-NoSkills)" "Re-run without -NoSkills to add them" }
  elseif (Ask "Install the Kane Hack OS skills (hack-os, hack-gtm) into $($skillDirs -join ', ')?") { $wantSkills = $true }
  else { Warn "hack_skills" "skipped" "Re-run this script when you're ready" }
}

if ($wantKh -or $wantSkills) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("kanehack-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $bad = $false
    $tgz = Join-Path $tmp "kanehack-$KanehackVersion.tgz"
    $stgz = Join-Path $tmp "hack-skills-$KanehackVersion.tgz"
    foreach ($job in @(@($wantKh, "kanehack", "$Site/kanehack-$KanehackVersion.tgz", $tgz, $KanehackSha256), @($wantSkills, "hack_skills", "$Site/hack-skills-$KanehackVersion.tgz", $stgz, $SkillsSha256))) {
      if (-not $job[0]) { continue }
      # Venue Wi-Fi drops requests: try three times before calling it a failure.
      $ok = $false
      foreach ($try in 1..3) {
        try { Invoke-WebRequest -Uri $job[2] -OutFile $job[3] -UseBasicParsing -TimeoutSec 60; $ok = $true; break } catch { if ($try -lt 3) { Start-Sleep -Seconds 2 } }
      }
      if (-not $ok) { Fail $job[1] "download failed" "Check your network and re-run ($($job[2]))"; $bad = $true; continue }
      $got = (Get-FileHash -Algorithm SHA256 $job[3]).Hash.ToLower()
      if ($got -ne $job[4]) { Fail $job[1] "checksum mismatch" "Don't use this download; tell the help desk (got $got)"; $bad = $true }
    }
    if ($bad) { Write-Host "Nothing was installed." -ForegroundColor Red; throw "kanehack installer: a download failed its check; nothing was installed." }
    if ($wantKh) {
      New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "cli"), $bin | Out-Null
      $npmLog = Join-Path $tmp "npm.log"
      & npm install --silent --no-audit --no-fund --prefix (Join-Path $Prefix "cli") $tgz *> $npmLog
      if ($LASTEXITCODE -ne 0) { Get-Content $npmLog | Write-Host; Fail "kanehack" "npm install failed" "See the npm output above, or ask at the help desk"; throw "kanehack installer: npm install failed." }
      WriteShims $bin
      $khHave = $true
      Pass "kanehack" "$KanehackVersion → $cmdShim (sha256 verified)"
    }
    if ($wantSkills) {
      # tar.exe ships with Windows 10 1803+. Only hack-os and hack-gtm are written. The old bundle's 12
      # folders go first, and only when its marker says we installed them: its hack-gtm is one of them.
      foreach ($d in $skillDirs) {
        if (Test-Path (Join-Path $d "hack-onboard\.bundle-version")) {
          foreach ($s in $OldSkills) { $p = Join-Path $d $s; if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
        }
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        tar -xzf $stgz -C $d
        if ($LASTEXITCODE -ne 0) { Fail "hack_skills" "tar failed in $d" "Ask at the help desk"; throw "kanehack installer: tar failed." }
        Set-Content -Path (Join-Path $d "hack-os\.bundle-version") -Value $KanehackVersion -Encoding ASCII
      }
      Pass "hack_skills" "hack-os, hack-gtm → $($skillDirs -join ', ') (sha256 verified). Start a new Codex session to load it."
      # Only the old 12. Checked now, not from $hasLegacy: when .codex\skills is the same folder as
      # .agents\skills the loop has already removed the marker, so the fresh hack-gtm stays.
      if (Test-Path (Join-Path $legacySkills "hack-onboard\.bundle-version")) {
        foreach ($s in $OldSkills) { $p = Join-Path $legacySkills $s; if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
        Pass "codex_skills" "removed the old copies in $legacySkills (Codex reads .agents\skills; two copies listed each skill twice)"
      }
    }
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

# Point kanehack at this server when it isn't the default one.
if ($khHave -and $Site -ne $DefaultSite -and $Site -ne "https://kaneclihack.sh") {
  $cfgPath = Join-Path $Prefix "config.json"
  $cfg = @{}
  if (Test-Path $cfgPath) { try { $o = Get-Content $cfgPath -Raw | ConvertFrom-Json; foreach ($p in $o.PSObject.Properties) { $cfg[$p.Name] = $p.Value } } catch {} }
  $cfg["api"] = $Site
  [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json))
  Pass "server" "kanehack will talk to $Site"
}

# Make `kanehack` a command: a shim in npm's global folder (already on PATH), never replacing
# a different kanehack; else offer to add .kanehack\bin to the user PATH.
$kh = "& `"$cmdShim`""
function OnPath($dir) { [bool]($env:PATH -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ieq $dir.TrimEnd("\")) }) }
function IsOurs($path) {
  if (-not $path -or -not (Test-Path $path)) { return $false }
  if ((Split-Path $path -Parent).TrimEnd("\") -ieq $bin.TrimEnd("\")) { return $true }
  try { return ((Get-Content $path -Raw) -like "*$entry*") } catch { return $false }
}
function Writable($dir) {
  try { $t = Join-Path $dir (".kanehack-write-test-" + [guid]::NewGuid()); [IO.File]::WriteAllText($t, ""); Remove-Item $t -Force; return $true } catch { return $false }
}
if ($khHave -and (Test-Path $cmdShim)) {
  $found = Get-Command kanehack -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  $linked = $false; $conflict = $false
  if ($found -and (IsOurs $found.Source)) { $kh = "kanehack"; $linked = $true; Pass "command" "kanehack → $($found.Source)" }
  elseif ($NoPath) { Write-Host "-NoPath: kanehack is not linked; use the full path below." }
  elseif ($found) { $conflict = $true; Warn "command" "another kanehack is on PATH" "$($found.Source) isn't this install; left alone (PATH not changed). Use the full path below" }
  else {
    $npmDir = $null
    if (Have npm) { try { $npmDir = (& npm prefix -g 2>$null | Select-Object -First 1) } catch {} }
    if ($npmDir -and (Test-Path $npmDir) -and (OnPath $npmDir) -and (Writable $npmDir) -and -not (Test-Path (Join-Path $npmDir "kanehack.cmd"))) {
      if (Ask "Make ``kanehack`` a command (shim in $npmDir)?") {
        WriteShims $npmDir
        $kh = "kanehack"; $linked = $true
        Pass "command" "kanehack → $(Join-Path $npmDir 'kanehack.cmd') (works in this window now)"
      }
    } else { Write-Host "npm's global folder isn't on PATH or isn't writable; offering the user PATH instead." }
  }
  if (-not $linked -and -not $NoPath -and -not $conflict -and -not (OnPath $bin)) {
    if (Ask "Add $bin to your user PATH?") {
      $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
      if (-not (($userPath -split ";") -contains $bin)) { [Environment]::SetEnvironmentVariable("Path", (@($bin, $userPath) | Where-Object { $_ }) -join ";", "User") }
      $env:PATH = "$bin;$env:PATH"
      $kh = "kanehack"
      Pass "path" "added (this window and new ones)"
    } else {
      Write-Host "kanehack isn't on your PATH. Use the full path below, or run: `$env:PATH = `"$bin;`$env:PATH`"" -ForegroundColor Yellow
    }
  } elseif (-not $linked -and (OnPath $bin)) { $kh = "kanehack" }
}

# Connect Codex to the event MCP server. kanehack does the editing (and backs up config.toml
# first). Codex's config gets the URL plus `kanehack mcp-headers`, which prints the auth header
# when Codex connects: the token is never written there or printed here.
# A different server with that name is left alone.
$agentsShown = $false
function ConnectAgent($agent, $label, $where) {
  # Native stderr must not become a terminating error here (Windows PowerShell 5.1).
  $ErrorActionPreference = "Continue"
  & node $entry connect $agent --check *> $null
  $rc = $LASTEXITCODE
  if ($rc -eq 0) { Pass "$($agent)_mcp" "$label already connected to the event server (kane-hack-event)"; return }
  if ($rc -eq 2) { Warn "$($agent)_mcp" "another kane-hack-event server is configured; left alone" "Run $kh connect $agent to see it"; return }
  if (Ask "Connect $label to the event server (adds kane-hack-event to $where; no token is stored)?") {
    & node $entry connect $agent
    if ($LASTEXITCODE -eq 0) { Pass "$($agent)_mcp" "$label -> kane-hack-event (pair, then start a new $label session)" }
    else { Warn "$($agent)_mcp" "not connected" "$kh connect $agent" }
  } else { Warn "$($agent)_mcp" "not connected" "$kh connect $agent" }
}
if (-not $NoAgents) {
  $khReady = $khHave -and (Test-Path $entry)
  if ((Have codex) -or (Test-Path $CodexDir)) {
    $agentsShown = $true
    if ($khReady) { ConnectAgent "codex" "Codex" (Join-Path $CodexDir "config.toml") }
    else { Warn "codex_mcp" "not connected" "Install kanehack first (re-run this script), then: kanehack connect codex" }
  }
}

Write-Host "`nNext, in this terminal:"
Write-Host "  1. $kh pair        link this machine to your passport (approve the code it shows in your browser)"
Write-Host "  2. $kh doctor      re-check your setup"
Write-Host "  3. $kh report -- kane-cli run `"Open $Site and find the schedule`" --agent"
Write-Host "     (your first Kane run, sent to your team's Proof tab)"
if ($agentsShown) { Write-Host 'Then in Codex: start a new session and type $hack-os' }
Write-Host "Web: $Site/passport"
if ($script:NoTtySkips -gt 0) {
  $siteArg = if ($Site -ne $DefaultSite) { " -Site $Site" } else { "" }
  Write-Host ""
  Write-Host "There was no terminal to ask, so $($script:NoTtySkips) install step(s) were skipped. To install without prompts, run:" -ForegroundColor Yellow
  Write-Host "  & ([scriptblock]::Create((irm $Site/install.ps1))) -Yes$siteArg"
}
if ($script:Failed) { Write-Host "Some checks failed. Fix them with the commands above, or ask at the help desk." -ForegroundColor Yellow }
