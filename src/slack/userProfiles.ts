import { and, eq, inArray } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { installations, slackUserProfiles } from "../db/schema.js";

export interface ResolvedProfile {
  displayName: string | null;
  avatarUrl: string | null;
}

const POSITIVE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — names/avatars change rarely

// "This token fundamentally can't call this method" — workspace-wide, not per-user. missing_scope
// is exactly what today's installed token hits until a human completes the Slack app reinstall.
const AUTH_CLASS_ERROR_CODES = new Set([
  "missing_scope",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
]);

function isStale(row: { displayName: string | null; resolvedAt: Date }): boolean {
  // A never-resolved id (missing_scope, a stale token, a since-fixed permission) is never treated
  // as "cached" — always retried, so a scope grant self-heals on the very next lookup instead of
  // waiting out a TTL. Only a *successful* resolution gets the long cache, since names/avatars
  // change rarely once known.
  if (!row.displayName) return true;
  return Date.now() - row.resolvedAt.getTime() > POSITIVE_TTL_MS;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } })?.data?.error;
}

async function upsertProfile(
  db: Database,
  workspaceId: string,
  slackUserId: string,
  displayName: string | null,
  avatarUrl: string | null,
): Promise<ResolvedProfile> {
  const now = new Date();
  await db
    .insert(slackUserProfiles)
    .values({ workspaceId, slackUserId, displayName, avatarUrl, resolvedAt: now })
    .onConflictDoUpdate({
      target: [slackUserProfiles.workspaceId, slackUserProfiles.slackUserId],
      set: { displayName, avatarUrl, resolvedAt: now, updatedAt: now },
    });
  return { displayName, avatarUrl };
}

/**
 * Never throws, guaranteed. A total Slack outage, a still-missing users:read scope, OR a
 * transient DB error at any point (the installations lookup, the cache read, any upsert)
 * degrades every requested id to { displayName: null, avatarUrl: null } — callers render the
 * raw slackUserId they already have, exactly like today. The DB-error case is caught by the
 * outer try/catch below rather than by guarding each call individually, since a DB failure
 * partway through means partial results can't be trusted anyway.
 */
export async function resolveDisplayNames(
  db: Database,
  workspaceId: string,
  slackUserIds: string[],
): Promise<Map<string, ResolvedProfile>> {
  const uniqueIds = [...new Set(slackUserIds)];
  if (uniqueIds.length === 0) return new Map();

  try {
    return await resolveDisplayNamesUnguarded(db, workspaceId, uniqueIds);
  } catch (error) {
    console.error(
      `resolveDisplayNames: unexpected failure resolving profiles for workspace ${workspaceId}, falling back to raw ids:`,
      error,
    );
    const fallback = new Map<string, ResolvedProfile>();
    for (const id of uniqueIds) fallback.set(id, { displayName: null, avatarUrl: null });
    return fallback;
  }
}

async function resolveDisplayNamesUnguarded(
  db: Database,
  workspaceId: string,
  uniqueIds: string[],
): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();

  const [installation] = await db.select().from(installations).where(eq(installations.workspaceId, workspaceId));
  if (!installation || installation.revokedAt) {
    // A revoked (or nonexistent) install can never succeed — nothing worth remembering.
    for (const id of uniqueIds) result.set(id, { displayName: null, avatarUrl: null });
    return result;
  }

  const cacheRows = await db
    .select()
    .from(slackUserProfiles)
    .where(and(eq(slackUserProfiles.workspaceId, workspaceId), inArray(slackUserProfiles.slackUserId, uniqueIds)));
  const cacheByUserId = new Map(cacheRows.map((r) => [r.slackUserId, r]));

  const client = new WebClient(installation.botToken);
  let authClassFailureHit = false;

  for (const slackUserId of uniqueIds) {
    const cached = cacheByUserId.get(slackUserId);
    if (cached && !isStale(cached)) {
      result.set(slackUserId, { displayName: cached.displayName, avatarUrl: cached.avatarUrl });
      continue;
    }

    if (authClassFailureHit) {
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, null, null));
      continue;
    }

    try {
      const apiResult = await client.users.info({ user: slackUserId });
      const profile = apiResult.user?.profile;
      const displayName = profile?.display_name || apiResult.user?.real_name || apiResult.user?.name || null;
      const avatarUrl = profile?.image_48 ?? null;
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, displayName, avatarUrl));
    } catch (error) {
      const code = slackErrorCode(error);
      if (code && AUTH_CLASS_ERROR_CODES.has(code)) {
        authClassFailureHit = true;
        console.warn(
          `resolveDisplayNames: auth-class Slack error "${code}" for workspace ${workspaceId} — ` +
            `likely still waiting on the users:read reinstall; short-circuiting remaining lookups in this batch`,
        );
      } else {
        console.warn(`resolveDisplayNames: failed to resolve ${slackUserId} in workspace ${workspaceId}:`, error);
      }
      result.set(slackUserId, await upsertProfile(db, workspaceId, slackUserId, null, null));
    }
  }

  return result;
}
