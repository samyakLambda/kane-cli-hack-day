import "server-only";
import { del } from "@vercel/blob";
import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import { getEvent, isLocked } from "@/lib/event";
import { normalizeX } from "@/lib/photos";
import { getMemberById, type MemberRow } from "./auth";
import { AppError, maskEmail, sha256, transaction, withAudit, writeAudit, z, type Actor } from "./core";
import { checkSignature, shortName, signValue } from "./pairing";

// The Hacker Passport (T-PASS-01..06, T-AUTH-05/06): one person's event
// identity and next step. Two DTOs, built server-side:
//   PrivatePassport  the member themselves (and organizer staff)
//   PublicPassport   anyone holding the badge QR: no email, no P-code, no
//                    private idea text; portrait/handles only when consented.
// Consents are append-only rows (member_consents); revoking selfie storage
// deletes the selfie. participant_state picks the single next mission.

export const EDITION = "KH/26";

// ── Consents ─────────────────────────────────────────────────────────────────

export const CONSENT_CATEGORIES = [
  "selfie_storage",
  "photo_publication",
  "face_matching",
  "social_mention",
  "teammate_discovery",
  "idea_discovery",
  "activity_publication",
] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
export const POLICY_VERSION = "2026-10";

/** Plain-language copy for each toggle (also the paper form, fallback/02). */
export const CONSENT_COPY: Record<ConsentCategory, { label: string; description: string }> = {
  selfie_storage: {
    label: "Store my selfie for my passport",
    description: "Kept privately for the event, shown only to you and staff. Deleted after the event or as soon as you switch this off.",
  },
  photo_publication: {
    label: "Allow public team and event photos of me",
    description: "Every photo is reviewed by a person before it goes anywhere public. Off means your image is never published.",
  },
  face_matching: {
    label: "Match event photos to my selfie",
    description: "Lets us find you in event photos so you get them. Needs a stored selfie. No matching without this.",
  },
  social_mention: {
    label: "Mention my X handle in approved official posts",
    description: "Only in posts an organizer approves. Off means we never tag you.",
  },
  teammate_discovery: {
    label: "Show me in teammate matching",
    description: "Your short name, skills and interests appear to other builders looking for a team.",
  },
  idea_discovery: {
    label: "Share my team’s short idea summary for matching",
    description: "Only the public summary, never the private description. Off keeps the idea private to your team.",
  },
  activity_publication: {
    label: "Show my verified activity on the live wall",
    description: "Verified milestones under your short name. Off keeps your activity inside your team.",
  },
};

export type Consents = Record<ConsentCategory, boolean | null>;

export async function getConsents(memberId: number, db: Pick<PoolClient, "query"> | null = null): Promise<Consents> {
  const sql = "select category, granted from member_consent_current where member_id = $1";
  const rows = db ? (await db.query<{ category: ConsentCategory; granted: boolean }>(sql, [memberId])).rows : await query<{ category: ConsentCategory; granted: boolean }>(sql, [memberId]);
  const out = Object.fromEntries(CONSENT_CATEGORIES.map((c) => [c, null])) as Consents;
  for (const r of rows) out[r.category] = r.granted;
  return out;
}

export const consentSchema = z.object(Object.fromEntries(CONSENT_CATEGORIES.map((c) => [c, z.boolean().optional()])) as Record<ConsentCategory, z.ZodOptional<z.ZodBoolean>>);
export type ConsentChanges = Partial<Record<ConsentCategory, boolean>>;

/**
 * Append a row for each category whose value actually changes (never
 * updates). Revoking selfie_storage also retires the stored selfie (and face
 * matching with it). Run inside the caller's transaction; returns the blob
 * keys to delete once that transaction commits.
 */
