import { users } from "../db/schema.js";
import { resolveWorkspaceByTeamId } from "../db/workspaces.js";
import { generateDelegateKey } from "../keys/delegateKeys.js";
import { issueUserClaimToken } from "../dashboard/userClaimTokens.js";
export async function issueDelegateKey(db, workspaceId, slackUserId) {
    const { plaintext, hash } = generateDelegateKey();
    await db
        .insert(users)
        .values({ workspaceId, slackUserId, delegateKeyHash: hash })
        .onConflictDoUpdate({
        target: [users.workspaceId, users.slackUserId],
        set: { delegateKeyHash: hash, updatedAt: new Date() },
    });
    return plaintext;
}
export async function issuePersonalLoginLink(db, workspaceId, slackUserId, publicBaseUrl) {
    const token = await issueUserClaimToken(db, workspaceId, slackUserId);
    return `${publicBaseUrl}/dashboard/me/claim?token=${token}`;
}
export function registerRecallKeyCommand(app, db, publicBaseUrl) {
    app.command("/recall-key", async ({ command, ack, client, logger, respond }) => {
        await ack();
        try {
            const workspaceIdRow = await resolveWorkspaceByTeamId(db, command.team_id);
            if (!workspaceIdRow) {
                logger.error(`No workspace found for team ${command.team_id}`);
                await respond({
                    text: "Something went wrong issuing your recall key. Please try again, or contact an admin if this keeps happening.",
                    response_type: "ephemeral",
                });
                return;
            }
            const plaintext = await issueDelegateKey(db, workspaceIdRow.id, command.user_id);
            const loginLink = await issuePersonalLoginLink(db, workspaceIdRow.id, command.user_id, publicBaseUrl);
            const dm = await client.conversations.open({ users: command.user_id });
            await client.chat.postMessage({
                channel: dm.channel.id,
                text: `Here's your recall delegate key. Keep it secret — anyone with this key can recall any thread you've participated in:\n\`${plaintext}\`\n\n` +
                    `Run \`/recall-key\` again any time to rotate it (this invalidates the old one).\n\n` +
                    `Prefer a browser? View your captured threads here: ${loginLink}\n` +
                    `(single-use, expires in 7 days — run /recall-key again any time for a fresh link)`,
            });
        }
        catch (error) {
            logger.error(error);
            await respond({
                text: "Something went wrong issuing your recall key. Please try again, or contact an admin if this keeps happening.",
                response_type: "ephemeral",
            });
        }
    });
}
//# sourceMappingURL=recallKeyCommand.js.map