import { randomUUID } from "node:crypto";

import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function seedConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly authMethod?: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: args.type,
    authMethod: args.authMethod ?? "oauth",
  });
}

async function deleteConnectorsByOrg(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await Promise.all([
    writeDb.delete(connectors).where(eq(connectors.orgId, orgId)),
    writeDb
      .delete(userFeatureSwitches)
      .where(eq(userFeatureSwitches.orgId, orgId)),
  ]);
}

async function enableLocalBrowser(
  orgId: string,
  userId: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.LocalBrowserUse]: true },
  });
}

describe("GET /api/zero/connectors", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnectorsByOrg(fixture.orgId);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns an empty connectors list", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
    expect(Array.isArray(response.body.configuredTypes)).toBeTruthy();
    expect(
      Array.isArray(response.body.connectorProvidedSecretNames),
    ).toBeTruthy();
  });

  it("returns connectors when present", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedConnector({ orgId, userId, type: "github" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThanOrEqual(1);
    expect(
      response.body.connectors.some((c) => {
        return c.type === "github";
      }),
    ).toBeTruthy();
  });

  it("hides connected local-browser connector when the feature is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedConnector({
      orgId,
      userId,
      type: "local-browser",
      authMethod: "api",
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const localBrowser = response.body.connectors.find((c) => {
      return c.type === "local-browser";
    });
    expect(localBrowser).toBeUndefined();
  });

  it("returns connected local-browser connector when the feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await enableLocalBrowser(orgId, userId);
    await seedConnector({
      orgId,
      userId,
      type: "local-browser",
      authMethod: "api",
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const localBrowser = response.body.connectors.find((c) => {
      return c.type === "local-browser";
    });
    expect(localBrowser).toBeDefined();
    expect(localBrowser?.authMethod).toBe("api");
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("skips oauth rows whose type no longer exists in the contract", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedConnector({
      orgId,
      userId,
      type: "__removed_connector__",
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const orphan = response.body.connectors.find((c) => {
      return (c.type as string) === "__removed_connector__";
    });
    expect(orphan).toBeUndefined();
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