export async function appendConsents(tx: PoolClient, memberId: number, changes: ConsentChanges, source: "web" | "mcp" | "staff" | "paper") {
  const current = await getConsents(memberId, tx);
  const next = { ...changes };
  if (next.selfie_storage === false && current.face_matching) next.face_matching = false;
  const changed = (Object.entries(next) as [ConsentCategory, boolean | undefined][]).filter(([c, v]) => v !== undefined && current[c] !== v) as [ConsentCategory, boolean][];
  for (const [category, granted] of changed) {
    await tx.query("insert into member_consents (member_id, category, granted, policy_version, source) values ($1, $2, $3, $4, $5)", [
      memberId,
      category,
      granted,
      POLICY_VERSION,
      source,
    ]);
  }
  // Keep the legacy 004 column in step for code that still reads it.
  if (next.photo_publication !== undefined) await tx.query("update members set consent_social = $2, consent_at = now() where id = $1", [memberId, next.photo_publication]);
  let deleteKeys: string[] = [];
  if (next.selfie_storage === false) {
    const { rows } = await tx.query<{ object_key: string }>("update selfies set deleted_at = now() where member_id = $1 and deleted_at is null returning object_key", [memberId]);
    deleteKeys = rows.map((r) => r.object_key);
  }
  return { changed: Object.fromEntries(changed) as ConsentChanges, deleteKeys };
}

/** Best-effort removal from Blob after the DB says the selfie is gone. */
export async function deleteBlobs(keys: string[]) {
  if (!keys.length) return;
  await del(keys).catch((e) => console.error("[passport] selfie blob delete failed; retention job will retry", e));
}

// ── Profile (participants/me PATCH) ─────────────────────────────────────────

const tags = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")))
  .transform((a) => [...new Set(a.map((s) => s.trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean))].slice(0, 12))
  .pipe(z.array(z.string().max(32)));

export const profileSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  x_handle: z.string().trim().max(60).optional(),
  github_handle: z
    .string()
    .trim()
    .max(39)
    .regex(/^$|^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/, "Not a GitHub username")
    .optional(),
  skills: tags.optional(),
  interests: tags.optional(),
  consents: consentSchema.optional(),
});
export type ProfilePatch = z.infer<typeof profileSchema>;

/** Profile fields + consent changes in one transaction and one audit row. */
export async function updateProfile(member: MemberRow, actor: Actor, patch: ProfilePatch, source: "web" | "mcp") {
  let x: string | null | undefined;
  if (patch.x_handle !== undefined) {
    const n = normalizeX(patch.x_handle);
    if (n === null) throw new AppError("VALIDATION_FAILED", { userMessage: "That doesn’t look like an X handle." });
    x = n || null;
  }
  let toDelete: string[] = [];
  const out = await withAudit(actor, "participant.update", "member", async (tx) => {
    const sets: string[] = [];
    const vals: unknown[] = [member.id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.display_name !== undefined) set("display_name", patch.display_name);
    if (x !== undefined) set("x_handle", x);
    // A typed handle is unverified; GitHub OAuth (member_identities) is what verifies it.
    if (patch.github_handle !== undefined) set("github_handle", patch.github_handle || null);
    if (patch.skills !== undefined) set("skills", patch.skills);
    if (patch.interests !== undefined) set("interests", patch.interests);
    if (sets.length) await tx.query(`update members set ${sets.join(", ")} where id = $1`, vals);
    const c = patch.consents ? await appendConsents(tx, member.id, patch.consents, source) : { changed: {}, deleteKeys: [] };
    toDelete = c.deleteKeys;
    const fields = Object.keys(patch).filter((k) => k !== "consents");
    return { result: { id: member.id, fields, consents_changed: c.changed }, resourceId: member.id, payload: { fields, consents_changed: c.changed } };
  });
  await deleteBlobs(toDelete);
  // A "no" to photo publication or face matching holds this person's photos
  // and drops unconfirmed matches right away (judge-photo's hook).
  const cc = out.consents_changed as ConsentChanges;
  if (cc.photo_publication === false || cc.face_matching === false || cc.selfie_storage === false) {
    const { onConsentChanged } = await import("./photos");
    await onConsentChanged(member.id).catch(() => 0);
  }
  return out;
}

// ── Participant state and the next mission ───────────────────────────────────

export type ParticipantState =
  | "needs_activation"
  | "awaiting_selfie"
  | "help_pending"
  | "needs_team"
  | "needs_idea"
  | "needs_kane_run"
  | "submission_due"
  | "submission_locked"
  | "shipped";

export type Mission = {
  state: ParticipantState;
  eyebrow: string;
  title: string;
  body: string;
  action: { id: string; label: string; href: string };
  secondary?: { id: string; label: string; href: string }[];
  /** amber when someone is waiting on a human or a deadline. */
  tone: "accent" | "pending" | "verified";
};

// ── Private passport ────────────────────────────────────────────────────────

