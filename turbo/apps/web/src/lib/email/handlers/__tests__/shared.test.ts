import { describe, it, expect } from "vitest";
import { parseEmailTriggerAddress, isReplyAddress } from "../shared";

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
