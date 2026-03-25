import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import { GET, PUT } from "../[id]/route";
import {
  GET as getInstructions,
  PUT as putInstructions,
} from "../[id]/instructions/route";
import {
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
    it("sandbox token cannot create agent (sandbox tokens have no capabilities)", async () => {
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123");

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

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

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
    it("sandbox token cannot get agent (sandbox tokens have no capabilities)", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(403);
    });

    it("sandbox token without agent:read gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("sandbox token cannot update agent (sandbox tokens have no capabilities)", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent?org=${orgSlug}`,
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

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent?org=${orgSlug}`,
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
    it("sandbox token cannot get instructions (sandbox tokens have no capabilities)", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent/instructions?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getInstructions(request);
      expect(response.status).toBe(403);
    });

    it("sandbox token without agent:read gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent/instructions?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getInstructions(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name/instructions", () => {
    it("sandbox token cannot update instructions (sandbox tokens have no capabilities)", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent/instructions?org=${orgSlug}`,
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

    it("sandbox token without agent:write gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/some-agent/instructions?org=${orgSlug}`,
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
