import { describe, it, expect } from "vitest";
import { extractMentionedUserIds } from "../../src/slack/mentions.js";

describe("extractMentionedUserIds", () => {
  it("matches Slack's bare <@U123> mention form", () => {
    expect(extractMentionedUserIds("hey <@U0BN6EB79QT> can you take a look")).toEqual(["U0BN6EB79QT"]);
  });

  it("matches Slack's <@U123|label> mention form", () => {
    expect(extractMentionedUserIds("hey <@U0BN6EB79QT|harry> can you take a look")).toEqual(["U0BN6EB79QT"]);
  });

  it("returns multiple distinct mentions from one message", () => {
    expect(extractMentionedUserIds("<@U1> and <@U2>, please review")).toEqual(["U1", "U2"]);
  });

  it("dedups a repeated mention within one call", () => {
    expect(extractMentionedUserIds("<@U1> ping <@U1> again")).toEqual(["U1"]);
  });

  it("returns an empty array for text with no mentions", () => {
    expect(extractMentionedUserIds("no mentions here")).toEqual([]);
  });

  it("ignores unrelated bracket syntax like channel links", () => {
    expect(extractMentionedUserIds("see <#C0AL6RR6SDR|general>")).toEqual([]);
  });
});
