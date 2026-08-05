import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../src/db/client.js";
import { workspaces, namespaces, messages, files } from "../../src/db/schema.js";
import { downloadSlackFile, captureSlackFile, MAX_FILE_SIZE_BYTES } from "../../src/slack/files.js";
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
        size: 5,
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("stored");
    expect(fileRow.originalName).toBe("report.txt");
    expect(fileRow.bucketKey).toContain(message.id);
  });

  it("marks the file row failed and logs the file/message ids when the download throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
        size: 5,
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("failed");

    // a swallowed capture failure is invisible without this log
    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = consoleError.mock.calls[0].join(" ");
    expect(logged).toContain("F2");
    expect(logged).toContain(message.id);
    consoleError.mockRestore();
  });

  it("marks a file over the size limit failed without downloading or uploading it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const message = await seedMessage();

    await captureSlackFile({
      db,
      messageId: message.id,
      botToken: "xoxb-token",
      file: {
        id: "F3",
        name: "huge.zip",
        mimetype: "application/zip",
        url_private: "https://files.slack.com/f3",
        size: MAX_FILE_SIZE_BYTES + 1,
      },
    });

    // buffering this in memory would take down the process that also serves Slack events and MCP
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("failed");
    expect(fileRow.originalName).toBe("huge.zip");
    expect(fileRow.bucketKey).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("still captures a file sitting exactly on the size limit", async () => {
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
        id: "F4",
        name: "exactly-at-limit.bin",
        mimetype: "application/octet-stream",
        url_private: "https://files.slack.com/f4",
        size: MAX_FILE_SIZE_BYTES,
      },
    });

    const [fileRow] = await db.select().from(files).where(eq(files.messageId, message.id));
    expect(fileRow.status).toBe("stored");
  });
});
