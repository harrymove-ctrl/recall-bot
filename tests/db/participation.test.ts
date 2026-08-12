import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, messageMentions } from "../../src/db/schema.js";
import { findParticipantNamespace } from "../../src/db/participation.js";

async function seedThread() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
    .returning();
  const [msg] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "1.0" })
    .returning();
  return { workspace, namespace, msg };
}

describe("findParticipantNamespace", () => {
  it("returns the namespace for an actual participant", async () => {
    const { workspace, namespace } = await seedThread();
    const result = await findParticipantNamespace(db, workspace.id, "U1", namespace.id);
    expect(result).toEqual({ id: namespace.id });
  });

  it("returns null for a user who never posted in the namespace", async () => {
    const { workspace, namespace } = await seedThread();
    expect(await findParticipantNamespace(db, workspace.id, "U-STRANGER", namespace.id)).toBeNull();
  });

  it("returns null for a namespace in a different workspace", async () => {
    const { namespace } = await seedThread();
    const [otherWorkspace] = await db.insert(workspaces).values({ slackTeamId: "T-OTHER", name: "T" }).returning();
    expect(await findParticipantNamespace(db, otherWorkspace.id, "U1", namespace.id)).toBeNull();
  });

  it("returns null for a namespace id that doesn't exist", async () => {
    const { workspace } = await seedThread();
    expect(
      await findParticipantNamespace(db, workspace.id, "U1", "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("returns the namespace for a user who was @mentioned (not the author)", async () => {
    const { workspace, namespace, msg } = await seedThread();
    // U1 wrote the message, but U2 was @mentioned
    await db.insert(messageMentions).values({ messageId: msg.id, slackUserId: "U2" });
    const result = await findParticipantNamespace(db, workspace.id, "U2", namespace.id);
    expect(result).toEqual({ id: namespace.id });
  });

  it("returns null for a user who was never mentioned", async () => {
    const { workspace, namespace } = await seedThread();
    expect(await findParticipantNamespace(db, workspace.id, "U-NEVER-SEEN", namespace.id)).toBeNull();
  });
});
