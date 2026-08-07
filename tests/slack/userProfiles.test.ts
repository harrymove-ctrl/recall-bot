import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, installations, slackUserProfiles } from "../../src/db/schema.js";
import { resolveDisplayNames } from "../../src/slack/userProfiles.js";

const usersInfoMock = vi.fn();

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(() => ({ users: { info: usersInfoMock } })),
}));

beforeEach(() => {
  usersInfoMock.mockReset();
});

async function seedInstalledWorkspace(teamId: string) {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: teamId, name: teamId }).returning();
  await db.insert(installations).values({ workspaceId: workspace.id, botToken: "xoxb-fake", botUserId: "UBOT" });
  return workspace;
}

describe("resolveDisplayNames", () => {
  it("skips the network call on a fresh cache hit", async () => {
    const workspace = await seedInstalledWorkspace("T1");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U1",
      displayName: "Ada",
      avatarUrl: "https://example.com/a.png",
      resolvedAt: new Date(),
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U1"]);
    expect(result.get("U1")).toEqual({ displayName: "Ada", avatarUrl: "https://example.com/a.png" });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });

  it("resolves and upserts a fresh id", async () => {
    const workspace = await seedInstalledWorkspace("T2");
    usersInfoMock.mockResolvedValue({
      user: { real_name: "Grace", profile: { display_name: "", image_48: "https://example.com/g.png" } },
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U2"]);
    expect(result.get("U2")).toEqual({ displayName: "Grace", avatarUrl: "https://example.com/g.png" });

    const [row] = await db
      .select()
      .from(slackUserProfiles)
      .where(and(eq(slackUserProfiles.workspaceId, workspace.id), eq(slackUserProfiles.slackUserId, "U2")));
    expect(row.displayName).toBe("Grace");
  });

  it("short-circuits the rest of a batch on the first auth-class error, without extra Slack calls", async () => {
    const workspace = await seedInstalledWorkspace("T3");
    usersInfoMock.mockRejectedValue({ data: { error: "missing_scope" } });

    const result = await resolveDisplayNames(db, workspace.id, ["U3", "U4", "U5"]);
    expect([...result.values()]).toEqual([
      { displayName: null, avatarUrl: null },
      { displayName: null, avatarUrl: null },
      { displayName: null, avatarUrl: null },
    ]);
    expect(usersInfoMock).toHaveBeenCalledTimes(1);
  });

  it("negative-caches only the failing id on a per-id error, and still resolves the rest", async () => {
    const workspace = await seedInstalledWorkspace("T4");
    usersInfoMock.mockImplementation(async ({ user }: { user: string }) => {
      if (user === "U6") throw { data: { error: "user_not_found" } };
      return { user: { real_name: "Resolved", profile: {} } };
    });

    const result = await resolveDisplayNames(db, workspace.id, ["U6", "U7"]);
    expect(result.get("U6")).toEqual({ displayName: null, avatarUrl: null });
    expect(result.get("U7")?.displayName).toBe("Resolved");
    expect(usersInfoMock).toHaveBeenCalledTimes(2);
  });

  it("retries a negative-cached row past the 24h window", async () => {
    const workspace = await seedInstalledWorkspace("T5");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U8",
      displayName: null,
      avatarUrl: null,
      resolvedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    usersInfoMock.mockResolvedValue({ user: { real_name: "Now Resolved", profile: {} } });

    const result = await resolveDisplayNames(db, workspace.id, ["U8"]);
    expect(result.get("U8")?.displayName).toBe("Now Resolved");
    expect(usersInfoMock).toHaveBeenCalledTimes(1);
  });

  it("retries a positive-cached row past the 30-day window", async () => {
    const workspace = await seedInstalledWorkspace("T6");
    await db.insert(slackUserProfiles).values({
      workspaceId: workspace.id,
      slackUserId: "U9",
      displayName: "Stale Name",
      avatarUrl: null,
      resolvedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    usersInfoMock.mockResolvedValue({ user: { real_name: "Fresh Name", profile: {} } });

    const result = await resolveDisplayNames(db, workspace.id, ["U9"]);
    expect(result.get("U9")?.displayName).toBe("Fresh Name");
  });

  it("returns nulls with zero Slack calls when there is no installation row", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T7", name: "T7" }).returning();
    const result = await resolveDisplayNames(db, workspace.id, ["U10"]);
    expect(result.get("U10")).toEqual({ displayName: null, avatarUrl: null });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });

  it("returns nulls with zero Slack calls when the installation is revoked", async () => {
    const workspace = await seedInstalledWorkspace("T8");
    await db.update(installations).set({ revokedAt: new Date() }).where(eq(installations.workspaceId, workspace.id));

    const result = await resolveDisplayNames(db, workspace.id, ["U11"]);
    expect(result.get("U11")).toEqual({ displayName: null, avatarUrl: null });
    expect(usersInfoMock).not.toHaveBeenCalled();
  });
});
