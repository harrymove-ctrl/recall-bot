import { describe, it, expect } from "vitest";
import type { Installation } from "@slack/bolt";
import { db } from "../../src/db/client.js";
import { workspaces, installations } from "../../src/db/schema.js";
import { createPostgresInstallationStore } from "../../src/slack/installationStore.js";
import { eq } from "drizzle-orm";

function fakeInstallation(teamId: string): Installation<"v2", false> {
  return {
    team: { id: teamId, name: "Test Team" },
    enterprise: undefined,
    user: { token: undefined, scopes: undefined, id: "U1" },
    bot: {
      token: "xoxb-fake-token",
      scopes: ["chat:write"],
      id: "B1",
      userId: "UBOT1",
    },
    tokenType: "bot",
    isEnterpriseInstall: false,
    appId: "A1",
    authVersion: "v2",
  };
}

describe("createPostgresInstallationStore", () => {

  it("stores and fetches an installation by team id", async () => {
    const store = createPostgresInstallationStore(db);
    const installation = fakeInstallation("T100");

    await store.storeInstallation(installation);

    const fetched = await store.fetchInstallation({
      teamId: "T100",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });

    expect(fetched.team?.id).toBe("T100");
    expect(fetched.bot?.token).toBe("xoxb-fake-token");

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, "T100"));
    expect(workspace).toBeDefined();
    const [installationRow] = await db
      .select()
      .from(installations)
      .where(eq(installations.workspaceId, workspace.id));
    expect(installationRow.botToken).toBe("xoxb-fake-token");
  });

  it("updates an existing installation on re-install (same team id)", async () => {
    const store = createPostgresInstallationStore(db);
    await store.storeInstallation(fakeInstallation("T200"));

    const reinstalled = fakeInstallation("T200");
    reinstalled.bot!.token = "xoxb-rotated-token";
    await store.storeInstallation(reinstalled);

    const fetched = await store.fetchInstallation({
      teamId: "T200",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
    });
    expect(fetched.bot?.token).toBe("xoxb-rotated-token");
  });

  it("throws when fetching an unknown team id", async () => {
    const store = createPostgresInstallationStore(db);
    await expect(
      store.fetchInstallation({ teamId: "T-UNKNOWN", enterpriseId: undefined, isEnterpriseInstall: false }),
    ).rejects.toThrow();
  });

  it("deletes an installation", async () => {
    const store = createPostgresInstallationStore(db);
    await store.storeInstallation(fakeInstallation("T300"));

    await store.deleteInstallation!({ teamId: "T300", enterpriseId: undefined, isEnterpriseInstall: false });

    await expect(
      store.fetchInstallation({ teamId: "T300", enterpriseId: undefined, isEnterpriseInstall: false }),
    ).rejects.toThrow();
  });
});
