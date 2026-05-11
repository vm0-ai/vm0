import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { GET, PUT } from "../route";
import { POST as postAgentRoute } from "../../../route";
import { POST as postCustomConnectors } from "../../../../custom-connectors/route";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

let user: UserContext;
let testCliToken: string;

async function createAgent(token = testCliToken): Promise<string> {
  const res = await postAgentRoute(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    }),
  );
  expect(res.status).toBe(201);
  const data = await res.json();
  return data.agentId as string;
}

async function createConnector(suffix: string): Promise<{ id: string }> {
  const res = await postCustomConnectors(
    createTestRequest(`http://localhost:3000/api/zero/custom-connectors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: `Test ${suffix}`,
        prefixes: [`https://api.test-${suffix}.example/`],
        headerName: "Authorization",
        headerTemplate: "Bearer {{secret}}",
      }),
    }),
  );
  expect(res.status).toBe(201);
  const data = await res.json();
  return { id: data.id as string };
}

function getCustomConnectors(agentId: string, token: string) {
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function getCustomConnectorsFromSession(agentId: string) {
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
      { method: "GET" },
    ),
  );
}

function putCustomConnectors(
  agentId: string,
  body: { enabledIds: string[] },
  token: string,
) {
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

function putCustomConnectorsFromSession(
  agentId: string,
  body: { enabledIds: string[] },
) {
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("Agent Custom Connectors API", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    // setupUser defaults the mocked Clerk session to org:member; promote to
    // admin so the caller can create custom connectors via POST.
    mockClerk({ userId: user.userId, orgId: user.orgId, orgRole: "org:admin" });
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("GET /api/zero/agents/:id/custom-connectors", () => {
    it("returns empty enabledIds for new agent", async () => {
      const agentId = await createAgent();

      const res = await getCustomConnectors(agentId, testCliToken);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledIds).toEqual([]);
    });

    it("returns 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await getCustomConnectors(fakeId, testCliToken);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toStrictEqual({
        error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
      });
    });

    it("returns 401 without auth", async () => {
      const agentId = await createAgent();
      mockClerk({ userId: null });
      const res = await getCustomConnectors(agentId, "no-token");
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 401 when the authenticated session has no active organization", async () => {
      const agentId = await createAgent();
      mockClerk({ userId: user.userId, orgId: null });

      const res = await getCustomConnectorsFromSession(agentId);

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });

    it("returns 403 for a sandbox token without agent:read capability", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(
        user.userId,
        "run-1",
        user.orgId,
      );

      const res = await getCustomConnectors(randomUUID(), token);

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toStrictEqual({
        error: {
          message: "Missing required capability: agent:read",
          code: "FORBIDDEN",
        },
      });
    });

    it("returns 404 when the agent belongs to a different org", async () => {
      const otherUser = await context.setupUser({ prefix: "other-agent-user" });
      mockClerk({
        userId: otherUser.userId,
        orgId: otherUser.orgId,
        orgRole: "org:admin",
      });
      const otherToken = await createTestCliToken(
        otherUser.userId,
        undefined,
        otherUser.orgId,
      );
      const otherAgentId = await createAgent(otherToken);

      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });
      const res = await getCustomConnectors(otherAgentId, testCliToken);

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toStrictEqual({
        error: {
          message: `Agent not found: ${otherAgentId}`,
          code: "NOT_FOUND",
        },
      });
    });
  });

  describe("PUT /api/zero/agents/:id/custom-connectors", () => {
    it("sets enabled ids and round-trips via GET", async () => {
      const agentId = await createAgent();
      const c1 = await createConnector("a");
      const c2 = await createConnector("b");

      const res = await putCustomConnectors(
        agentId,
        { enabledIds: [c1.id, c2.id] },
        testCliToken,
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(new Set(data.enabledIds)).toEqual(new Set([c1.id, c2.id]));

      const getRes = await getCustomConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(new Set(getData.enabledIds)).toEqual(new Set([c1.id, c2.id]));
    });

    it("replaces the list atomically", async () => {
      const agentId = await createAgent();
      const c1 = await createConnector("r1");
      const c2 = await createConnector("r2");

      await putCustomConnectors(agentId, { enabledIds: [c1.id] }, testCliToken);
      const res = await putCustomConnectors(
        agentId,
        { enabledIds: [c2.id] },
        testCliToken,
      );
      expect(res.status).toBe(200);

      const getRes = await getCustomConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledIds).toEqual([c2.id]);
    });

    it("clears authorizations with empty array", async () => {
      const agentId = await createAgent();
      const c1 = await createConnector("clr");

      await putCustomConnectors(agentId, { enabledIds: [c1.id] }, testCliToken);
      const res = await putCustomConnectors(
        agentId,
        { enabledIds: [] },
        testCliToken,
      );
      expect(res.status).toBe(200);

      const getRes = await getCustomConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledIds).toEqual([]);
    });

    it("returns 400 for a cross-org custom connector id", async () => {
      const agentId = await createAgent();

      // Build a second user+org with its own connector. Passing a distinct
      // prefix bypasses the default-user cache in setupUser so we get a
      // genuinely different org.
      const otherUser = await context.setupUser({ prefix: "other-user" });
      mockClerk({
        userId: otherUser.userId,
        orgId: otherUser.orgId,
        orgRole: "org:admin",
      });
      const otherConnector = await createConnector("other");

      // Switch back to the original user.
      mockClerk({
        userId: user.userId,
        orgId: user.orgId,
        orgRole: "org:admin",
      });

      const res = await putCustomConnectors(
        agentId,
        { enabledIds: [otherConnector.id] },
        testCliToken,
      );
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toStrictEqual({
        error: {
          message: `Unknown custom connector ids: ${otherConnector.id}`,
          code: "VALIDATION_ERROR",
        },
      });
    });

    it("returns 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await putCustomConnectors(
        fakeId,
        { enabledIds: [] },
        testCliToken,
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toStrictEqual({
        error: { message: `Agent not found: ${fakeId}`, code: "NOT_FOUND" },
      });
    });

    it("returns 401 when the authenticated session has no active organization", async () => {
      const agentId = await createAgent();
      mockClerk({ userId: user.userId, orgId: null });

      const res = await putCustomConnectorsFromSession(agentId, {
        enabledIds: [],
      });

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });
  });
});