export type ActivationSummary = {
  id: number;
  status: string;
  receipt_code: string | null;
  receipt_at: Date | null;
  /** Kane run B id, if the controller reported one. */
  kane_run_id: string | null;
  /** True only when that run is in kane_runs with source_verified. */
  kane_verified: boolean;
};

export type PrivatePassport = {
  member: {
    id: number;
    name: string;
    short_name: string;
    display_name: string | null;
    public_code: string | null;
    role: string;
    email_hint: string;
    github_handle: string | null;
    github_verified: boolean;
    x_handle: string | null;
    skills: string[];
    interests: string[];
    checked_in_at: Date | null;
    activated_at: Date | null;
    admission_state: string;
    has_password: boolean;
  };
  consents: Consents;
  portrait: { src: string; captured_at: Date } | null;
  activation: ActivationSummary | null;
  team: { id: number; name: string; slug: string; size: number; is_solo: boolean; role: "captain" | "member"; ship: { slug: string; public: boolean } | null } | null;
  idea: { qualification: string; status: string; has_text: boolean } | null;
  kane_runs: number;
  help: { code: string; status: string } | null;
  submission: { status: string; receipt_code: string | null; finalized_at: Date | null } | null;
  readiness: { at: Date; passed: number; failed: number; warned: number } | null;
  /** Approved milestones of the team's project, newest first. */
  milestones: { title: string; confidence: "verified" | "participant_reported" | "inferred" }[];
  stage: "solo" | "member" | "shipped";
  state: ParticipantState;
  mission: Mission;
  edition: string;
  server_time: Date;
};

type MemberExtra = {
  email: string;
  skills: string[];
  interests: string[];
  github_handle: string | null;
  x_handle: string | null;
  admission_state: string;
  has_password: boolean;
  is_solo: boolean | null;
  team_name: string | null;
  team_slug: string | null;
  team_size: number | null;
  captain: boolean;
};

/** Everything the passport page, /participants/me and NextMissionCard need, in one read. */
export async function getPassport(memberId: number): Promise<PrivatePassport> {
  const m = await getMemberById(memberId);
  if (!m) throw new AppError("NOT_FOUND");
  const [extraRows, consents, selfie, activation, gh, idea, kane, help, sub, ready, ev] = await Promise.all([
    query<MemberExtra>(
      `select m.email, m.skills, m.interests, m.github_handle, m.x_handle, m.admission_state, (m.password_hash is not null) as has_password,
              t.is_solo, t.name as team_name, t.slug as team_slug,
              (select count(*)::int from members x where x.team_id = t.id and x.deleted_at is null) as team_size,
              coalesce(t.captain_id = m.id, false) as captain
         from members m left join teams t on t.id = m.team_id where m.id = $1`,
      [memberId],
    ),
    getConsents(memberId),
    query<{ captured_at: Date }>("select captured_at from selfies where member_id = $1 and deleted_at is null", [memberId]),
    getActivationSummary(memberId),
    query<{ handle: string }>("select handle from member_identities where member_id = $1 and provider = 'github' and verified_at is not null limit 1", [memberId]),
    m.team_id
      ? query<{ qualification: string; status: string; has_text: boolean }>(
          "select qualification, status, (length(trim(private_description)) > 0 or public_summary is not null) as has_text from ideas where team_id = $1",
          [m.team_id],
        )
      : Promise.resolve([]),
    m.team_id ? query<{ n: number }>("select count(*)::int as n from kane_runs where team_id = $1", [m.team_id]) : Promise.resolve([{ n: 0 }]),
    query<{ code: string; status: string }>(
      `select code, status from help_tickets
        where (member_id = $1 or ($2::bigint is not null and team_id = $2)) and status in ('new','triaged','claimed','in_progress','escalated')
        order by created_at desc limit 1`,
      [memberId, m.team_id],
    ),
    m.team_id
      ? query<{ status: string; receipt_code: string | null; finalized_at: Date | null }>(
          `select status, receipt_code, finalized_at from submissions where team_id = $1 and status <> 'withdrawn' order by (status in ('finalized','locked','organizer_exception')) desc, id desc limit 1`,
          [m.team_id],
        )
      : Promise.resolve([]),
    query<{ at: Date; passed: number; failed: number; warned: number }>(
      "select created_at as at, passed, failed, warned from readiness_reports where member_id = $1 order by created_at desc limit 1",
      [memberId],
    ),
    getEvent(),
  ]);
  const x = extraRows[0];
  const ship = m.team_id ? (await query<{ id: number; slug: string; showcase_state: string }>("select id, slug, showcase_state from projects where team_id = $1", [m.team_id]))[0] : undefined;
  const milestones = ship
    ? await query<PrivatePassport["milestones"][number]>("select title, confidence from milestones where project_id = $1 and approved_at is not null order by approved_at desc limit 6", [ship.id])
    : [];

  const shipped = !!sub[0] && ["finalized", "locked", "organizer_exception"].includes(sub[0].status);
  const team = m.team_id && x.team_slug
    ? {
        id: m.team_id,
        name: x.team_name!,
        slug: x.team_slug,
        size: x.team_size ?? 1,
        is_solo: !!x.is_solo,
        role: (x.captain ? "captain" : "member") as "captain" | "member",
        ship: ship ? { slug: ship.slug, public: ship.showcase_state === "public" } : null,
      }
    : null;

  const base = {
    member: {
      id: m.id,
      name: m.name,
      short_name: shortName(m.display_name ?? m.name),
      display_name: m.display_name,
      public_code: m.public_code,
      role: m.role,
      email_hint: maskEmail(x.email),
      github_handle: gh[0]?.handle ?? x.github_handle,
      github_verified: !!gh[0],
      x_handle: x.x_handle,
      skills: x.skills ?? [],
      interests: x.interests ?? [],
      checked_in_at: m.checked_in_at,
      activated_at: m.activated_at,
      admission_state: x.admission_state,
      has_password: x.has_password,
    },
    consents,
    portrait: selfie[0] && consents.selfie_storage !== false ? { src: `/passport/portrait?m=${m.id}`, captured_at: selfie[0].captured_at } : null,
    activation,
    team,
    idea: idea[0] ?? null,
    kane_runs: kane[0]?.n ?? 0,
    help: help[0] ?? null,
    submission: sub[0] ?? null,
    readiness: ready[0] ?? null,
    milestones,
    stage: (shipped ? "shipped" : team && !team.is_solo ? "member" : "solo") as PrivatePassport["stage"],
    edition: EDITION,
    server_time: ev.now,
  };
  const submissionLocked = await isLocked("submission", ev);
  const ideaLocked = await isLocked("idea", ev);
  const state = deriveState({ ...base, shipped, submissionLocked, ideaLocked });
  return { ...base, state, mission: missionFor(state, base) };
}

