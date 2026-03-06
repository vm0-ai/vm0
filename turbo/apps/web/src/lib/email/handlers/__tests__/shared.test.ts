import { describe, it, expect } from "vitest";
import {
  parseEmailTriggerAddress,
  parseAgentOnlyAddress,
  isReplyAddress,
  computeReplyRecipients,
} from "../shared";

describe("parseEmailTriggerAddress", () => {
  it("should parse valid scope+agent address", () => {
    const result = parseEmailTriggerAddress("lancy+my-agent@vm0.bot");
    expect(result).toEqual({ scope: "lancy", agent: "my-agent" });
  });

  it("should normalize to lowercase", () => {
    const result = parseEmailTriggerAddress("LANCY+MY-AGENT@vm0.bot");
    expect(result).toEqual({ scope: "lancy", agent: "my-agent" });
  });

  it("should handle scope and agent with numbers", () => {
    const result = parseEmailTriggerAddress("user123+agent456@vm0.bot");
    expect(result).toEqual({ scope: "user123", agent: "agent456" });
  });

  it("should handle scope and agent with hyphens", () => {
    const result = parseEmailTriggerAddress("my-scope+my-agent@vm0.bot");
    expect(result).toEqual({ scope: "my-scope", agent: "my-agent" });
  });

  it("should return null for reply address", () => {
    const result = parseEmailTriggerAddress("reply+token123@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for address without plus sign", () => {
    const result = parseEmailTriggerAddress("invalid@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for address with only scope", () => {
    const result = parseEmailTriggerAddress("scope+@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for address with only agent", () => {
    const result = parseEmailTriggerAddress("+agent@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for scope starting with hyphen", () => {
    const result = parseEmailTriggerAddress("-invalid+agent@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for agent starting with hyphen", () => {
    const result = parseEmailTriggerAddress("scope+-agent@vm0.bot");
    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = parseEmailTriggerAddress("");
    expect(result).toBeNull();
  });
});

describe("parseAgentOnlyAddress", () => {
  it("should parse valid agent-only address", () => {
    expect(parseAgentOnlyAddress("my-agent@vm0.bot")).toBe("my-agent");
  });

  it("should normalize to lowercase", () => {
    expect(parseAgentOnlyAddress("MY-AGENT@vm0.bot")).toBe("my-agent");
  });

  it("should handle agent with numbers", () => {
    expect(parseAgentOnlyAddress("agent123@vm0.bot")).toBe("agent123");
  });

  it("should return null for scope+agent format", () => {
    expect(parseAgentOnlyAddress("scope+agent@vm0.bot")).toBeNull();
  });

  it("should return null for reply address", () => {
    expect(parseAgentOnlyAddress("reply+token@vm0.bot")).toBeNull();
  });

  it("should return null for empty local part", () => {
    expect(parseAgentOnlyAddress("@vm0.bot")).toBeNull();
  });

  it("should return null for agent starting with hyphen", () => {
    expect(parseAgentOnlyAddress("-agent@vm0.bot")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(parseAgentOnlyAddress("")).toBeNull();
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
      to: ["scope+agent@vm0.bot", "user-b@example.com"],
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
