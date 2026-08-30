import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { inspectPiSessionJsonl, UnsupportedPiSessionVersionError } from "./api";
import { projectPiApiAssistantMessage } from "./api-turn";
import { MemoryPiSession } from "./session-memory";

const SESSION_ID = "00000000-0000-4000-8000-000000000123";

describe("Pi API facade", () => {
  it("projects only API-consumed assistant fields", () => {
    const nativeMessage: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "before tools" },
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      responseId: "response-1",
      errorMessage: "native-only diagnostic",
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 5,
        totalTokens: 18,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.03,
          cacheWrite: 0.02,
          total: 0.35,
        },
      },
      stopReason: "toolUse",
      timestamp: 123,
    };

    expect(projectPiApiAssistantMessage(nativeMessage)).toStrictEqual({
      content: [
        { type: "text", text: "before tools" },
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "/workspace/AGENTS.md" },
        },
      ],
      model: "deepseek-v4-flash",
      responseId: "response-1",
      stopReason: "toolUse",
      timestamp: 123,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
      },
    });
  });

  it("projects native session state into a narrow inspection result", () => {
    const session = MemoryPiSession.create({
      cwd: "/home/user/workspace",
      id: SESSION_ID,
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      api: "openai-responses",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    });

    expect(inspectPiSessionJsonl(session.toJsonl())).toStrictEqual({
      sessionId: SESSION_ID,
      hasPendingToolCalls: false,
      isSettledCheckpoint: true,
    });
  });

  it("preserves the clean entrypoint's unsupported-version error identity", () => {
    const jsonl = `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION + 1,
      id: SESSION_ID,
      timestamp: new Date(0).toISOString(),
      cwd: "/home/user/workspace",
    })}\n`;

    expect(() => {
      inspectPiSessionJsonl(jsonl);
    }).toThrow(UnsupportedPiSessionVersionError);
  });
});