/**
 * One next action, in priority order. Shipped beats everything; a person
 * waiting on the camera or a mentor comes next (someone is waiting on them,
 * or they on someone); then the build path: team → idea → Kane run → submit.
 */
export function deriveState(p: {
  shipped: boolean;
  activation: ActivationSummary | null;
  member: { activated_at: Date | null };
  help: { status: string } | null;
  team: unknown;
  idea: { qualification: string; has_text: boolean } | null;
  kane_runs: number;
  submissionLocked: boolean;
  ideaLocked: boolean;
}): ParticipantState {
  if (p.shipped) return "shipped";
  const st = p.activation?.status;
  if (st === "ready_for_camera" || st === "selfie_pending") return "awaiting_selfie";
  if (!p.member.activated_at && st !== "active") return "needs_activation";
  if (p.help) return "help_pending";
  if (!p.team) return "needs_team";
  if (!p.ideaLocked && (!p.idea || !p.idea.has_text || p.idea.qualification === "draft")) return "needs_idea";
  if (p.kane_runs === 0 && !p.submissionLocked) return "needs_kane_run";
  return p.submissionLocked ? "submission_locked" : "submission_due";
}

/** The card copy and actions for a state. Schema-driven: no generated code or text. */
export function missionFor(state: ParticipantState, p: Pick<PrivatePassport, "team" | "help">): Mission {
  const slug = p.team?.slug;
  const hub = (tab: string) => (slug ? `/t/${slug}/${tab}` : "/passport");
  switch (state) {
    case "needs_activation":
      return {
        state,
        tone: "accent",
        eyebrow: "Mission 01 · Activate",
        title: "Activate your passport",
        body: "Confirm your registration, choose what you share, and take an optional selfie. About two minutes.",
        action: { id: "activate", label: "Start activation", href: "/activate" },
        secondary: [{ id: "readiness", label: "Check Kane readiness", href: "/readiness" }],
      };
    case "awaiting_selfie":
      return {
        state,
        tone: "pending",
        eyebrow: "Waiting on you · Camera",
        title: "Your selfie step is open",
        body: "Only you can take it: press the shutter yourself, or skip it. Skipping never blocks anything.",
        action: { id: "selfie", label: "Open the camera step", href: "/activate" },
      };
    case "help_pending":
      return {
        state,
        tone: "pending",
        eyebrow: "Waiting on a mentor",
        title: `Help ticket ${p.help?.code ?? ""} is ${p.help?.status.replace("_", " ") ?? "open"}`,
        body: "A mentor has your ticket. Keep building; we’ll show the update here and in your hub.",
        action: { id: "show_ticket", label: "Show ticket", href: p.help ? `/help/${p.help.code}` : hub("help") },
        secondary: [{ id: "ask_mentor", label: "Ask a mentor", href: hub("help") }],
      };
    case "needs_team":
      return {
        state,
        tone: "accent",
        eyebrow: "Mission 02 · Team",
        title: "Find your crew, or go solo",
        body: "Teams of up to four. Join one with an invite, start your own, or browse builders looking for a team.",
        action: { id: "find_teammates", label: "Find teammates", href: "/match" },
        secondary: [
          { id: "create_team", label: "Create team", href: "/team" },
          { id: "join_team", label: "Join team", href: "/team" },
        ],
      };
    case "needs_idea":
      return {
        state,
        tone: "accent",
        eyebrow: "Mission 03 · Idea",
        title: "Validate your idea",
        body: "Run it past the eight-point checklist before the idea lock. The private description stays inside your team.",
        action: { id: "validate_idea", label: "Validate idea", href: hub("idea") },
      };
    case "needs_kane_run":
      return {
        state,
        tone: "accent",
        eyebrow: "Mission 04 · Proof",
        title: "Get your first Kane run on record",
        body: "Point Kane CLI at what you’re building. A failing run is a detection, not a verdict, and it still counts as proof of work.",
        action: { id: "open_project", label: "Open project proof", href: hub("proof") },
        secondary: [
          { id: "setup_agent", label: "Set up your agent", href: "/setup" },
          { id: "readiness", label: "Check Kane readiness", href: "/readiness" },
        ],
      };
    case "submission_due":
      return {
        state,
        tone: "pending",
        eyebrow: "Mission 05 · Ship",
        title: "Submit before the lock",
        body: "Preflight your repo, commit and Kane evidence, then finalize. The server clock decides the deadline.",
        action: { id: "submit", label: "Open submission", href: hub("submit") },
        secondary: [{ id: "open_project", label: "Open project", href: hub("") }],
      };
    case "submission_locked":
      return {
        state,
        tone: "pending",
        eyebrow: "Submissions locked",
        title: "The submission window has closed",
        body: "If an outage blocked you, the help desk can write a manual receipt with the real time.",
        action: { id: "ask_mentor", label: "Go to the help desk", href: hub("help") },
      };
    case "shipped":
      return {
        state,
        tone: "verified",
        eyebrow: "Shipped",
        title: "You shipped. Nice.",
        body: "Your receipt is on file. Polish the showcase and get ready for demos.",
        action: { id: "open_project", label: "Open showcase", href: slug ? `/ship/${slug}` : "/ship" },
        secondary: [{ id: "studio", label: "Open studio", href: slug ? `/studio/${slug}` : "/passport" }],
      };
  }
}

