import { randomUUID } from "node:crypto";

import { zeroComputerConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
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

async function seedComputerConnector(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: args.userId,
    orgId: args.orgId,
    type: "computer",
    authMethod: "api",
  });
}

async function deleteConnectorsByOrg(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
}

describe("GET /api/zero/connectors/computer", () => {
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

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when no computer connector is configured", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns the computer connector when one is configured", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedComputerConnector({ orgId, userId });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.type).toBe("computer");
    expect(response.body.authMethod).toBe("api");
  });
});
