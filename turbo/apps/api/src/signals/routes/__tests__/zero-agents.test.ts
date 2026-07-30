import { randomUUID } from "node:crypto";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/agents/:id/user-connectors", () => {
  it("keeps connector grants when their discovery feature switch is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const actor = { userId, orgId };
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      setupApp({ context })(zeroAgentsMainContract).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [201],
    );
    const agentId = created.body.agentId;

    const client = setupApp({ context })(zeroUserConnectorsContract);

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledTypes: ["test-oauth", "github"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    // Connector feature switches only govern discovery. A connector already
    // granted to an agent remains usable when its discovery switch is disabled.
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(new Set(response.body.enabledTypes)).toStrictEqual(
      new Set(["github", "test-oauth"]),
    );
    expect(response.body.enabledConnectorSlugs).toStrictEqual(
      response.body.enabledTypes,
    );
    await deleteFeatureSwitchesForUser(context, actor);
  });

  it("accepts transitional update fields and rejects conflicting aliases", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});
    const headers = { authorization: "Bearer clerk-session" };

    const created = await accept(
      setupApp({ context })(zeroAgentsMainContract).create({
        headers,
        body: {},
      }),
      [201],
    );
    const client = setupApp({ context })(zeroUserConnectorsContract);
    const params = { id: created.body.agentId };

    const legacy = await accept(
      client.update({
        params,
        body: { enabledTypes: ["github"] },
        headers,
      }),
      [200],
    );
    expect(legacy.body.enabledConnectorSlugs).toStrictEqual(
      legacy.body.enabledTypes,
    );

    const canonical = await accept(
      client.update({
        params,
        body: { enabledConnectorSlugs: ["slack"] },
        headers,
      }),
      [200],
    );
    expect(canonical.body).toMatchObject({
      enabledTypes: ["slack"],
      enabledConnectorSlugs: ["slack"],
    });

    const dual = await accept(
      client.update({
        params,
        body: {
          enabledTypes: ["github"],
          enabledConnectorSlugs: ["github"],
          operation: "add",
        },
        headers,
      }),
      [200],
    );
    expect(dual.body.enabledConnectorSlugs).toStrictEqual(
      dual.body.enabledTypes,
    );

    const conflicting = await accept(
      client.update({
        params,
        body: {
          enabledTypes: ["github"],
          enabledConnectorSlugs: ["slack"],
        },
        headers,
      }),
      [400],
    );
    expect(conflicting.body.error.code).toBe("BAD_REQUEST");

    const missing = await accept(
      client.update({ params, body: {}, headers }),
      [400],
    );
    expect(missing.body.error.code).toBe("BAD_REQUEST");
  });
});