export async function getActivationSummary(memberId: number): Promise<ActivationSummary | null> {
  const [row] = await query<ActivationSummary & { verified: boolean }>(
    `select a.id, a.status, a.receipt_code, a.kane_run_id,
            (select c.created_at from activation_checkpoints c where c.activation_id = a.id and c.checkpoint = 'active' order by c.id limit 1) as receipt_at,
            exists (select 1 from kane_runs k where a.kane_run_id is not null and k.upstream_execution_id = a.kane_run_id and k.source_verified) as kane_verified
       from activation_sessions a
      where a.member_id = $1 and a.status <> 'expired'
      order by (a.status = 'active') desc, a.created_at desc limit 1`,
    [memberId],
  );
  return row ? { id: row.id, status: row.status, receipt_code: row.receipt_code, receipt_at: row.receipt_at, kane_run_id: row.kane_run_id, kane_verified: row.kane_verified } : null;
}

// ── Public passport (badge QR) ──────────────────────────────────────────────

export type PublicPassport = {
  short_name: string;
  role_tag: "BUILDER" | "MENTOR" | "JUDGE" | "PHOTOGRAPHER" | "ORGANIZER";
  edition: string;
  team: { name: string; ship_href: string | null } | null;
  skills: string[];
  interests: string[];
  github: string | null;
  x: string | null;
  portrait_src: string | null;
  activated: boolean;
  kane_verified: boolean;
};

