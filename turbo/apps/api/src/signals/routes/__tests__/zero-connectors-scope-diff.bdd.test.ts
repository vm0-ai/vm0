import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ConnectorType } from "@vm0/connectors/connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

interface ActorConnector {
  readonly actor: Actor;
  readonly type: ConnectorType;
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `org_${prefix}_${suffix}`,
    userId: `user_${prefix}_${suffix}`,
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function scopeDiffClient() {
  return setupApp({ context })(zeroConnectorScopeDiffContract);
}

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

function zeroToken(args: {
  readonly actor: Actor;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
}

const trackConnector = createFixtureTracker<ActorConnector>(
  async (connector) => {
    mockSession(connector.actor);
    await accept(
      byTypeClient().delete({
        params: { type: connector.type },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

async function connectStripeApiToken(member: Actor): Promise<void> {
  mockSession(member);
  const response = await accept(
    manualGrantClient().connect({
      params: { type: "stripe" },
      body: {
        authMethod: "api-token",
        values: { STRIPE_TOKEN: `sk_test_${randomUUID()}` },
      },
      headers: authHeaders(),
    }),
    [200],
  );

  await trackConnector(Promise.resolve({ actor: member, type: "stripe" }));
  expect(response.body.type).toBe("stripe");
  expect(response.body.authMethod).toBe("api-token");
}

describe("/api/zero/connectors/:type/scope-diff BDD", () => {
  it("requires authentication, connector read capability, and connector state", async () => {
    const client = scopeDiffClient();

    const unauthenticated = await accept(
      client.getScopeDiff({ params: { type: "github" }, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const sandboxActor = actor("scope_diff_sandbox");
    const token = zeroToken({
      actor: sandboxActor,
      capabilities: ["file:read"],
    });
    const missingCapability = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: bearerHeaders(token),
      }),
      [403],
    );

    expect(missingCapability.body.error.message).toBe(
      "Missing required capability: connector:read",
    );

    const member = actor("scope_diff_missing");
    mockSession(member);
    const missingConnector = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missingConnector.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("returns an empty diff for a route-created manual auth connector", async () => {
    const member = actor("scope_diff_manual");
    await connectStripeApiToken(member);

    mockSession(member);
    const response = await accept(
      scopeDiffClient().getScopeDiff({
        params: { type: "stripe" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });
});
