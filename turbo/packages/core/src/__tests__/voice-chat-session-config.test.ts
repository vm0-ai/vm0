import { describe, it, expect } from "vitest";
import {
  SESSION_TOOL_NAMES,
  isSessionToolName,
} from "../voice-chat/session-config";

describe("SESSION_TOOL_NAMES", () => {
  it("matches the six Talker tool names", () => {
    expect([...SESSION_TOOL_NAMES]).toEqual([
      "inform_slow_brain",
      "feel_confused",
      "feel_unable",
      "want_to_ask_user",
      "want_to_reject",
      "want_to_apologize",
    ]);
  });
});

describe("isSessionToolName", () => {
  it("accepts every name in SESSION_TOOL_NAMES", () => {
    for (const name of SESSION_TOOL_NAMES) {
      expect(isSessionToolName(name)).toBe(true);
    }
  });

  it("rejects names outside the canonical list", () => {
    expect(isSessionToolName("bogus_tool")).toBe(false);
    expect(isSessionToolName("")).toBe(false);
    expect(isSessionToolName("INFORM_SLOW_BRAIN")).toBe(false);
  });
});
