import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createPiAgentSessionForRuntime } from "./session-runtime";

const TERRA_MODEL = {
  provider: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-5.6-terra",
  api: "openai-responses" as const,
  thinkingLevel: "low" as const,
};

const EMPTY_RESOURCE_SNAPSHOT = {
  schemaVersion: 1 as const,
  agentsFiles: [],
  skills: [],
};

describe("official Pi AgentSession runtime", () => {
  it("uses Terra low thinking for a fresh session", async () => {
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000124",
    });
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: null,
      resourceSnapshot: EMPTY_RESOURCE_SNAPSHOT,
    });

    try {
      expect(created.session.agent.state.thinkingLevel).toBe("low");
      expect(
        sessionManager.getBranch().filter((entry) => {
          return entry.type === "thinking_level_change";
        }),
      ).toEqual([expect.objectContaining({ thinkingLevel: "low" })]);
    } finally {
      created.session.dispose();
    }
  });

  it("keeps an existing explicit session thinking level authoritative", async () => {
    const sessionManager = SessionManager.inMemory("/home/user/workspace", {
      id: "00000000-0000-4000-8000-000000000125",
    });
    sessionManager.appendThinkingLevelChange("high");
    sessionManager.appendMessage({
      role: "user",
      content: "historical prompt",
      timestamp: 1,
    });
    sessionManager.appendMessage(
      fauxAssistantMessage("historical answer", { timestamp: 2 }),
    );
    const created = await createPiAgentSessionForRuntime({
      cwd: "/home/user/workspace",
      agentDir: "/home/user/.pi/agent",
      sessionManager,
      model: TERRA_MODEL,
      appendSystemPrompt: null,
      resourceSnapshot: EMPTY_RESOURCE_SNAPSHOT,
    });

    try {
      expect(created.session.agent.state.thinkingLevel).toBe("high");
      expect(
        sessionManager.getBranch().filter((entry) => {
          return entry.type === "thinking_level_change";
        }),
      ).toHaveLength(1);
    } finally {
      created.session.dispose();
    }
  });
});
