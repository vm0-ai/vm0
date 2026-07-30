import { zeroModelProviderConnectionsMainContract } from "@vm0/api-contracts/contracts/zero-model-provider-gateways";

import { closeDbPool } from "../../../lib/db";
import { env, mockEnv } from "../../../lib/env";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mainClient() {
  return setupApp({ context })(zeroModelProviderConnectionsMainContract);
}

function preMigrationDatabaseUrl(): string {
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.pathname = "/template1";
  databaseUrl.search = "";
  databaseUrl.hash = "";
  return databaseUrl.toString();
}

describe("custom model provider gateway rollout compatibility", () => {
  it("keeps the real routes safe before migration 0755", async () => {
    // This historical schema state cannot be created through the production
    // API. PostgreSQL's empty template database gives the real Hono route a
    // database where the additive gateway tables and policy column are absent.
    await closeDbPool();
    mockEnv("DATABASE_URL", preMigrationDatabaseUrl());
    mocks.clerk.session(
      "user_gateway_rollout",
      "org_gateway_rollout",
      "org:admin",
    );

    const listed = await accept(
      mainClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([]);

    const rejected = await accept(
      mainClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Unavailable Gateway",
          secret: "secret",
          surfaces: [
            {
              protocol: "anthropic-messages",
              apiBaseUrl: "https://gateway.example.com",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {{secret}}",
              modelMappings: {},
            },
          ],
        },
      }),
      [400],
    );
    expect(rejected.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Custom model gateways are unavailable until the database migration is applied",
    });
  });
});