const ROLE_TAG: Record<string, PublicPassport["role_tag"]> = {
  participant: "BUILDER",
  mentor: "MENTOR",
  judge: "JUDGE",
  photographer: "PHOTOGRAPHER",
  organizer: "ORGANIZER",
  admin: "ORGANIZER",
};

/** The public face of a passport. Built from the private one by allow-list, never by hiding fields. */
export function toPublicPassport(p: PrivatePassport): PublicPassport {
  const c = p.consents;
  return {
    short_name: p.member.short_name,
    role_tag: ROLE_TAG[p.member.role] ?? "BUILDER",
    edition: p.edition,
    team: p.team && !p.team.is_solo ? { name: p.team.name, ship_href: p.team.ship?.public ? `/ship/${p.team.ship.slug}` : null } : null,
    skills: c.teammate_discovery ? p.member.skills : [],
    interests: c.teammate_discovery ? p.member.interests : [],
    github: c.teammate_discovery && p.member.github_verified ? p.member.github_handle : null,
    x: c.social_mention ? p.member.x_handle : null,
    portrait_src: p.portrait && c.photo_publication && c.selfie_storage ? p.portrait.src : null,
    activated: p.activation?.status === "active",
    kane_verified: !!p.activation?.kane_verified,
  };
}

// ── Badge QR tokens (signed, revocable, rotatable; no PII) ──────────────────

// Token = "khb_<row id>.<HMAC(row id:member id)>". The row (member_tokens,
// kind 'badge') stores only its hash, so a leaked badge is revoked by revoking
// the row; rotating issues a new row. The token is recomputable from the row,
// so a reprint shows the same QR until someone rotates it.

function badgeToken(rowId: number, memberId: number) {
  return `khb_${rowId}.${signValue("badge", `${rowId}:${memberId}`)}`;
}

async function insertBadge(tx: PoolClient, memberId: number) {
  const ev = await getEvent();
  const expires = new Date(ev.endsAt.getTime() + 2 * 86_400_000);
  const { rows } = await tx.query<{ id: number }>(
    `insert into member_tokens (member_id, kind, token_hash, label, scopes, expires_at)
     values ($1, 'badge', 'pending:' || gen_random_uuid(), 'badge', '{checkin}', $2) returning id`,
    [memberId, expires],
  );
  const token = badgeToken(rows[0].id, memberId);
  await tx.query("update member_tokens set token_hash = $2 where id = $1", [rows[0].id, sha256(token)]);
  return { id: rows[0].id, token };
}

/** The member's current badge token, issuing one if none is live. */
export async function getBadgeToken(memberId: number, actor: Actor) {
  const [live] = await query<{ id: number }>(
    "select id from member_tokens where member_id = $1 and kind = 'badge' and revoked_at is null and expires_at > now() order by id desc limit 1",
    [memberId],
  );
  if (live) return { id: live.id, token: badgeToken(live.id, memberId) };
  return transaction(async (tx) => {
    // Serialise per member so two tabs don't mint two badges.
    await tx.query("select id from members where id = $1 for update", [memberId]);
    const { rows } = await tx.query<{ id: number }>(
      "select id from member_tokens where member_id = $1 and kind = 'badge' and revoked_at is null and expires_at > now() order by id desc limit 1",
      [memberId],
    );
    if (rows[0]) return { id: rows[0].id, token: badgeToken(rows[0].id, memberId) };
    const b = await insertBadge(tx, memberId);
    await writeAudit(actor, { action: "badge.issue", resourceType: "member_token", resourceId: b.id, payload: { member_id: memberId } }, tx);
    return b;
  });
}

