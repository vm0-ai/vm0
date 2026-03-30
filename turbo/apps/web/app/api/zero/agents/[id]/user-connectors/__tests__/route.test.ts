import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../route";
import { POST as postAgentRoute } from "../../../route";
import {
  createTestRequest,
  createTestCliToken,
  seedSeedSkills,
  clearSkillsData,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();

let user: UserContext;
let testCliToken: string;
let testOrgSlug: string;

/** Create an agent via the API, returning its agentId (= UUID). */
async function createAgent(): Promise<string> {
  const orgParam = `?org=${testOrgSlug}`;
  const res = await postAgentRoute(
    createTestRequest(`http://localhost:3000/api/zero/agents${orgParam}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${testCliToken}`,
      },
      body: JSON.stringify({}),
    }),
  );
  expect(res.status).toBe(201);
  const data = await res.json();
  return data.agentId as string;
}

function getUserConnectors(agentId: string, token: string, orgSlug?: string) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return GET(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/user-connectors${orgParam}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
}

function putUserConnectors(
  agentId: string,
  body: { enabledTypes: string[] },
  token: string,
  orgSlug?: string,
) {
  const orgParam = orgSlug ? `?org=${orgSlug}` : "";
  return PUT(
    createTestRequest(
      `http://localhost:3000/api/zero/agents/${agentId}/user-connectors${orgParam}`,
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

describe("User Connectors API", () => {
  beforeEach(async () => {
    context.setupMocks();
    await clearSkillsData();
    await seedSeedSkills();
    user = await context.setupUser();
    testCliToken = await createTestCliToken(user.userId);
    testOrgSlug = `org-${user.userId.slice(-8)}`;
  });

  describe("GET /api/zero/agents/:id/user-connectors", () => {
    it("should return empty enabledTypes for new agent", async () => {
      const agentId = await createAgent();

      const res = await getUserConnectors(agentId, testCliToken, testOrgSlug);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual([]);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const res = await getUserConnectors(fakeId, testCliToken, testOrgSlug);

      expect(res.status).toBe(404);
    });

    it("should return 401 without auth", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: null });
      const res = await getUserConnectors(agentId, "no-token", testOrgSlug);

      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/zero/agents/:id/user-connectors", () => {
    it("should set connector permissions", async () => {
      const agentId = await createAgent();

      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "slack"] },
        testCliToken,
        testOrgSlug,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(["github", "slack"]);

      // Verify via GET
      const getRes = await getUserConnectors(
        agentId,
        testCliToken,
        testOrgSlug,
      );
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
        testOrgSlug,
      );

      // Replace with different set
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["linear"] },
        testCliToken,
        testOrgSlug,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual(["linear"]);

      // Verify old ones are removed
      const getRes = await getUserConnectors(
        agentId,
        testCliToken,
        testOrgSlug,
      );
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(["linear"]);
    });

    it("should clear all permissions with empty array", async () => {
      const agentId = await createAgent();

      // Set some
      await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        testCliToken,
        testOrgSlug,
      );

      // Clear all
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: [] },
        testCliToken,
        testOrgSlug,
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.enabledTypes).toEqual([]);

      // Verify via GET that permissions are cleared
      const getRes = await getUserConnectors(
        agentId,
        testCliToken,
        testOrgSlug,
      );
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual([]);
    });

    it("should return 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      const res = await putUserConnectors(
        fakeId,
        { enabledTypes: ["github"] },
        testCliToken,
        testOrgSlug,
      );

      expect(res.status).toBe(404);
    });

    it("should return 401 without auth", async () => {
      const agentId = await createAgent();

      mockClerk({ userId: null });
      const res = await putUserConnectors(
        agentId,
        { enabledTypes: ["github"] },
        "no-token",
        testOrgSlug,
      );

      expect(res.status).toBe(401);
    });

    it("should isolate permissions between users", async () => {
      const agentId = await createAgent();

      // User 1 sets permissions
      await putUserConnectors(
        agentId,
        { enabledTypes: ["github", "slack"] },
        testCliToken,
        testOrgSlug,
      );

      // Create user 2 in the same org
      const user2 = await context.setupUser({ prefix: "test-user2" });
      const token2 = await createTestCliToken(user2.userId);
      const orgSlug2 = `org-${user2.userId.slice(-8)}`;

      // User 2 sets different permissions on their own agent
      const agentId2 = await (async () => {
        const orgParam = `?org=${orgSlug2}`;
        const res = await postAgentRoute(
          createTestRequest(
            `http://localhost:3000/api/zero/agents${orgParam}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token2}`,
              },
              body: JSON.stringify({}),
            },
          ),
        );
        return ((await res.json()) as { agentId: string }).agentId;
      })();

      await putUserConnectors(
        agentId2,
        { enabledTypes: ["linear"] },
        token2,
        orgSlug2,
      );

      // Verify user 1's permissions unchanged
      const getRes = await getUserConnectors(
        agentId,
        testCliToken,
        testOrgSlug,
      );
      const getData = await getRes.json();
      expect(getData.enabledTypes).toEqual(
        expect.arrayContaining(["github", "slack"]),
      );
      expect(getData.enabledTypes).toHaveLength(2);

      // Verify user 2's permissions are separate
      const getRes2 = await getUserConnectors(agentId2, token2, orgSlug2);
      const getData2 = await getRes2.json();
      expect(getData2.enabledTypes).toEqual(["linear"]);
    });
  });
});
