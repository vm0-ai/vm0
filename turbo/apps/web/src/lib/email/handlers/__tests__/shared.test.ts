import { describe, it, expect } from "vitest";
import {
  parseInboundEmailAddress,
  isReplyAddress,
  computeReplyRecipients,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../shared";

describe("parseInboundEmailAddress", () => {
  it("should parse runtimeorg+agentorg/agentname format", () => {
    const result = parseInboundEmailAddress("alice+acme/support-bot@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: "alice",
      agentOrg: "acme",
      agentName: "support-bot",
    });
  });

  it("should parse agentorg/agentname format", () => {
    const result = parseInboundEmailAddress("acme/support-bot@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: null,
      agentOrg: "acme",
      agentName: "support-bot",
    });
  });

  it("should parse legacy org+agent format", () => {
    const result = parseInboundEmailAddress("lancy+my-agent@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: null,
      agentOrg: "lancy",
      agentName: "my-agent",
    });
  });

  it("should parse agent-only format", () => {
    const result = parseInboundEmailAddress("support-bot@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: null,
      agentOrg: null,
      agentName: "support-bot",
    });
  });

  it("should return null for reply address", () => {
    expect(parseInboundEmailAddress("reply+token123@vm0.bot")).toBeNull();
  });

  it("should normalize to lowercase", () => {
    const result = parseInboundEmailAddress("ALICE+ACME/SUPPORT-BOT@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: "alice",
      agentOrg: "acme",
      agentName: "support-bot",
    });
  });

  it("should handle numbers in all parts", () => {
    const result = parseInboundEmailAddress("org1+org2/agent3@vm0.bot");
    expect(result).toEqual({
      runtimeOrg: "org1",
      agentOrg: "org2",
      agentName: "agent3",
    });
  });

  it("should handle hyphens in all parts", () => {
    const result = parseInboundEmailAddress(
      "my-runtime+my-org/my-agent@vm0.bot",
    );
    expect(result).toEqual({
      runtimeOrg: "my-runtime",
      agentOrg: "my-org",
      agentName: "my-agent",
    });
  });

  it("should return null for empty string", () => {
    expect(parseInboundEmailAddress("")).toBeNull();
  });

  it("should return null for address with only @domain", () => {
    expect(parseInboundEmailAddress("@vm0.bot")).toBeNull();
  });

  it("should return null for slash without agent name", () => {
    expect(parseInboundEmailAddress("org/@vm0.bot")).toBeNull();
  });

  it("should return null for slash without org name", () => {
    expect(parseInboundEmailAddress("/agent@vm0.bot")).toBeNull();
  });
});

describe("isReplyAddress", () => {
  it("should return true for reply address", () => {
    expect(isReplyAddress("reply+token123@vm0.bot")).toBe(true);
  });

  it("should return true for reply address with any case", () => {
    expect(isReplyAddress("REPLY+token123@vm0.bot")).toBe(true);
    expect(isReplyAddress("Reply+token123@vm0.bot")).toBe(true);
  });

  it("should return false for trigger address", () => {
    expect(isReplyAddress("lancy+my-agent@vm0.bot")).toBe(false);
  });

  it("should return false for regular address", () => {
    expect(isReplyAddress("user@vm0.bot")).toBe(false);
  });
});