/** Revoke every live badge for the member and issue a fresh one (a leaked or lost badge). */
export async function rotateBadgeToken(memberId: number, actor: Actor) {
  return transaction(async (tx) => {
    await tx.query("select id from members where id = $1 for update", [memberId]);
    await tx.query("update member_tokens set revoked_at = now() where member_id = $1 and kind = 'badge' and revoked_at is null", [memberId]);
    const b = await insertBadge(tx, memberId);
    await writeAudit(actor, { action: "badge.rotate", resourceType: "member_token", resourceId: b.id, payload: { member_id: memberId } }, tx);
    return b;
  });
}

/** Revoke without reissuing (staff, for a badge that must stop working now). */
export async function revokeBadgeTokens(memberId: number, actor: Actor) {
  await withAudit(actor, "badge.revoke", "member", async (tx) => {
    const { rowCount } = await tx.query("update member_tokens set revoked_at = now() where member_id = $1 and kind = 'badge' and revoked_at is null", [memberId]);
    return { result: rowCount ?? 0, resourceId: memberId };
  });
}

export type BadgeLookup = { status: "ok"; memberId: number } | { status: "revoked" | "expired" | "invalid" };

/** Scan → member. Bad signature, revoked or expired all fail closed. */
export async function resolveBadgeToken(token: string): Promise<BadgeLookup> {
  const m = /^khb_(\d+)\.([\w-]{20,})$/.exec(token.trim());
  if (!m) return { status: "invalid" };
  const [row] = await query<{ member_id: number; revoked: boolean; expired: boolean }>(
    "select member_id, (revoked_at is not null) as revoked, (expires_at <= now()) as expired from member_tokens where id = $1 and kind = 'badge'",
    [Number(m[1])],
  );
  if (!row || !checkSignature("badge", `${m[1]}:${row.member_id}`, m[2])) return { status: "invalid" };
  if (row.revoked) return { status: "revoked" };
  if (row.expired) return { status: "expired" };
  await query("update member_tokens set last_used_at = now() where id = $1", [Number(m[1])]);
  return { status: "ok", memberId: row.member_id };
}

// ── Readiness (hack-doctor) ─────────────────────────────────────────────────

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type ReadinessCheckDef = { id: string; label: string; command?: string; fix: string; tier: "core" | "kane" | "agent" };

/** The doctor's checklist and the exact fix for each failure (T-ACT-08). */
export const READINESS_CHECKS: ReadinessCheckDef[] = [
  { id: "os_arch", label: "OS and architecture", command: "uname -sm", tier: "core", fix: "Any recent macOS, Windows 11 or Linux (x64 or arm64) works. On Windows, use PowerShell or WSL." },
  { id: "node", label: "Node.js 20 or newer", command: "node --version", tier: "core", fix: "Install Node 20 LTS from nodejs.org (or `nvm install 20`), then open a new terminal." },
  { id: "git", label: "Git", command: "git --version", tier: "core", fix: "macOS: `xcode-select --install`. Windows: install Git for Windows. Linux: your package manager." },
  { id: "chrome", label: "Google Chrome", tier: "core", fix: "Install Chrome. Kane drives a real Chrome window on your machine." },
  { id: "codex", label: "Codex", command: "codex --version", tier: "agent", fix: "Install the Codex CLI with `npm i -g @openai/codex`, or use Codex in the ChatGPT desktop app." },
  { id: "kane_version", label: "Kane CLI installed", command: "kane-cli --version", tier: "kane", fix: "`npm install -g @testmuai/kane-cli@rc` (the hackathon runs on the release candidate, 0.10.0-rc or newer), then open a new terminal and re-run `kane-cli --version`." },
  { id: "kane_whoami", label: "Kane CLI signed in", command: "kane-cli whoami", tier: "kane", fix: "Run `kane-cli login --oauth` and finish the sign-in in the browser, then re-run `kane-cli whoami`." },
  { id: "kane_skill", label: "Official Kane skill installed", command: "kane-cli install codex", tier: "agent", fix: "Run `kane-cli install codex` so Codex knows how to call Kane." },
  { id: "plugin_discovery", label: "Event skills found in a fresh session", tier: "agent", fix: "Open a new agent session and ask it to run hack-doctor. If it can’t find it, copy the event skills into .agents/skills in your repo." },
  { id: "api_reachability", label: "Event API reachable", tier: "core", fix: "Check your network or VPN, then open https://kaneclihack.sh/api/v1/readiness in a browser. Venue Wi-Fi details are on the help desk sign." },
  { id: "browser_test", label: "Kane browser test", command: 'kane-cli run "Open https://kaneclihack.sh and check the page title mentions Kane" --agent', tier: "kane", fix: "Make sure Chrome is installed and Kane is signed in, then run the browser test again. Ask a mentor if it still fails." },
];
const CHECK_IDS = new Set(READINESS_CHECKS.map((c) => c.id));

