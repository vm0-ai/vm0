import { randomUUID } from "node:crypto";

import { zeroRemoteAgentConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { remoteAgentHosts } from "@vm0/db/schema/remote-agent";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
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

async function seedRemoteAgentHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly lastSeenAt?: Date;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  await writeDb.insert(remoteAgentHosts).values({
    orgId: args.orgId,
    userId: args.userId,
    displayName: `host-${randomUUID()}`,
    tokenHash: `token-${randomUUID()}`,
    supportedBackends: ["codex"],
    status: args.status,
    lastSeenAt: args.lastSeenAt ?? now,
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteRemoteAgentConnectorFixture(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await Promise.all([
    writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId)),
    writeDb
      .delete(remoteAgentHosts)
      .where(eq(remoteAgentHosts.orgId, fixture.orgId)),
  ]);
}

describe("POST /api/zero/connectors/remote-agent", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteRemoteAgentConnectorFixture(fixture);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("connects when the user has an online remote-agent host", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedRemoteAgentHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroRemoteAgentConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "remote-agent",
      authMethod: "api",
      needsReconnect: false,
    });
  });

  it("rejects connect when no linked host is online", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedRemoteAgentHost({ orgId, userId, status: "offline" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroRemoteAgentConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
  });
});
