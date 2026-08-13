import { eq } from "drizzle-orm";
import { workspaces, installations } from "../db/schema.js";
export function createPostgresInstallationStore(db) {
    return {
        async storeInstallation(installation) {
            if (installation.isEnterpriseInstall) {
                throw new Error("Enterprise Grid (org-wide) installs are not supported yet");
            }
            const teamId = installation.team?.id;
            const bot = installation.bot;
            if (!teamId || !bot) {
                throw new Error("Failed saving installation: missing team id or bot token");
            }
            await db.transaction(async (tx) => {
                const [workspace] = await tx
                    .insert(workspaces)
                    .values({ slackTeamId: teamId, name: installation.team?.name ?? teamId })
                    .onConflictDoUpdate({
                    target: workspaces.slackTeamId,
                    set: { name: installation.team?.name ?? teamId, updatedAt: new Date() },
                })
                    .returning();
                await tx
                    .insert(installations)
                    .values({
                    workspaceId: workspace.id,
                    botToken: bot.token,
                    botUserId: bot.userId,
                })
                    .onConflictDoUpdate({
                    target: installations.workspaceId,
                    set: { botToken: bot.token, botUserId: bot.userId, revokedAt: null, updatedAt: new Date() },
                });
            });
        },
        async fetchInstallation(query) {
            if (query.isEnterpriseInstall || !query.teamId) {
                throw new Error("Enterprise Grid (org-wide) installs are not supported yet");
            }
            const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, query.teamId));
            if (!workspace) {
                throw new Error(`No installation found for team ${query.teamId}`);
            }
            const [installationRow] = await db
                .select()
                .from(installations)
                .where(eq(installations.workspaceId, workspace.id));
            if (!installationRow || installationRow.revokedAt) {
                throw new Error(`No active installation found for team ${query.teamId}`);
            }
            return {
                team: { id: workspace.slackTeamId, name: workspace.name },
                enterprise: undefined,
                user: { token: undefined, scopes: undefined, id: "" },
                bot: {
                    token: installationRow.botToken,
                    scopes: [],
                    id: "",
                    userId: installationRow.botUserId,
                },
                tokenType: "bot",
                isEnterpriseInstall: false,
                authVersion: "v2",
            };
        },
        async deleteInstallation(query) {
            if (query.isEnterpriseInstall || !query.teamId)
                return;
            const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, query.teamId));
            if (!workspace)
                return;
            await db
                .update(installations)
                .set({ revokedAt: new Date() })
                .where(eq(installations.workspaceId, workspace.id));
        },
    };
}
//# sourceMappingURL=installationStore.js.map