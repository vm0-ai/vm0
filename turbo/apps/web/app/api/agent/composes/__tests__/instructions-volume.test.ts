import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";
import { GET } from "../[id]/route";
import {
  createTestRequest,
  createTestVolume,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { getInstructionsStorageName } from "@vm0/core";

vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

/**
 * Bug Reproduction Test: Agent Name Case Sensitivity
 *
 * This test demonstrates the case mismatch between CLI upload and server storage:
 *
 * 1. User has vm0.yaml with agent name "My-Researcher" (mixed case)
 * 2. CLI uploads instructions to storage: "agent-instructions@My-Researcher"
 * 3. Server normalizes agent name to lowercase when storing compose
 * 4. At runtime, system looks for "agent-instructions@my-researcher"
 * 5. Instructions not found -> agent falls back to name-based behavior inference
 */
describe("Instructions Volume Case Sensitivity Bug", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should normalize agent name to lowercase when storing compose", async () => {
    const originalAgentName = "My-Researcher"; // Mixed case from user's vm0.yaml

    const config = {
      version: "1.0",
      agents: {
        [originalAgentName]: {
          framework: "claude-code",
          instructions: "AGENTS.md",
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(201);

    const data = await response.json();

    // Verify the returned name is normalized to lowercase
    expect(data.name).toBe("my-researcher");

    // Get the compose to verify stored content
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes/${data.composeId}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const composeData = await getResponse.json();

    // Verify the stored agents key is lowercase
    expect(composeData.content.agents["my-researcher"]).toBeDefined();
    expect(composeData.content.agents["My-Researcher"]).toBeUndefined();
  });

  it("demonstrates the CLI vs Server storage name mismatch", async () => {
    const originalAgentName = "My-Researcher";

    // Step 1: Simulate what CLI does - uses original agent name
    const cliStorageName = getInstructionsStorageName(originalAgentName);
    expect(cliStorageName).toBe("agent-instructions@My-Researcher");

    // Step 2: Create volume with CLI's storage name (mixed case)
    await createTestVolume(cliStorageName);

    // Step 3: Create compose - server will normalize to lowercase
    const config = {
      version: "1.0",
      agents: {
        [originalAgentName]: {
          framework: "claude-code",
          instructions: "AGENTS.md",
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    // Server normalized the name
    expect(data.name).toBe("my-researcher");

    // Step 4: At runtime, the system would look for this storage name:
    const runtimeStorageName = getInstructionsStorageName(data.name);
    expect(runtimeStorageName).toBe("agent-instructions@my-researcher");

    // THE BUG: CLI uploaded "My-Researcher", runtime looks for "my-researcher"
    expect(cliStorageName).not.toBe(runtimeStorageName);
  });

  it("works correctly when agent name is already lowercase", async () => {
    const agentName = "my-researcher";

    // CLI storage name (lowercase)
    const cliStorageName = getInstructionsStorageName(agentName);
    expect(cliStorageName).toBe("agent-instructions@my-researcher");

    // Create volume
    await createTestVolume(cliStorageName);

    // Create compose
    const config = {
      version: "1.0",
      agents: {
        [agentName]: {
          framework: "claude-code",
          instructions: "AGENTS.md",
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    // Names match - no mismatch
    expect(data.name).toBe(agentName);

    const runtimeStorageName = getInstructionsStorageName(data.name);
    expect(runtimeStorageName).toBe(cliStorageName); // No mismatch!
  });

  /**
   * This test verifies the proposed fix:
   * CLI should normalize agent name to lowercase before uploading instructions
   */
  it("proposed fix: CLI should normalize agent name before upload", async () => {
    const originalAgentName = "My-Researcher";

    // PROPOSED FIX: CLI normalizes before upload
    const normalizedAgentName = originalAgentName.toLowerCase();
    const fixedCliStorageName = getInstructionsStorageName(normalizedAgentName);
    expect(fixedCliStorageName).toBe("agent-instructions@my-researcher");

    // Create volume with normalized name
    await createTestVolume(fixedCliStorageName);

    // Create compose - server normalizes to same lowercase name
    const config = {
      version: "1.0",
      agents: {
        [originalAgentName]: {
          framework: "claude-code",
          instructions: "AGENTS.md",
        },
      },
    };

    const request = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: config }),
      },
    );

    const response = await POST(request);
    const data = await response.json();

    // Runtime storage name
    const runtimeStorageName = getInstructionsStorageName(data.name);

    // WITH FIX: Names match!
    expect(fixedCliStorageName).toBe(runtimeStorageName);
  });
});

describe("Storage Name Case Behavior", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("should allow uploading volume with uppercase letters in name", async () => {
    // Test if storage API accepts uppercase letters
    const upperCaseName = "agent-instructions@My-Researcher";

    // Try to create volume with uppercase name
    const result = await createTestVolume(upperCaseName);

    // If this succeeds, uppercase is allowed
    expect(result.name).toBe(upperCaseName);
    expect(result.versionId).toBeDefined();
  });

  it("should treat uppercase and lowercase storage names as different", async () => {
    // Create two volumes with same name but different case
    const upperCaseName = "agent-instructions@My-Researcher";
    const lowerCaseName = "agent-instructions@my-researcher";

    const result1 = await createTestVolume(upperCaseName);
    const result2 = await createTestVolume(lowerCaseName);

    // They should be treated as different storages
    // (Storage lookup is case-sensitive)
    expect(result1.name).toBe(upperCaseName);
    expect(result2.name).toBe(lowerCaseName);
  });
});
