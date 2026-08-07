import { and, eq, inArray } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { Database } from "../db/client.js";
import { installations, slackUserProfiles } from "../db/schema.js";

export interface ResolvedProfile {
  displayName: string | null;
  avatarUrl: string | null;
}

const POSITIVE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days — names/avatars change rarely
const NEGATIVE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours — cheap to recheck, self-heals within a day of a reinstall

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
  const ttl = row.displayName ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  return Date.now() - row.resolvedAt.getTime() > ttl;
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
 * Never throws. A total Slack outage or a still-missing users:read scope degrades every
 * requested id to { displayName: null, avatarUrl: null } — callers render the raw slackUserId
 * they already have, exactly like today.
 */
export async function resolveDisplayNames(
  db: Database,
  workspaceId: string,
  slackUserIds: string[],
): Promise<Map<string, ResolvedProfile>> {
  const result = new Map<string, ResolvedProfile>();
  const uniqueIds = [...new Set(slackUserIds)];
  if (uniqueIds.length === 0) return result;

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
