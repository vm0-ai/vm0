import { randomUUID } from "node:crypto";

import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function cleanupOrgData(fixture: OrgMembershipFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await writeDb.delete(variables).where(eq(variables.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

function seedFixture(): Promise<OrgMembershipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  return store.set(seedOrgMembership$, { orgId, userId }, context.signal);
}

async function seedOAuthConnector(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "github",
    authMethod: "oauth",
  });
}

async function seedAtlassianApiTokenState(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(secrets).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    name: "ATLASSIAN_TOKEN",
    encryptedValue: "encrypted_atlassian_token",
    type: "user",
  });
  await writeDb.insert(variables).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_EMAIL",
      value: "test@example.com",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "ATLASSIAN_DOMAIN",
      value: "example",
    },
  ]);
}

async function remainingConnectorCount(
  fixture: OrgMembershipFixture,
): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
      ),
    );
  return rows.length;
}

async function remainingApiTokenState(
  fixture: OrgMembershipFixture,
): Promise<{ readonly secrets: number; readonly variables: number }> {
  const writeDb = store.set(writeDb$);
  const [secretRows, variableRows] = await Promise.all([
    writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
        ),
      ),
    writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
        ),
      ),
  ]);

  return { secrets: secretRows.length, variables: variableRows.length };
}

describe("DELETE /api/zero/connectors/:type", () => {
  const track = createFixtureTracker<OrgMembershipFixture>(cleanupOrgData);

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({ params: { type: "github" }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when no connector state exists for that type", async () => {
    const fixture = await track(seedFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("deletes an OAuth connector row", async () => {
    const fixture = await track(seedFixture());
    await seedOAuthConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(remainingConnectorCount(fixture)).resolves.toBe(0);
  });

  it("deletes API-token connector secrets and variables", async () => {
    const fixture = await track(seedFixture());
    await seedAtlassianApiTokenState(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({
        params: { type: "atlassian" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(remainingApiTokenState(fixture)).resolves.toStrictEqual({
      secrets: 0,
      variables: 0,
    });
  });
});
