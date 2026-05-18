import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestVolume,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../src/lib/auth/sandbox-token";
import { SUPPORTED_FRAMEWORKS } from "@vm0/core/frameworks";
import { getInstructionsStorageName } from "@vm0/core/storage-names";

vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

const context = testContext();

// ---------------------------------------------------------------------------
// GET /api/agent/composes?name=<name>  (from get-by-name.test.ts)
// ---------------------------------------------------------------------------

describe("GET /api/agent/composes?name=<name>", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("should return compose when name exists", async () => {
    const agentName = `test-get-by-name-${Date.now()}`;

    // Create compose via API helper
    const { composeId } = await createTestCompose(agentName);

    // Get it by name
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
    expect(getData.content.agents[agentName]).toBeDefined();
    expect(getData.createdAt).toBeDefined();
    expect(getData.updatedAt).toBeDefined();
  });

  it("should return 404 when name does not exist", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=nonexistent-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
    expect(getData.error.message).toContain("nonexistent-agent");
  });

  it("should return 400 when name query parameter is missing", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(400);
    // Zod validation returns "expected string, received undefined" for missing required params
    expect(getData.error.message).toContain("expected string");
  });

  it("should only return compose for authenticated user", async () => {
    const agentName = `test-user-isolation-${Date.now()}`;

    // Create compose as current user
    await createTestCompose(agentName);

    // Create another user (setupUser also updates mockClerk to the new user)
    await context.setupUser({ prefix: "other-user" });

    // Try to get it as another user (mockClerk was updated by setupUser)
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");

    // Switch back to original user and verify they can access it
    mockClerk({ userId: user.userId });

    const verifyRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const verifyResponse = await GET(verifyRequest);
    expect(verifyResponse.status).toBe(200);
  });

  it("should handle URL-encoded names correctly", async () => {
    const agentName = `test-agent-with-hyphens-${Date.now()}`;

    // Create compose via API helper
    const { composeId } = await createTestCompose(agentName);

    // Get it with URL-encoded name
    const encodedName = encodeURIComponent(agentName);
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${encodedName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should reject unauthenticated request", async () => {
    mockClerk({ userId: null });

    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=any-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(401);
    expect(getData.error.message).toContain("Not authenticated");
  });

  it("should return org member agent via cross-org lookup", async () => {
    const agentName = `test-org-member-agent-${Date.now()}`;

    // Create compose as owner
    const { composeId } = await createTestCompose(agentName);

    // Switch to recipient user who is a member of the owner's org
    const recipient = await context.setupUser({ prefix: "recipient" });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: recipient.userId,
      cachedAt: new Date(),
    });
    // Recipient accesses the owner's org as their active org
    mockClerk({ userId: recipient.userId, orgId: user.orgId });

    // Access the agent via the owner's org (set as active org in session)
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should return 404 for non-member agent via cross-org lookup", async () => {
    const agentName = `test-not-shared-${Date.now()}`;

    // Create compose as owner (no permission granted)
    await createTestCompose(agentName);

    // Switch to another user with no permission
    await context.setupUser({ prefix: "unauthorized" });

    // Try to access via cross-org lookup
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
  });

  it("should return own agent without ?org= parameter", async () => {
    const agentName = `test-own-agent-${Date.now()}`;

    // Create compose as current user
    const { composeId } = await createTestCompose(agentName);

    // Access without org param (uses resolveOrg for own org)
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should return org member agent via cross-org lookup using orgId in session", async () => {
    const agentName = `test-shared-org-${Date.now()}`;

    // Create compose as owner
    const { composeId } = await createTestCompose(agentName);

    // Switch to recipient user who is a member of the owner's org
    const recipient = await context.setupUser({ prefix: "recipient-org" });
    await insertOrgMembersCacheEntry({
      orgId: user.orgId,
      userId: recipient.userId,
      cachedAt: new Date(),
    });
    // Recipient accesses the owner's org as their active org (orgId in session)
    mockClerk({ userId: recipient.userId, orgId: user.orgId });

    // Access the agent using owner's org as the active org in session
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(200);
    expect(getData.id).toBe(composeId);
    expect(getData.name).toBe(agentName);
  });

  it("should return 404 for non-member agent via cross-org lookup with ?org=", async () => {
    const agentName = `test-not-shared-org-${Date.now()}`;

    // Create compose as owner (no permission granted)
    await createTestCompose(agentName);

    // Switch to another user with no permission
    await context.setupUser({ prefix: "unauthorized-org" });

    // Try to access via cross-org lookup
    const getRequest = createTestRequest(
      `http://localhost:3000/api/agent/composes?name=${agentName}`,
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
  });

  it("should return 404 for invalid org slug in cross-org lookup", async () => {
    const getRequest = createTestRequest(
      "http://localhost:3000/api/agent/composes?name=any-agent",
      { method: "GET" },
    );

    const getResponse = await GET(getRequest);
    const getData = await getResponse.json();

    expect(getResponse.status).toBe(404);
    expect(getData.error.message).toContain("Agent compose not found");
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/composes — upsert behavior  (from upsert.test.ts)
// ---------------------------------------------------------------------------

describe("Agent Compose Upsert Behavior", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  describe("POST /api/agent/composes", () => {
    it("should create new compose when name does not exist", async () => {
      const agentName = `test-agent-create-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
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

      expect(response.status).toBe(201);
      expect(data.action).toBe("created");
      expect(data.name).toBe(agentName);
      expect(data.composeId).toBeDefined();
      expect(data.versionId).toBeDefined();
      expect(data.updatedAt).toBeDefined();
    });

    it("should store compose content without image or working_dir", async () => {
      const agentName = `test-no-deprecated-fields-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
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

      // Get the created compose to verify no deprecated fields
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      const agent = composeData.content.agents[agentName];
      expect(agent.framework).toBe("claude-code");
      expect(agent.image).toBeUndefined();
      expect(agent.working_dir).toBeUndefined();
    });

    it("should silently ignore apps field in config", async () => {
      const agentName = `test-apps-ignored-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
            apps: ["github"],
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
    });

    it("should strip unknown fields like image and working_dir from input", async () => {
      const agentName = `test-strip-unknown-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
            image: "custom/image:v1",
            working_dir: "/custom/path",
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

      // Get the created compose to verify unknown fields were stripped
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      const agent = composeData.content.agents[agentName];
      expect(agent.framework).toBe("claude-code");
      expect(agent.image).toBeUndefined();
      expect(agent.working_dir).toBeUndefined();
    });

    it("should strip deprecated skills field from persisted content", async () => {
      const agentName = `test-strip-skills-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
            skills: [
              "https://github.com/example/agent/tree/main/.claude/skills/slack",
            ],
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

      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      const agent = composeData.content.agents[agentName];
      expect(agent.framework).toBe("claude-code");
      expect(agent.skills).toBeUndefined();
    });

    it("should update existing compose when name matches", async () => {
      const agentName = `test-agent-update-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            description: "Initial description",
            framework: "claude-code",
          },
        },
      };

      // First create
      const request1 = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );

      const response1 = await POST(request1);
      const data1 = await response1.json();

      expect(data1.action).toBe("created");
      const composeId = data1.composeId;

      // Then update with same name
      const updatedConfig = {
        ...config,
        agents: {
          [agentName]: {
            ...config.agents[agentName],
            description: "Updated description",
          },
        },
      };

      const request2 = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: updatedConfig }),
        },
      );

      const response2 = await POST(request2);
      const data2 = await response2.json();

      expect(response2.status).toBe(200);
      expect(data2.action).toBe("created"); // New version created (different content hash)
      expect(data2.composeId).toBe(composeId); // Same compose ID
      expect(data2.versionId).not.toBe(data1.versionId); // Different version (different content)
      expect(data2.name).toBe(agentName);
      expect(data2.updatedAt).toBeDefined();

      // Verify the compose was actually updated
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      expect(composeData.content.agents[agentName].description).toBe(
        "Updated description",
      );
    });

    it("should maintain unique constraint on (userId, name)", async () => {
      const agentName = `test-unique-constraint-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
          },
        },
      };

      // Create compose for user 1 (current user from context)
      const request1 = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );

      const response1 = await POST(request1);
      const data1 = await response1.json();
      expect(response1.status).toBe(201);

      // Create a second user
      const user2 = await context.setupUser({ prefix: "user-2" });
      void user2; // Mark as used - setupUser also mocks Clerk for this user

      // Create compose with same name for user 2 (should succeed)
      const request2 = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: config }),
        },
      );

      const response2 = await POST(request2);
      const data2 = await response2.json();
      expect(response2.status).toBe(201);

      // Should be different compose IDs
      expect(data1.composeId).not.toBe(data2.composeId);
    });
  });

  describe("agent name validation", () => {
    it("should reject compose with multiple agents", async () => {
      const config = {
        version: "1.0",
        agents: {
          "agent-one": {
            framework: "claude-code",
          },
          "agent-two": {
            framework: "claude-code",
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

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toBe(
        "Multiple agents not supported yet. Only one agent allowed.",
      );
    });

    it("should reject compose with invalid name format", async () => {
      const config = {
        version: "1.0",
        agents: {
          ab: {
            // Too short name
            framework: "claude-code",
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

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("Invalid agent name");
    });

    it("should accept valid name with hyphens", async () => {
      const agentName = `my-test-agent-123-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
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
    });
  });

  describe("framework validation", () => {
    it("should reject unsupported framework", async () => {
      const agentName = `test-unsupported-framework-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "unsupported-framework",
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

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("Invalid option");
      for (const framework of SUPPORTED_FRAMEWORKS) {
        expect(data.error.message).toContain(framework);
      }
    });

    it("should accept claude-code framework", async () => {
      const agentName = `test-claude-code-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
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
    });
  });
});

