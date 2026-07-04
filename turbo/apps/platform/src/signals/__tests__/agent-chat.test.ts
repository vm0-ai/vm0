import { describe, expect, it } from "vitest";

import { resolveCurrentChatAgentId } from "../agent-chat.ts";

describe("resolveCurrentChatAgentId", () => {
  it("lets the agent chat route win over stale internal chat agent state", () => {
    expect(
      resolveCurrentChatAgentId({
        threadAgentId: null,
        routeAgentId: "route-agent",
        internalAgentId: "previous-agent",
        defaultAgentId: "default-agent",
      }),
    ).toBe("route-agent");
  });

  it("keeps thread-owned chat routes ahead of agent chat routes", () => {
    expect(
      resolveCurrentChatAgentId({
        threadAgentId: "thread-agent",
        routeAgentId: "route-agent",
        internalAgentId: "previous-agent",
        defaultAgentId: "default-agent",
      }),
    ).toBe("thread-agent");
  });
});
