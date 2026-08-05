import { describe, it, expect } from "vitest";
import { db } from "../../src/db/client.js";
import { workspaces } from "../../src/db/schema.js";
import { resolveWorkspaceByTeamId } from "../../src/db/workspaces.js";

describe("resolveWorkspaceByTeamId", () => {
  it("returns the workspace id for an installed team", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T-installed", name: "T" }).returning();

    const found = await resolveWorkspaceByTeamId(db, "T-installed");

    expect(found?.id).toBe(workspace.id);
  });

  it("returns undefined for a team we have no installation for", async () => {
    await db.insert(workspaces).values({ slackTeamId: "T-other", name: "T" });

    expect(await resolveWorkspaceByTeamId(db, "T-nope")).toBeUndefined();
  });
});
