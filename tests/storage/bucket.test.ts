import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { putFile, getSignedDownloadUrl } from "../../src/storage/bucket.js";

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

describe("bucket", () => {
  it("uploads a file with putFile and returns the key", async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const key = await putFile("threads/abc/report.txt", Buffer.from("hello"), "text/plain");

    expect(key).toBe("threads/abc/report.txt");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toBe("threads/abc/report.txt");
    expect(calls[0].args[0].input.ContentType).toBe("text/plain");
  });

  it("returns a signed URL string for a stored key", async () => {
    const url = await getSignedDownloadUrl("threads/abc/report.txt", 60);
    expect(url).toContain("threads/abc/report.txt");
    expect(typeof url).toBe("string");
  });
});
