import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function seedSandboxJwtFixture(): Promise<AuthenticatedFixture> {
  const fixture = await store.set(
    seedOrgMembership$,
    { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectOpenai(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorManualGrantContract).connect({
      params: { type: "openai" },
      body: {
        authMethod: "api-token",
        values: { OPENAI_TOKEN: "sk-test-token" },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function deleteOpenai(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).delete({
      params: { type: "openai" },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

describe("GET /api/zero/connectors/:type", () => {
  const seededFixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOpenai(fixture);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.get({ params: { type: "github" }, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.get({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when no connector of that type exists", async () => {
    const fixture = seedAuthenticatedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.get({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns a connector created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectOpenai(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("allows access with a sandbox JWT carrying connector:read capability", async () => {
    const fixture = await seedSandboxJwtFixture();
    seededFixtures.push(fixture);
    await connectOpenai(fixture);

    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.get({
        params: { type: "openai" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body.type).toBe("openai");
  });
});
