import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { zeroConnectorExternalCodeSessionContract } from "@vm0/api-contracts/contracts/zero-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function externalCodeClient() {
  return setupApp({ context })(zeroConnectorExternalCodeSessionContract);
}

describe("/api/zero/connectors/:type/external-code/sessions BDD", () => {
  it("requires authentication, an active organization, and an external-code connector grant", async () => {
    const client = externalCodeClient();

    const unauthenticated = await accept(
      client.create({
        params: { type: "openai" },
        body: { authMethod: "api-token" },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.create({
        params: { type: "openai" },
        body: { authMethod: "api-token" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const unsupportedGrant = await accept(
      client.create({
        params: { type: "openai" },
        body: { authMethod: "oauth" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(unsupportedGrant.body).toStrictEqual({
      error: {
        message: "openai connector does not support an external-code grant",
        code: "BAD_REQUEST",
      },
    });
  });
});