export const readinessSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().trim().max(40),
        status: z.enum(["pass", "warn", "fail", "skip"]),
        detail: z.string().trim().max(300).optional(),
        version: z.string().trim().max(60).optional(),
      }),
    )
    .max(30),
  client: z
    .object({ os: z.string().max(40).optional(), arch: z.string().max(20).optional(), kanehack_version: z.string().max(30).optional(), agent: z.string().max(40).optional() })
    .partial()
    .optional(),
  idempotency_key: z.string().trim().min(8).max(200).optional(),
});
export type ReadinessInput = z.infer<typeof readinessSchema>;

export type ReadinessCheckResult = { id: string; label: string; status: CheckStatus; detail: string | null; version: string | null; fix: string | null; command: string | null; observed_by_server: boolean };

/**
 * Record a readiness report. Partial reports are fine (unknown checks are
 * dropped, missing ones stay "not reported"). For a CLI report the server saw
 * the request arrive, so api_reachability is recorded as server-observed.
 */
export async function recordReadiness(member: MemberRow, actor: Actor, input: ReadinessInput, source: "cli" | "web", tokenId: number | null) {
  const checks = input.checks.filter((c) => CHECK_IDS.has(c.id));
  const dedup = new Map(checks.map((c) => [c.id, c]));
  if (source === "cli") dedup.set("api_reachability", { id: "api_reachability", status: "pass", detail: "Server received this report" });
  const list = [...dedup.values()];
  const count = (s: CheckStatus) => list.filter((c) => c.status === s).length;
  return withAudit(actor, "readiness.report", "readiness_report", async (tx) => {
    const { rows } = await tx.query<{ id: number; created_at: Date }>(
      `insert into readiness_reports (member_id, token_id, source, client, checks, passed, failed, warned, idempotency_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (member_id, idempotency_key) where idempotency_key is not null do update set idempotency_key = excluded.idempotency_key
       returning id, created_at`,
      [member.id, tokenId, source, JSON.stringify(input.client ?? {}), JSON.stringify(list), count("pass"), count("fail"), count("warn"), input.idempotency_key ?? null],
    );
    return { result: { id: rows[0].id, created_at: rows[0].created_at }, resourceId: rows[0].id, payload: { source, passed: count("pass"), failed: count("fail") } };
  });
}

export type ReadinessView = {
  at: Date | null;
  source: string | null;
  client: Record<string, string>;
  checks: ReadinessCheckResult[];
  passed: number;
  failed: number;
  warned: number;
  missing: number;
};

/** The latest report per check across the member's reports (newest wins), with fixes for anything not passing. */
export async function getReadiness(memberId: number): Promise<ReadinessView> {
  const reports = await query<{ created_at: Date; source: string; client: Record<string, string>; checks: { id: string; status: CheckStatus; detail?: string; version?: string }[] }>(
    "select created_at, source, client, checks from readiness_reports where member_id = $1 order by created_at desc limit 20",
    [memberId],
  );
  const latest = new Map<string, { status: CheckStatus; detail?: string; version?: string; source: string }>();
  for (const r of reports) for (const c of r.checks) if (!latest.has(c.id)) latest.set(c.id, { ...c, source: r.source });
  const checks: ReadinessCheckResult[] = READINESS_CHECKS.map((def) => {
    const got = latest.get(def.id);
    return {
      id: def.id,
      label: def.label,
      status: got?.status ?? "skip",
      detail: got ? (got.detail ?? null) : null,
      version: got?.version ?? null,
      fix: got?.status === "pass" ? null : def.fix,
      command: def.command ?? null,
      observed_by_server: def.id === "api_reachability" && got?.source === "cli" && got.status === "pass",
    };
  });
  return {
    at: reports[0]?.created_at ?? null,
    source: reports[0]?.source ?? null,
    client: reports[0]?.client ?? {},
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    warned: checks.filter((c) => c.status === "warn").length,
    missing: checks.filter((c) => !latest.has(c.id)).length,
  };
}

