import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, namespaceLinearIssues } from "../../src/db/schema.js";
import { extractLinearIssueRefs, linearIssueUrl, recordLinearIssueLinks } from "../../src/slack/linearLinks.js";

describe("extractLinearIssueRefs", () => {
  it("matches Slack's bare <url> bracket form", () => {
    const refs = extractLinearIssueRefs("see <https://linear.app/mysten-labs/issue/WALM-297>");
    expect(refs).toEqual([{ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" }]);
  });

  it("matches Slack's <url|label> bracket form", () => {
    const refs = extractLinearIssueRefs(
      "see <https://linear.app/mysten-labs/issue/WALM-297/memory-read-api|WALM-297: Memory read API>",
    );
    expect(refs).toEqual([{ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" }]);
  });

  it("returns multiple distinct issues from one message", () => {
    const refs = extractLinearIssueRefs(
      "blocked by <https://linear.app/mysten-labs/issue/WALM-1> and <https://linear.app/mysten-labs/issue/WALM-2>",
    );
    expect(refs.map((r) => r.issueIdentifier)).toEqual(["WALM-1", "WALM-2"]);
  });

  it("dedups a repeated mention within one call", () => {
    const refs = extractLinearIssueRefs(
      "<https://linear.app/mysten-labs/issue/WALM-297> ... also <https://linear.app/mysten-labs/issue/WALM-297>",
    );
    expect(refs).toHaveLength(1);
  });

  it("normalizes a hand-typed lowercase identifier to uppercase", () => {
    const refs = extractLinearIssueRefs("https://linear.app/mysten-labs/issue/walm-297");
    expect(refs[0].issueIdentifier).toBe("WALM-297");
  });

  it("ignores a non-issue linear.app URL", () => {
    expect(extractLinearIssueRefs("https://linear.app/mysten-labs/settings")).toEqual([]);
  });

  it("returns [] for plain text with no link", () => {
    expect(extractLinearIssueRefs("just talking about the launch")).toEqual([]);
  });
});

describe("linearIssueUrl", () => {
  it("reconstructs the bare-identifier URL, dropping any descriptive slug", () => {
    expect(linearIssueUrl({ workspaceSlug: "mysten-labs", issueIdentifier: "WALM-297" })).toBe(
      "https://linear.app/mysten-labs/issue/WALM-297",
    );
  });
});

describe("recordLinearIssueLinks", () => {
  it("inserts one row per distinct ref, and a repeat call is a no-op", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.0" })
      .returning();

    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1>",
    });
    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1>",
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(1);
  });

  it("inserts two rows for two distinct refs", async () => {
    const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T2", name: "T" }).returning();
    const [namespace] = await db
      .insert(namespaces)
      .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "2.0" })
      .returning();

    await recordLinearIssueLinks({
      db,
      namespaceId: namespace.id,
      text: "<https://linear.app/mysten-labs/issue/WALM-1> and <https://linear.app/mysten-labs/issue/WALM-2>",
    });

    const rows = await db.select().from(namespaceLinearIssues).where(eq(namespaceLinearIssues.namespaceId, namespace.id));
    expect(rows).toHaveLength(2);
  });
});
