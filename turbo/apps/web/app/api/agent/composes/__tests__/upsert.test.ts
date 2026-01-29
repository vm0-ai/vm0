import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import { GET } from "../[id]/route";
import {
  createTestRequest,
  createTestCompose,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { SUPPORTED_FRAMEWORKS } from "@vm0/core";

// Mock external services only
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

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

    it("should resolve image and working_dir server-side", async () => {
      const agentName = `test-server-resolve-${Date.now()}`;
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

      // Get the created compose to verify resolved values
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${data.composeId}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      // Verify server resolved image and working_dir
      const agent = composeData.content.agents[agentName];
      expect(agent.image).toMatch(/^vm0\/claude-code:/);
      expect(agent.working_dir).toBe("/home/user/workspace");
    });

    it("should resolve github app-specific image", async () => {
      const agentName = `test-github-app-${Date.now()}`;
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
      const data = await response.json();

      expect(response.status).toBe(201);

      // Get the created compose to verify resolved values
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${data.composeId}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      // Verify server resolved github-specific image
      const agent = composeData.content.agents[agentName];
      expect(agent.image).toMatch(/^vm0\/claude-code-github:/);
    });

    it("should ignore deprecated image and working_dir fields from input", async () => {
      const agentName = `test-ignore-deprecated-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "claude-code",
            // These deprecated fields should be ignored
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
      const data = await response.json();

      expect(response.status).toBe(201);

      // Get the created compose to verify server-resolved values (not user-provided)
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${data.composeId}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      // Verify server resolved values, not user-provided deprecated values
      const agent = composeData.content.agents[agentName];
      expect(agent.image).toMatch(/^vm0\/claude-code:/);
      expect(agent.image).not.toBe("custom/image:v1");
      expect(agent.working_dir).toBe("/home/user/workspace");
      expect(agent.working_dir).not.toBe("/custom/path");
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
        `http://localhost:3000/api/agent/composes/${composeId}`,
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
      expect(data.error.message).toContain("Unsupported framework");
      expect(data.error.message).toContain(SUPPORTED_FRAMEWORKS.join(", "));
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

    it("should accept codex framework", async () => {
      const agentName = `test-codex-framework-${Date.now()}`;
      const config = {
        version: "1.0",
        agents: {
          [agentName]: {
            framework: "codex",
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

      // Get the created compose to verify codex image
      const data = await response.json();
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${data.composeId}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);
      const composeData = await getResponse.json();

      const agent = composeData.content.agents[agentName];
      expect(agent.image).toMatch(/^vm0\/codex:/);
    });
  });

  describe("GET /api/agent/composes/:id", () => {
    it("should return compose with name field", async () => {
      // Use the helper to create a compose
      const agentName = `test-get-compose-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      // Get compose
      const getRequest = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        { method: "GET" },
      );

      const getResponse = await GET(getRequest);

      expect(getResponse.status).toBe(200);
      const getData = await getResponse.json();

      expect(getData.name).toBe(agentName);
      expect(getData.content.agents[agentName]).toBeDefined();
    });
  });
});
