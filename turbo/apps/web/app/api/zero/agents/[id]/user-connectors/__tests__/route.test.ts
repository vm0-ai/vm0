import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../route";
import { POST as postAgentRoute } from "../../../route";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { setComposeHeadVersion } from "../../../../../../../src/__tests__/db-test-seeders/agents";
import { createTestUserConnector } from "../../../../../../../src/__tests__/db-test-seeders/connectors";
import { getComposeHeadVersion } from "../../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { signSandboxJwtForTests } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

let user: UserContext;
let testCliToken: string;

const unauthorizedBody = {
  error: { message: "Not authenticated", code: "UNAUTHORIZED" },
};

const missingAgentReadBody = {
  error: {
    message: "Missing required capability: agent:read",
    code: "FORBIDDEN",
  },
};

function agentNotFoundBody(agentId: string) {
  return {
    error: {
      message: `Agent not found: ${agentId}`,
      code: "NOT_FOUND",
    },
  };
}

function bearerHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function expectJsonBody(res: Response, expected: unknown): Promise<void> {
  expect(await res.json()).toStrictEqual(expected);
}

function zeroTokenWithoutAgentRead(authUser: UserContext): string {
  const seconds = Math.floor(Date.now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: authUser.userId,
    orgId: authUser.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["file:read"],
    iat: seconds,
    exp: seconds + 60,
  });
}

/** Create an agent via the API, returning its agentId (= UUID). */
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

