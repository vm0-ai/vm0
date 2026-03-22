import { describe, it, expect, beforeEach } from "vitest";
import { GET, POST } from "../route";
import { GET as listGET } from "../list/route";
import { GET as getByIdGET, DELETE as deleteDELETE } from "../[id]/route";
import { GET as versionsGET } from "../versions/route";
import { GET as instructionsGET } from "../[id]/instructions/route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgMembersCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";

const context = testContext();

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

      // Switch to sandbox auth
      const orgSlug = `org-${user.userId.slice(-8)}`;
      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}&org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe(agentName);
    });

    it("sandbox token without agent:read gets 403", async () => {
      const agentName = `test-sandbox-noread-${Date.now()}`;
      await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "artifact:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes?name=${agentName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await GET(request);
      expect(response.status).toBe(403);
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

      const orgSlug = `org-${user.userId.slice(-8)}`;
      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes?org=${orgSlug}`,
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

    it("sandbox token with agent:read but not agent:write gets 403", async () => {
      const agentName = `test-sandbox-nocreate-${Date.now()}`;

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

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
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/agent/composes/list", () => {
    it("sandbox token with agent:read can list composes", async () => {
      const agentName = `test-sandbox-list-${Date.now()}`;
      await createTestCompose(agentName);

      // Seed org cache so resolveOrg works without Clerk session
      await insertOrgMembersCacheEntry({
        userId: user.userId,
        orgId: user.orgId,
        role: "admin",
      });

      const orgSlug = `org-${user.userId.slice(-8)}`;
      mockClerk({ userId: null, orgId: user.orgId });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/list?org=${orgSlug}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await listGET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.composes).toBeDefined();
      expect(Array.isArray(data.composes)).toBe(true);
    });

    it("sandbox token without agent:read gets 403", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "artifact:write",
      ]);

      const request = createTestRequest(
        "http://localhost:3000/api/agent/composes/list",
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await listGET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/agent/composes/:id", () => {
    it("sandbox token with agent:read can get compose by id", async () => {
      const agentName = `test-sandbox-getid-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getByIdGET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.name).toBe(agentName);
    });

    it("sandbox token without agent:read gets 403", async () => {
      const agentName = `test-sandbox-nogetid-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "artifact:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await getByIdGET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("DELETE /api/agent/composes/:id", () => {
    it("sandbox token with agent:write cannot delete compose", async () => {
      const agentName = `test-sandbox-delete-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await deleteDELETE(request);
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.message).toContain("sandbox");
    });

    it("sandbox token with all capabilities cannot delete compose", async () => {
      const agentName = `test-sandbox-delete-all-caps-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
        "agent:write",
        "artifact:read",
        "artifact:write",
        "agent-run:read",
        "agent-run:write",
        "schedule:read",
        "schedule:write",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await deleteDELETE(request);
      expect(response.status).toBe(403);
    });

    it("sandbox token without agent:write gets 403", async () => {
      const agentName = `test-sandbox-nodelete-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await deleteDELETE(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/agent/composes/versions", () => {
    it("sandbox token with agent:read can resolve version", async () => {
      const agentName = `test-sandbox-versions-${Date.now()}`;
      const { composeId, versionId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/versions?composeId=${composeId}&version=latest`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await versionsGET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.versionId).toBe(versionId);
    });

    it("sandbox token without agent:read gets 403", async () => {
      const agentName = `test-sandbox-noversions-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "artifact:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/versions?composeId=${composeId}&version=latest`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await versionsGET(request);
      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/agent/composes/:id/instructions", () => {
    it("sandbox token with agent:read can access instructions endpoint", async () => {
      const agentName = `test-sandbox-instructions-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "agent:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await instructionsGET(request);
      // Should pass auth and reach compose lookup - returns 200 with null content
      // (no storage volume exists for test compose)
      expect(response.status).toBe(200);
    });

    it("sandbox token without agent:read gets 403", async () => {
      const agentName = `test-sandbox-noinstructions-${Date.now()}`;
      const { composeId } = await createTestCompose(agentName);

      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-123", [
        "artifact:read",
      ]);

      const request = createTestRequest(
        `http://localhost:3000/api/agent/composes/${composeId}/instructions`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const response = await instructionsGET(request);
      expect(response.status).toBe(403);
    });
  });
});
