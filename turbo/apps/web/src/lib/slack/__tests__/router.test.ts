import { describe, it, expect } from "vitest";
import { routeToAgent } from "../router";

describe("routeToAgent", () => {
  it("returns null for empty bindings", async () => {
    const result = await routeToAgent("hello", []);
    expect(result).toBeNull();
  });

  it("returns the only agent when there is just one binding", async () => {
    const result = await routeToAgent("hello", [
      { agentName: "my-agent", description: "A test agent" },
    ]);
    expect(result).toBe("my-agent");
  });

  it("returns agent when its name is mentioned in the message", async () => {
    const result = await routeToAgent("can the coder help me with this?", [
      { agentName: "coder", description: "Writes code" },
      { agentName: "reviewer", description: "Reviews code" },
    ]);
    expect(result).toBe("coder");
  });

  it("returns agent when description keywords match the message", async () => {
    const result = await routeToAgent("I need help writing python code", [
      {
        agentName: "agent-a",
        description: "Writes code and helps with programming",
      },
      { agentName: "agent-b", description: "Manages tasks and schedules" },
    ]);
    expect(result).toBe("agent-a");
  });

  it("returns null when routing is ambiguous", async () => {
    const result = await routeToAgent("hello there", [
      { agentName: "agent-a", description: "A friendly helper" },
      { agentName: "agent-b", description: "Another friendly helper" },
    ]);
    expect(result).toBeNull();
  });

  it("returns null when no descriptions match", async () => {
    const result = await routeToAgent("fix the bug in the login page", [
      { agentName: "weather-bot", description: "Provides weather forecasts" },
      { agentName: "news-bot", description: "Delivers daily news" },
    ]);
    expect(result).toBeNull();
  });

  it("prefers agent name match over description match", async () => {
    const result = await routeToAgent("use the writer to help", [
      { agentName: "writer", description: "Helps with reading" },
      { agentName: "reader", description: "Helps with writing and editing" },
    ]);
    expect(result).toBe("writer");
  });

  it("handles agents with null descriptions", async () => {
    const result = await routeToAgent("hello coder", [
      { agentName: "coder", description: null },
      { agentName: "other", description: null },
    ]);
    expect(result).toBe("coder");
  });

  it("matches hyphenated agent names", async () => {
    const result = await routeToAgent("ask code helper for assistance", [
      { agentName: "code-helper", description: "Helps with code" },
      { agentName: "task-manager", description: "Manages tasks" },
    ]);
    expect(result).toBe("code-helper");
  });

  it("matches underscored agent names", async () => {
    const result = await routeToAgent("use the code assistant", [
      { agentName: "code_assistant", description: "Helps with code" },
      { agentName: "task_manager", description: "Manages tasks" },
    ]);
    expect(result).toBe("code_assistant");
  });
});
