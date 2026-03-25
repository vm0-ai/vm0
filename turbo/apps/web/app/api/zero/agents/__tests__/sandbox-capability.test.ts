import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET, PUT } from "../[id]/route";
import {
  GET as getInstructions,
  PUT as putInstructions,
} from "../[id]/instructions/route";
import {
  createTestCliToken,
  createTestRequest,
  insertOrgMembersCacheEntry,
  seedSeedSkills,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";

const context = testContext();

describe("Sandbox capability enforcement on zero agent routes", () => {
  let user: UserContext;
  let orgSlug: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    orgSlug = `org-${user.userId.slice(-8)}`;
    await seedSeedSkills();
  });

  describe("POST /api/zero/agents (create)", () => {
    it("sandbox token with agent:write can create agent", async () => {
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents?org=${orgSlug}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ connectors: [] }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(201);
    });

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents?org=${orgSlug}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ connectors: [] }),
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/zero/agents/:name", () => {
    it("sandbox token with agent:read can get agent", async () => {
      // First create an agent with a regular CLI token
      const cliUser = await context.setupUser();

      const cliToken = await createTestCliToken(cliUser.userId);
      const cliOrgSlug = `org-${cliUser.userId.slice(-8)}`;

      const createResponse = await POST(
        createTestRequest(
          `http://localhost:3000/api/zero/agents?org=${cliOrgSlug}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cliToken}`,
            },
            body: JSON.stringify({ connectors: [] }),
          },
        ),
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Now access with sandbox token
      await insertOrgMembersCacheEntry({
        userId: cliUser.userId,
        orgId: cliUser.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: cliUser.orgId });
      const token = await generateSandboxToken(cliUser.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/${created.agentId}?org=${cliOrgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(200);
    });

    it("sandbox token without agent:read gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "schedule:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("sandbox token with agent:write can update agent", async () => {
      // First create an agent with a regular CLI token
      const cliUser = await context.setupUser();

      const cliToken = await createTestCliToken(cliUser.userId);
      const cliOrgSlug = `org-${cliUser.userId.slice(-8)}`;

      const createResponse = await POST(
        createTestRequest(
          `http://localhost:3000/api/zero/agents?org=${cliOrgSlug}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cliToken}`,
            },
            body: JSON.stringify({ connectors: [] }),
          },
        ),
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Now update with sandbox token
      await insertOrgMembersCacheEntry({
        userId: cliUser.userId,
        orgId: cliUser.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: cliUser.orgId });
      const token = await generateSandboxToken(cliUser.userId, "run-123", [
        "agent:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/${created.agentId}?org=${cliOrgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            connectors: [],
            displayName: "Updated via sandbox",
          }),
        },
      );

      const response = await PUT(request);
      expect(response.status).toBe(200);
    });

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000?org=${orgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ connectors: [] }),
        },
      );

      const response = await PUT(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/zero/agents/:name/instructions", () => {
    it("sandbox token with agent:read can get instructions", async () => {
      // First create an agent with a regular CLI token
      const cliUser = await context.setupUser();

      const cliToken = await createTestCliToken(cliUser.userId);
      const cliOrgSlug = `org-${cliUser.userId.slice(-8)}`;

      const createResponse = await POST(
        createTestRequest(
          `http://localhost:3000/api/zero/agents?org=${cliOrgSlug}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cliToken}`,
            },
            body: JSON.stringify({ connectors: [] }),
          },
        ),
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Now access instructions with sandbox token
      await insertOrgMembersCacheEntry({
        userId: cliUser.userId,
        orgId: cliUser.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: cliUser.orgId });
      const token = await generateSandboxToken(cliUser.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/${created.agentId}/instructions?org=${cliOrgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getInstructions(request);
      expect(response.status).toBe(200);
    });

    it("sandbox token without agent:read gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "schedule:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000/instructions?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getInstructions(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name/instructions", () => {
    it("sandbox token with agent:write can update instructions", async () => {
      // First create an agent with a regular CLI token
      const cliUser = await context.setupUser();

      const cliToken = await createTestCliToken(cliUser.userId);
      const cliOrgSlug = `org-${cliUser.userId.slice(-8)}`;

      const createResponse = await POST(
        createTestRequest(
          `http://localhost:3000/api/zero/agents?org=${cliOrgSlug}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cliToken}`,
            },
            body: JSON.stringify({ connectors: [] }),
          },
        ),
      );
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json();

      // Now update instructions with sandbox token
      await insertOrgMembersCacheEntry({
        userId: cliUser.userId,
        orgId: cliUser.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: cliUser.orgId });
      const token = await generateSandboxToken(cliUser.userId, "run-123", [
        "agent:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/${created.agentId}/instructions?org=${cliOrgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: "# Updated Instructions" }),
        },
      );

      const response = await putInstructions(request);
      expect(response.status).toBe(200);
    });

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000/instructions?org=${orgSlug}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: "# Instructions" }),
        },
      );

      const response = await putInstructions(request);
      expect(response.status).toBe(403);
    });
  });
});