function getUserConnectors(agentId: string, token?: string) {
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/user-connectors`,
      {
        method: "GET",
        headers: bearerHeaders(token),
      },
    ),
  );
}

function putUserConnectors(
  agentId: string,
  body: { enabledTypes: string[] },
  token?: string,
) {
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/user-connectors`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...bearerHeaders(token),
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("User Connectors API", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
  });

  describe("GET /api/zero/agents/:id/user-connectors", () => {
    it("should return empty enabledTypes for new agent", async () => {
      const agentId = await createAgent();

      const res = await getUserConnectors(agentId, testCliToken);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual([]);
    });

    it("should ignore connector grants for removed connector types", async () => {
      const agentId = await createAgent();
      await createTestUserConnector(
        user.orgId,
        user.userId,
        agentId,
        "nano-banana",
      );
      await createTestUserConnector(user.orgId, user.userId, agentId, "github");

      const res = await getUserConnectors(agentId, testCliToken);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(["github"]);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const res = await getUserConnectors(fakeId, testCliToken);

      expect(res.status).toBe(404);
      await expectJsonBody(res, agentNotFoundBody(fakeId));
    });

    it("should return 401 without auth", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: null });
      const res = await getUserConnectors(agentId);

      expect(res.status).toBe(401);
      await expectJsonBody(res, unauthorizedBody);
    });

    it("should return 401 when the authenticated session has no organization", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: user.userId, orgId: null });
      const res = await getUserConnectors(agentId);

      expect(res.status).toBe(401);
      await expectJsonBody(res, unauthorizedBody);
    });

    it("should return 404 for a cross-org agent", async () => {
      const agentId = await createAgent();
      const otherUser = await context.setupUser({ prefix: "other-user" });
      const otherToken = await createTestCliToken(otherUser.userId);

      const res = await getUserConnectors(agentId, otherToken);

      expect(res.status).toBe(404);
      await expectJsonBody(res, agentNotFoundBody(agentId));
    });

    it("should return 403 for a zero token without agent:read capability", async () => {
      const agentId = await createAgent();
      const token = zeroTokenWithoutAgentRead(user);

      const res = await getUserConnectors(agentId, token);

      expect(res.status).toBe(403);
      await expectJsonBody(res, missingAgentReadBody);
    });
  });

  describe("PUT /api/zero/agents/:id/user-connectors", () => {
    it("should set connector permissions", async () => {
      const agentId = await createAgent();

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "slack"] },
        testCliToken,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(["github", "slack"]);

      // Verify via GET
      const getRes = await getUserConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(
        expect.arrayContaining(["github", "slack"]),
      );
      expect(getData.enabledTypes).toHaveLength(2);
    });

    it("should replace existing permissions atomically", async () => {
      const agentId = await createAgent();

      // Set initial
      await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "slack"] },
        testCliToken,
      );

      // Replace with different set
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["linear"] },
        testCliToken,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(["linear"]);

      // Verify old ones are removed
      const getRes = await getUserConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(["linear"]);
    });

    it("should dedupe duplicate entries in enabledTypes", async () => {
      const agentId = await createAgent();

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["slack", "github", "slack"] },
        testCliToken,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(
        expect.arrayContaining(["slack", "github"]),
      );
      expect(data.enabledTypes).toHaveLength(2);

      const getRes = await getUserConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(
        expect.arrayContaining(["slack", "github"]),
      );
      expect(getData.enabledTypes).toHaveLength(2);
    });

    it("should clear all permissions with empty array", async () => {
      const agentId = await createAgent();

      // Set some
      await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        testCliToken,
      );

      // Clear all
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: [] },
        testCliToken,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual([]);

      // Verify via GET that permissions are cleared
      const getRes = await getUserConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual([]);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const res = await putUserConnectors(
        fakeId,
        { enabledTypes: ["github"] },
        testCliToken,
      );

      expect(res.status).toBe(404);
      await expectJsonBody(res, agentNotFoundBody(fakeId));
    });

    it("should return 401 without auth", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: null });
      const res = await putUserConnectors(agentId, {
        enabledTypes: ["github"],
      });

      expect(res.status).toBe(401);
      await expectJsonBody(res, unauthorizedBody);
    });

    it("should return 401 when the authenticated session has no organization", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: user.userId, orgId: null });
      const res = await putUserConnectors(agentId, {
        enabledTypes: ["github"],
      });

      expect(res.status).toBe(401);
      await expectJsonBody(res, unauthorizedBody);
    });

    it("should return 403 for a zero token without agent:read capability", async () => {
      const agentId = await createAgent();
      const token = zeroTokenWithoutAgentRead(user);

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        token,
      );

      expect(res.status).toBe(403);
      await expectJsonBody(res, missingAgentReadBody);
    });

    it("should return 404 for a cross-org agent", async () => {
      const agentId = await createAgent();
      const otherUser = await context.setupUser({ prefix: "other-user" });
      const otherToken = await createTestCliToken(otherUser.userId);

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        otherToken,
      );

      expect(res.status).toBe(404);
      await expectJsonBody(res, agentNotFoundBody(agentId));
    });

    it("should return 400 for invalid connector types", async () => {
      const agentId = await createAgent();

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "not-a-connector"] },
        testCliToken,
      );

      expect(res.status).toBe(400);
      await expectJsonBody(res, {
        error: {
          message: "Invalid connector types: not-a-connector",
          code: "VALIDATION_ERROR",
        },
      });
    });

    it("should recompose when compose version is stale", async () => {
      const agentId = await createAgent();

      // Simulate a stale compose by pointing headVersionId to a fake hash
      const staleVersionId = "f".repeat(64);
      await setComposeHeadVersion(agentId, staleVersionId);

      // PUT user-connectors should trigger recompose since hash differs
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        testCliToken,
      );
      expect(res.status).toBe(200);

      // Verify compose was updated back to a fresh version
      const after = await getComposeHeadVersion(agentId);
      expect(after!.headVersionId).not.toBe(staleVersionId);
    });

    it("should skip recompose when compose version is current", async () => {
      const agentId = await createAgent();

      // Record the current head version (freshly built)
      const before = await getComposeHeadVersion(agentId);
      expect(before).toBeDefined();

      // PUT user-connectors - compose is already up to date, should skip recompose
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        testCliToken,
      );
      expect(res.status).toBe(200);

      // Verify compose version unchanged
      const after = await getComposeHeadVersion(agentId);
      expect(after!.headVersionId).toBe(before!.headVersionId);
    });

    it("should isolate permissions between users", async () => {
      const agentId = await createAgent();

      // User 1 sets permissions
      await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "slack"] },
        testCliToken,
      );

      // Create user 2 with its own org.
      const user2 = await context.setupUser({ prefix: "test-user2" });
      const token2 = await createTestCliToken(user2.userId);

      // User 2 sets different permissions on their own agent
      const agentId2 = await createAgent(token2);

      await putUserConnectors(agentId2, { enabledTypes: ["linear"] }, token2);

      // Verify user 1's permissions unchanged
      const getRes = await getUserConnectors(agentId, testCliToken);
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(
        expect.arrayContaining(["github", "slack"]),
      );
      expect(getData.enabledTypes).toHaveLength(2);

      // Verify user 2's permissions are separate
      const getRes2 = await getUserConnectors(agentId2, token2);
      const getData2 = await getRes2.json();
      expect(getData2.enabledTypes).toEqual(["linear"]);
    });
  });
});
