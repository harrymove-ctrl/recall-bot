import type { App } from "@slack/bolt";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { generateDelegateKey } from "../keys/delegateKeys.js";

export async function issueDelegateKey(db: Database, workspaceId: string, slackUserId: string): Promise<string> {
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

export function registerRecallKeyCommand(app: App, db: Database): void {
  app.command("/recall-key", async ({ command, ack, client, logger, respond }) => {
    await ack();

    try {
      const workspaceIdRow = await db.query.workspaces.findFirst({
        where: (w, { eq: eqCol }) => eqCol(w.slackTeamId, command.team_id),
      });
      if (!workspaceIdRow) {
        logger.error(`No workspace found for team ${command.team_id}`);
        await respond({
          text: "Something went wrong issuing your recall key. Please try again, or contact an admin if this keeps happening.",
          response_type: "ephemeral",
        });
        return;
      }

      const plaintext = await issueDelegateKey(db, workspaceIdRow.id, command.user_id);

      const dm = await client.conversations.open({ users: command.user_id });
      await client.chat.postMessage({
        channel: dm.channel!.id!,
        text: `Here's your recall delegate key. Keep it secret — anyone with this key can recall any thread you've participated in:\n\`${plaintext}\`\n\nRun \`/recall-key\` again any time to rotate it (this invalidates the old one).`,
      });
    } catch (error) {
      logger.error(error);
      await respond({
        text: "Something went wrong issuing your recall key. Please try again, or contact an admin if this keeps happening.",
        response_type: "ephemeral",
      });
    }
  });
}
