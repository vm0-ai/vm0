import { describe, it, expect } from "vitest";
import {
  voiceChatItemRoleSchema,
  voiceChatReasoningStatusSchema,
  voiceChatTaskStatusSchema,
  zeroVoiceChatContract,
} from "../zero-voice-chat";

describe("zeroVoiceChatContract", () => {
  it("exposes the expected routes with correct HTTP methods", () => {
    const expected: Record<string, "GET" | "POST"> = {
      createSession: "POST",
      getSession: "GET",
      listSessions: "GET",
      triggerReasoning: "POST",
      appendItem: "POST",
      createTask: "POST",
      listTasks: "GET",
      token: "POST",
    };
    const contract = zeroVoiceChatContract as unknown as Record<
      string,
      { method: string; path: string }
    >;
    for (const [routeName, method] of Object.entries(expected)) {
      expect(contract[routeName], `route ${routeName} missing`).toBeDefined();
      expect(contract[routeName]?.method).toBe(method);
    }
  });

  it("namespaces all routes under /api/zero/voice-chat-candidate", () => {
    const contract = zeroVoiceChatContract as unknown as Record<
      string,
      { path: string }
    >;
    for (const routeName of Object.keys(contract)) {
      expect(contract[routeName]?.path).toMatch(
        /^\/api\/zero\/voice-chat-candidate(\/|$)/,
      );
    }
  });

  it("no longer exposes session lifecycle routes (end/heartbeat/reenter)", () => {
    const contract = zeroVoiceChatContract as unknown as Record<
      string,
      unknown
    >;
    expect(contract.endSession).toBeUndefined();
    expect(contract.heartbeat).toBeUndefined();
    expect(contract.reenterSession).toBeUndefined();
  });
});

describe("voice-chat enum schemas", () => {
  it("item role covers user | assistant | task_result | system_note", () => {
    expect(voiceChatItemRoleSchema.options).toEqual([
      "user",
      "assistant",
      "task_result",
      "system_note",
    ]);
  });

  it("task status covers all 5 DB states (pending | queued | running | done | failed)", () => {
    expect(voiceChatTaskStatusSchema.options).toEqual([
      "pending",
      "queued",
      "running",
      "done",
      "failed",
    ]);
  });

  it("reasoning status covers idle | running", () => {
    expect(voiceChatReasoningStatusSchema.options).toEqual(["idle", "running"]);
  });
});
