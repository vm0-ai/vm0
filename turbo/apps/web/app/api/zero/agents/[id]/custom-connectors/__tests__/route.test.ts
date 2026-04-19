import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "../route";
import { POST as postAgentRoute } from "../../../route";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  createCustomConnector,
  setCustomConnectorSecret,
} from "../../../../../../../src/lib/zero/custom-connector/custom-connector-service";
import { resolveCustomConnectorFirewalls } from "../../../../../../../src/lib/zero/custom-connector/resolve-custom-connectors";

const context = testContext();

let user: UserContext;
let testCliToken: string;

async function createAgent(): Promise<string> {
  const res = await postAgentRoute(
    createTestRequest(`http://localhost:3000/api/zero/agents`, {
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

async function createConnector(orgId: string, userId: string, suffix: string) {
  return createCustomConnector(orgId, userId, {
    displayName: `Test ${suffix}`,
    prefixes: [`https://api.test-${suffix}.example/`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  });
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

describe("Agent Custom Connectors API", () => {
  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
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
    });

    it("returns 401 without auth", async () => {
      const agentId = await createAgent();
      mockClerk({ userId: null });
      const res = await getCustomConnectors(agentId, "no-token");
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/zero/agents/:id/custom-connectors", () => {
    it("sets enabled ids and round-trips via GET", async () => {
      const agentId = await createAgent();
      const c1 = await createConnector(user.orgId, user.userId, "a");
      const c2 = await createConnector(user.orgId, user.userId, "b");

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
      const c1 = await createConnector(user.orgId, user.userId, "r1");
      const c2 = await createConnector(user.orgId, user.userId, "r2");

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
      const c1 = await createConnector(user.orgId, user.userId, "clr");

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
      const otherConnector = await createConnector(
        otherUser.orgId,
        otherUser.userId,
        "other",
      );

      // Re-mock back as the original user
      mockClerk({ userId: user.userId, orgId: user.orgId });

      const res = await putCustomConnectors(
        agentId,
        { enabledIds: [otherConnector.id] },
        testCliToken,
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent agent", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";
      const res = await putCustomConnectors(
        fakeId,
        { enabledIds: [] },
        testCliToken,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("resolveCustomConnectorFirewalls agent scope", () => {
    it("returns no firewall when user has secret but agent is not authorized", async () => {
      const agentId = await createAgent();
      const c1 = await createConnector(user.orgId, user.userId, "scoped-off");
      await setCustomConnectorSecret(
        user.orgId,
        user.userId,
        c1.id,
        "secret-value",
      );

      // Did NOT add to user_custom_connectors for this agent.
      const resolved = await resolveCustomConnectorFirewalls(
        user.orgId,
        user.userId,
        [],
      );
      expect(resolved.firewalls).toEqual([]);
    });

    it("returns the firewall when the agent is authorized for the connector", async () => {
      const c1 = await createConnector(user.orgId, user.userId, "scoped-on");
      await setCustomConnectorSecret(
        user.orgId,
        user.userId,
        c1.id,
        "secret-value",
      );

      const resolved = await resolveCustomConnectorFirewalls(
        user.orgId,
        user.userId,
        [c1.id],
      );
      expect(resolved.firewalls).toHaveLength(1);
      expect(resolved.firewalls[0]?.ref).toBe(c1.slug);
    });

    it("undefined allowedCustomIds preserves the legacy all-connectors behavior", async () => {
      const c1 = await createConnector(
        user.orgId,
        user.userId,
        "scoped-legacy",
      );
      await setCustomConnectorSecret(
        user.orgId,
        user.userId,
        c1.id,
        "secret-value",
      );

      const resolved = await resolveCustomConnectorFirewalls(
        user.orgId,
        user.userId,
      );
      expect(
        resolved.firewalls.some((f) => {
          return f.ref === c1.slug;
        }),
      ).toBe(true);
    });
  });
});