// ---------------------------------------------------------------------------
// Instructions Volume Case Sensitivity  (from instructions-volume.test.ts)
// ---------------------------------------------------------------------------

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
      `http://localhost:3000/api/agent/composes?name=${data.name}`,
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

// ---------------------------------------------------------------------------
// Sandbox capability enforcement  (from sandbox-capability.test.ts)
// ---------------------------------------------------------------------------

describe("Sandbox capability enforcement on compose routes", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("GET /api/agent/composes (getByName)", () => {
    it("sandbox token with agent:read can get compose by name", async () => {
      const agentName = `test-sandbox-get-${Date.now()}`;
      await createTestCompose(agentName);

      // Seed org cache so resolveOrg works without Clerk session
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      // Switch to sandbox auth (no Clerk session)
      mockClerk({ userId: null });
      // Zero token carries orgId so resolveOrg can resolve the org
      const token = await generateZeroToken(user.userId, "run-123", user.orgId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe(agentName);
    });

    it("sandbox token with any capability can get compose by name", async () => {
      const agentName = `test-sandbox-anycap-${Date.now()}`;
      await createTestCompose(agentName);

      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-123", user.orgId);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe(agentName);
    });
  });

  describe("POST /api/agent/composes (create)", () => {
    it("sandbox token with agent:write can create compose", async () => {
      const agentName = `test-sandbox-create-${Date.now()}`;

      // Seed org cache so resolveOrg works without Clerk session
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-123", user.orgId);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: {
              version: "1.0",
              agents: {
                [agentName]: { framework: "claude-code" },
              },
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.name).toBe(agentName);
    });

    it("sandbox token with any capability can create compose", async () => {
      const agentName = `test-sandbox-create-any-${Date.now()}`;

      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-123", user.orgId);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            content: {
              version: "1.0",
              agents: {
                [agentName]: { framework: "claude-code" },
              },
            },
          }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(201);
    });
  });
});
