import { randomUUID } from "node:crypto";

import { zeroLocalAgentConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { localAgentHosts } from "@vm0/db/schema/local-agent";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
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

async function enableLocalAgent(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches: { [FeatureSwitchKey.LocalAgentConnector]: true },
  });
}

async function seedLocalAgentHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly lastSeenAt?: Date;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  await writeDb.insert(localAgentHosts).values({
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

async function deleteLocalAgentConnectorFixture(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await Promise.all([
    writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId)),
    writeDb
      .delete(localAgentHosts)
      .where(eq(localAgentHosts.orgId, fixture.orgId)),
    writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      ),
  ]);
}

describe("POST /api/zero/connectors/local-agent", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteLocalAgentConnectorFixture(fixture);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("connects when the user has an online local-agent host", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await enableLocalAgent(orgId, userId);
    await seedLocalAgentHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalAgentConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "local-agent",
      authMethod: "api",
      needsReconnect: false,
    });
  });

  it("rejects connect when local-agent connector is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedLocalAgentHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalAgentConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects connect when no linked host is online", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await enableLocalAgent(orgId, userId);
    await seedLocalAgentHost({ orgId, userId, status: "offline" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalAgentConnectorContract);
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
