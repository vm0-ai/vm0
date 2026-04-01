import { describe, it, expect } from "vitest";
import {
  storedExecutionContextSchema,
  executionContextSchema,
  type StoredExecutionContext,
  type ExecutionContext,
} from "../runners";

/**
 * Minimal valid stored execution context for testing.
 */
const baseStoredContext = {
  workingDir: "/workspace",
  storageManifest: null,
  environment: null,
  resumeSession: null,
  encryptedSecrets: null,
  cliAgentType: "claude-code",
};

/**
 * Minimal valid execution context for testing.
 */
const baseExecutionContext = {
  ...baseStoredContext,
  runId: "00000000-0000-4000-8000-000000000001",
  prompt: "test",
  appendSystemPrompt: null,
  agentComposeVersionId: null,
  vars: null,
  checkpointId: null,
  sandboxToken: "tok",
  secretValues: null,
};

const sampleFirewalls = [
  {
    name: "github",
    ref: "github",
    apis: [
      {
        base: "https://api.github.com",
        auth: { headers: { Authorization: "Bearer tok" } },
      },
    ],
  },
];

describe("storedExecutionContextSchema backward compatibility", () => {
  it("should parse with new firewalls field name", () => {
    const data: StoredExecutionContext = storedExecutionContextSchema.parse({
      ...baseStoredContext,
      firewalls: sampleFirewalls,
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls?.[0]?.name).toBe("github");
  });

  it("should parse legacy experimentalFirewalls field name", () => {
    const data: StoredExecutionContext = storedExecutionContextSchema.parse({
      ...baseStoredContext,
      experimentalFirewalls: sampleFirewalls,
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls?.[0]?.name).toBe("github");
  });

  it("should prefer firewalls over experimentalFirewalls when both exist", () => {
    const data: StoredExecutionContext = storedExecutionContextSchema.parse({
      ...baseStoredContext,
      firewalls: sampleFirewalls,
      experimentalFirewalls: [{ name: "old", ref: "old", apis: [] }],
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls?.[0]?.name).toBe("github");
  });
});

describe("executionContextSchema backward compatibility", () => {
  it("should parse with new firewalls field name", () => {
    const data: ExecutionContext = executionContextSchema.parse({
      ...baseExecutionContext,
      firewalls: sampleFirewalls,
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls?.[0]?.name).toBe("github");
  });

  it("should parse legacy experimentalFirewalls field name", () => {
    const data: ExecutionContext = executionContextSchema.parse({
      ...baseExecutionContext,
      experimentalFirewalls: sampleFirewalls,
    });
    expect(data.firewalls).toHaveLength(1);
    expect(data.firewalls?.[0]?.name).toBe("github");
  });
});
