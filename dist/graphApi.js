import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { files, messages, messageMentions, namespaces, slackUserProfiles } from "../db/schema.js";
import { requireDashboardSession } from "./auth.js";
export function createGraphApiRouter(db, sessionSecret) {
    const router = Router();
    const auth = requireDashboardSession(sessionSecret);
    router.get("/", auth, async (req, res) => {
        if (!req.workspaceId) {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        const workspaceId = req.workspaceId;
        // All active namespaces for this workspace
        const namespaceRows = await db
            .select({
            id: namespaces.id,
            label: namespaces.label,
            channelId: namespaces.channelId,
            threadTs: namespaces.threadTs,
            status: namespaces.status,
            createdAt: namespaces.createdAt,
        })
            .from(namespaces)
            .where(eq(namespaces.workspaceId, workspaceId))
            .orderBy(desc(namespaces.createdAt));
        if (namespaceRows.length === 0) {
            res.json({ nodes: [], edges: [] });
            return;
        }
        const nsIds = namespaceRows.map((n) => n.id);
        // Message counts + walrus counts per namespace
        const countRows = await db
            .select({
            namespaceId: messages.namespaceId,
            messageCount: sql `count(*)::int`,
            walrusStoredCount: sql `count(*) filter (where messages.walrus_storage_status = 'stored')::int`,
        })
            .from(messages)
            .where(inArray(messages.namespaceId, nsIds))
            .groupBy(messages.namespaceId);
        // File counts per namespace
        const fileCountRows = await db
            .select({
            namespaceId: messages.namespaceId,
            fileCount: sql `count(distinct files.id)::int`,
        })
            .from(messages)
            .leftJoin(files, eq(messages.id, files.messageId))
            .where(inArray(messages.namespaceId, nsIds))
            .groupBy(messages.namespaceId);
        const countMap = new Map(countRows.map((r) => [r.namespaceId, r]));
        const fileCountMap = new Map(fileCountRows.map((r) => [r.namespaceId, r.fileCount]));
        // Participant user IDs per namespace (messages.author)
        const authorRows = await db
            .selectDistinct({ namespaceId: messages.namespaceId, slackUserId: messages.slackUserId })
            .from(messages)
            .where(inArray(messages.namespaceId, nsIds));
        // Participant user IDs per namespace (mentions)
        const mentionRows = await db
            .selectDistinct({
            namespaceId: messages.namespaceId,
            slackUserId: messageMentions.slackUserId,
        })
            .from(messageMentions)
            .innerJoin(messages, eq(messageMentions.messageId, messages.id))
            .where(inArray(messages.namespaceId, nsIds));
        const allParticipation = [...authorRows, ...mentionRows];
        const participationByNamespace = new Map();
        for (const row of allParticipation) {
            if (!participationByNamespace.has(row.namespaceId)) {
                participationByNamespace.set(row.namespaceId, []);
            }
            const existing = participationByNamespace.get(row.namespaceId);
            if (!existing.includes(row.slackUserId)) {
                existing.push(row.slackUserId);
            }
        }
        // All unique participant user IDs
        const allUserIds = [...new Set(allParticipation.map((r) => r.slackUserId).filter(Boolean))];
        // User profiles
        const profileRows = allUserIds.length > 0
            ? await db
                .select({
                slackUserId: slackUserProfiles.slackUserId,
                displayName: slackUserProfiles.displayName,
                avatarUrl: slackUserProfiles.avatarUrl,
            })
                .from(slackUserProfiles)
                .where(and(eq(slackUserProfiles.workspaceId, workspaceId), inArray(slackUserProfiles.slackUserId, allUserIds)))
            : [];
        const profileMap = new Map(profileRows.map((p) => [p.slackUserId, p]));
        // Build nodes
        const nodes = [];
        for (const ns of namespaceRows) {
            const counts = countMap.get(ns.id);
            const fileCount = fileCountMap.get(ns.id) ?? 0;
            const participantUserIds = participationByNamespace.get(ns.id) ?? [];
            nodes.push({
                id: ns.id,
                type: "namespace",
                label: ns.label,
                channelId: ns.channelId,
                threadTs: ns.threadTs,
                status: ns.status,
                messageCount: counts?.messageCount ?? 0,
                fileCount,
                walrusStoredCount: counts?.walrusStoredCount ?? 0,
                createdAt: ns.createdAt.toISOString(),
                participantUserIds,
            });
        }
        for (const slackUserId of allUserIds) {
            const profile = profileMap.get(slackUserId);
            nodes.push({
                id: `user-${slackUserId}`,
                type: "user",
                slackUserId,
                displayName: profile?.displayName ?? null,
                avatarUrl: profile?.avatarUrl ?? null,
            });
        }
        // Build edges
        const edges = [];
        for (const ns of namespaceRows) {
            const participantUserIds = participationByNamespace.get(ns.id) ?? [];
            for (const slackUserId of participantUserIds) {
                edges.push({
                    id: `edge-${ns.id}-${slackUserId}`,
                    from: ns.id,
                    to: `user-${slackUserId}`,
                    type: "participation",
                });
            }
        }
        res.json({ nodes, edges });
    });
    return router;
}
//# sourceMappingURL=graphApi.js.map