describe("computeReplyRecipients", () => {
  const botDomain = "vm0.bot";

  it("should reply to sender only in one-on-one email (Case 1)", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["my-agent@vm0.bot"],
      cc: [],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should reply-all when multiple To recipients (Case 2)", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["my-agent@vm0.bot", "user-b@example.com"],
      cc: [],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user-a@example.com", "user-b@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should reply-all preserving CC (Case 3)", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["my-agent@vm0.bot", "user-b@example.com"],
      cc: ["user-c@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user-a@example.com", "user-b@example.com"]);
    expect(result.cc).toEqual(["user-c@example.com"]);
  });

  it("should reply to sender only when bot is CC'd (Case 4)", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["user-b@example.com"],
      cc: ["my-agent@vm0.bot"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user-a@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should honor Reply-To header", () => {
    const result = computeReplyRecipients({
      from: "noreply@mailing-list.com",
      to: ["my-agent@vm0.bot"],
      cc: [],
      replyTo: ["actual-person@example.com"],
      botDomain,
    });
    expect(result.to).toEqual(["actual-person@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should honor Reply-To in reply-all scenario", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["my-agent@vm0.bot", "user-b@example.com"],
      cc: [],
      replyTo: ["user-a-alt@example.com"],
      botDomain,
    });
    expect(result.to).toEqual(["user-a-alt@example.com", "user-b@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should never include bot address in reply recipients", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["org+agent@vm0.bot", "user-b@example.com"],
      cc: ["reply+token@vm0.bot", "user-c@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com", "user-b@example.com"]);
    expect(result.cc).toEqual(["user-c@example.com"]);
  });

  it("should deduplicate recipients", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["my-agent@vm0.bot", "user@example.com"],
      cc: [],
      replyTo: [],
      botDomain,
    });
    // user@example.com appears as both from and in to — should be deduplicated
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should remove CC entries that are already in To", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["my-agent@vm0.bot", "user-b@example.com"],
      cc: ["user-b@example.com", "user-c@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user-a@example.com", "user-b@example.com"]);
    expect(result.cc).toEqual(["user-c@example.com"]);
  });

  it("should handle case-insensitive deduplication", () => {
    const result = computeReplyRecipients({
      from: "User@Example.com",
      to: ["my-agent@vm0.bot", "USER@EXAMPLE.COM"],
      cc: [],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toHaveLength(1);
  });

  it("should handle case-insensitive bot domain matching", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["agent@VM0.BOT"],
      cc: [],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual([]);
  });

  it("should preserve CC when bot is sole To recipient", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["my-agent@vm0.bot"],
      cc: ["colleague@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual(["colleague@example.com"]);
  });

  it("should preserve multiple CC recipients", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["my-agent@vm0.bot"],
      cc: ["cc1@example.com", "cc2@example.com", "cc3@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual([
      "cc1@example.com",
      "cc2@example.com",
      "cc3@example.com",
    ]);
  });

  it("should preserve non-bot CC when bot is CC'd with others", () => {
    const result = computeReplyRecipients({
      from: "user-a@example.com",
      to: ["user-b@example.com"],
      cc: ["my-agent@vm0.bot", "user-c@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user-a@example.com"]);
    expect(result.cc).toEqual(["user-c@example.com"]);
  });

  it("should filter bot addresses from CC", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: ["my-agent@vm0.bot"],
      cc: ["reply+token@vm0.bot", "colleague@example.com"],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual(["colleague@example.com"]);
  });

  it("should handle empty to and cc arrays", () => {
    const result = computeReplyRecipients({
      from: "user@example.com",
      to: [],
      cc: [],
      replyTo: [],
      botDomain,
    });
    expect(result.to).toEqual(["user@example.com"]);
    expect(result.cc).toEqual([]);
  });
});

describe("verifyUnsubscribeToken", () => {
  it("should return null for token without dot", () => {
    expect(verifyUnsubscribeToken("notokenhere")).toBeNull();
  });

  it("should return null for tampered token", () => {
    expect(verifyUnsubscribeToken("user_123.0000000000000000")).toBeNull();
  });

  it("should return null for truncated token", () => {
    expect(verifyUnsubscribeToken("user_123.abc")).toBeNull();
  });

  it("should return null for empty userId", () => {
    expect(verifyUnsubscribeToken(".abcdef0123456789")).toBeNull();
  });
});

describe("buildUnsubscribeUrl", () => {
  it("should return a URL containing the token parameter", () => {
    const url = buildUnsubscribeUrl("user_123");
    expect(url).toContain("/api/email/unsubscribe?token=");
    expect(url).toContain("user_123.");
  });
});

describe("buildUnsubscribeHeaders", () => {
  it("should return correct RFC 8058 headers", () => {
    const url = "https://example.com/api/email/unsubscribe?token=abc";
    const headers = buildUnsubscribeHeaders(url);
    expect(headers["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
