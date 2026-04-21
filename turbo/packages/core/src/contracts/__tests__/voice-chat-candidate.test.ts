import { describe, it, expect } from "vitest";
import {
  voiceChatCandidateItemRoleSchema,
  voiceChatCandidateReasoningStatusSchema,
  voiceChatCandidateSessionStatusSchema,
  voiceChatCandidateTaskStatusSchema,
  zeroVoiceChatCandidateContract,
} from "../zero-voice-chat-candidate";

describe("zeroVoiceChatCandidateContract", () => {
  it("exposes the 8 expected routes with correct HTTP methods", () => {
    const expected: Record<string, "GET" | "POST"> = {
      createSession: "POST",
      getSession: "GET",
      endSession: "POST",
      heartbeat: "POST",
      appendItem: "POST",
      readItems: "GET",
      createTask: "POST",
      token: "POST",
    };
    const contract = zeroVoiceChatCandidateContract as unknown as Record<
      string,
      { method: string; path: string }
    >;
    for (const [routeName, method] of Object.entries(expected)) {
      expect(contract[routeName], `route ${routeName} missing`).toBeDefined();
      expect(contract[routeName]?.method).toBe(method);
    }
  });

  it("namespaces all routes under /api/zero/voice-chat-candidate", () => {
    const contract = zeroVoiceChatCandidateContract as unknown as Record<
      string,
      { path: string }
    >;
    for (const routeName of Object.keys(contract)) {
      expect(contract[routeName]?.path).toMatch(
        /^\/api\/zero\/voice-chat-candidate(\/|$)/,
      );
    }
  });
});

describe("voice-chat-candidate enum schemas", () => {
  it("session status covers active | ended | timeout", () => {
    expect(voiceChatCandidateSessionStatusSchema.options).toEqual([
      "active",
      "ended",
      "timeout",
    ]);
  });

  it("item role covers user | assistant | task_result | system_note", () => {
    expect(voiceChatCandidateItemRoleSchema.options).toEqual([
      "user",
      "assistant",
      "task_result",
      "system_note",
    ]);
  });

  it("task status covers all 5 DB states (pending | queued | running | done | failed)", () => {
    expect(voiceChatCandidateTaskStatusSchema.options).toEqual([
      "pending",
      "queued",
      "running",
      "done",
      "failed",
    ]);
  });

  it("reasoning status covers idle | running", () => {
    expect(voiceChatCandidateReasoningStatusSchema.options).toEqual([
      "idle",
      "running",
    ]);
  });
});
