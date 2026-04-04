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

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("POST /api/zero/agents (create)", () => {
    it("sandbox token cannot create agent", async () => {
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents`,
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
    it("sandbox token cannot get agent", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name", () => {
    it("sandbox token cannot update agent", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000`,
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
    it("sandbox token cannot get instructions", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000/instructions`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getInstructions(request);
      expect(response.status).toBe(403);
    });
  });

  describe("PUT /api/zero/agents/:name/instructions", () => {
    it("sandbox token cannot update instructions", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123");

      const request = createTestRequest(
        `http://localhost:3000/api/zero/agents/00000000-0000-0000-0000-000000000000/instructions`,
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
