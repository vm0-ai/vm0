import { randomUUID } from "node:crypto";

import { zeroAgentsMainContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { CONNECTOR_TYPES } from "@vm0/connectors/connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function hideSlackConnectorAuthMethods(): () => void {
  const authMethods = CONNECTOR_TYPES.slack.authMethods;
  const original = Object.fromEntries(Object.entries(authMethods));

  for (const [key, config] of Object.entries(authMethods)) {
    Object.defineProperty(authMethods, key, {
      value: { ...config, visible: false },
      configurable: true,
      enumerable: true,
    });
  }

  return () => {
    for (const [key, config] of Object.entries(original)) {
      Object.defineProperty(authMethods, key, {
        value: config,
        configurable: true,
        enumerable: true,
      });
    }
  };
}

describe("GET /api/zero/agents/:id/user-connectors", () => {
  const restoreConnectorRegistry: (() => void)[] = [];

  afterEach(() => {
    while (restoreConnectorRegistry.length > 0) {
      restoreConnectorRegistry.pop()?.();
    }
  });

  it("keeps connector grants when their auth methods become hidden", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
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

    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledTypes: ["slack", "github"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    restoreConnectorRegistry.push(hideSlackConnectorAuthMethods());
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(new Set(response.body.enabledTypes)).toStrictEqual(
      new Set(["github", "slack"]),
    );
  });
});
