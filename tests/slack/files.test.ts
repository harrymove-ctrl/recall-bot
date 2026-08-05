import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { downloadSlackFile, captureSlackFile } from "../../src/slack/files.js";
import { eq } from "drizzle-orm";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedMessage() {
  const [workspace] = await db.insert(workspaces).values({ slackTeamId: "T1", name: "T" }).returning();
  const [namespace] = await db
    .insert(namespaces)
    .values({ workspaceId: workspace.id, channelId: "C1", threadTs: "1.1" })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({ namespaceId: namespace.id, slackUserId: "U1", text: "hi", slackTs: "1.2" })
    .returning();
  return message;
}

describe("downloadSlackFile", () => {
  it("fetches the file with a bearer token and returns a Buffer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("file-bytes").buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const buf = await downloadSlackFile("https://files.slack.com/f1", "xoxb-token");

    expect(buf.toString()).toBe("file-bytes");
    expect(fetchMock).toHaveBeenCalledWith("https://files.slack.com/f1", {
      headers: { Authorization: "Bearer xoxb-token" },
    });
  });

  it("throws when the download response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" }));
    await expect(downloadSlackFile("https://files.slack.com/f1", "xoxb-token")).rejects.toThrow(/403/);
  });
});

describe("captureSlackFile", () => {
  it("downloads, uploads to the bucket, and marks the file row stored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes").buffer }),
    );
    const message = await seedMessage();

    await captureSlackFile({
      db,
      messageId: message.id,
      botToken: "xoxb-token",
      file: {
        id: "F1",
        name: "report.txt",
        mimetype: "text/plain",
        url_private: "https://files.slack.com/f1",
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("stored");
    expect(fileRow.originalName).toBe("report.txt");
    expect(fileRow.bucketKey).toContain(message.id);
  });

  it("marks the file row failed when the download throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Server Error" }));
    const message = await seedMessage();

    await captureSlackFile({
      db,
      messageId: message.id,
      botToken: "xoxb-token",
      file: {
        id: "F2",
        name: "broken.txt",
        mimetype: "text/plain",
        url_private: "https://files.slack.com/f2",
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("failed");
  });
});
