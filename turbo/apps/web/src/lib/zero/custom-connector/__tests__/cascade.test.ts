import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { POST as postAgentRoute } from "../../../../../app/api/zero/agents/route";
import { PUT as putAgentCustomConnectors } from "../../../../../app/api/zero/agents/[id]/custom-connectors/route";
import {
  createTestRequest,
  createTestCliToken,
} from "../../../../__tests__/api-test-helpers";
import { testContext } from "../../../../__tests__/test-helpers";
import { initServices } from "../../../init-services";
import {
  createCustomConnector,
  deleteCustomConnector,
} from "../custom-connector-service";
import { userCustomConnectors } from "../../../../db/schema/user-custom-connector";
import { zeroAgents } from "../../../../db/schema/zero-agent";

const context = testContext();

describe("user_custom_connectors DB cascade integrity", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  async function createAgentFor(userToken: string): Promise<string> {
    const res = await postAgentRoute(
      createTestRequest(`http://localhost:3000/api/zero/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    return data.agentId as string;
  }

  it("deleting a custom connector cascades to user_custom_connectors", async () => {
    initServices();
    const user = await context.setupUser();
    const token = await createTestCliToken(user.userId);
    const agentId = await createAgentFor(token);

    const connector = await createCustomConnector(user.orgId, user.userId, {
      displayName: "Cascade Test",
      prefixes: ["https://api.cascade-test.example/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });

    // Authorize the agent for this connector.
    const putRes = await putAgentCustomConnectors(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ enabledIds: [connector.id] }),
        },
      ),
    );
    expect(putRes.status).toBe(200);

    // Sanity: the authorization row exists.
    const before = await globalThis.services.db
      .select()
      .from(userCustomConnectors)
      .where(eq(userCustomConnectors.customConnectorId, connector.id));
    expect(before).toHaveLength(1);

    // Delete the connector → DB-level CASCADE clears user_custom_connectors.
    await deleteCustomConnector(user.orgId, connector.id);

    const after = await globalThis.services.db
      .select()
      .from(userCustomConnectors)
      .where(eq(userCustomConnectors.customConnectorId, connector.id));
    expect(after).toEqual([]);
  });

  it("deleting an agent cascades to user_custom_connectors", async () => {
    initServices();
    const user = await context.setupUser();
    const token = await createTestCliToken(user.userId);
    const agentId = await createAgentFor(token);

    const connector = await createCustomConnector(user.orgId, user.userId, {
      displayName: "Agent Cascade Test",
      prefixes: ["https://api.agent-cascade.example/"],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });

    const putRes = await putAgentCustomConnectors(
      createTestRequest(
        `http://localhost:3000/api/zero/agents/${agentId}/custom-connectors`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ enabledIds: [connector.id] }),
        },
      ),
    );
    expect(putRes.status).toBe(200);

    const before = await globalThis.services.db
      .select()
      .from(userCustomConnectors)
      .where(eq(userCustomConnectors.agentId, agentId));
    expect(before).toHaveLength(1);

    // Delete the agent directly — no CLI delete route in scope here.
    await globalThis.services.db
      .delete(zeroAgents)
      .where(eq(zeroAgents.id, agentId));

    const after = await globalThis.services.db
      .select()
      .from(userCustomConnectors)
      .where(eq(userCustomConnectors.agentId, agentId));
    expect(after).toEqual([]);
  });
});
