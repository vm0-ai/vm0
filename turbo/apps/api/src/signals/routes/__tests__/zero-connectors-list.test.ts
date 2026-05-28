import { randomUUID } from "node:crypto";

import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
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
    writeDb.delete(secrets).where(eq(secrets.orgId, orgId)),
    writeDb.delete(variables).where(eq(variables.orgId, orgId)),
  ]);
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
    expect(Array.isArray(response.body.connectorProvidedEnvNames)).toBeTruthy();
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

  it("does not infer connectors from legacy user-owned credential secrets", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const writeDb = store.set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId,
      userId,
      name: "OPENAI_TOKEN",
      encryptedValue: "encrypted_openai_token",
      type: "user",
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorsMainContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    const openai = response.body.connectors.find((connector) => {
      return connector.type === "openai";
    });
    expect(openai).toBeUndefined();
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
