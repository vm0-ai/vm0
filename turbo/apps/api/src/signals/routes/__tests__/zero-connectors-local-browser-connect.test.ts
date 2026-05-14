import { randomUUID } from "node:crypto";

import {
  zeroConnectorAuthorizeContract,
  zeroLocalBrowserConnectorContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { localBrowserHosts } from "@vm0/db/schema/local-browser";
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

async function seedLocalBrowserHost(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly status: string;
  readonly lastSeenAt?: Date;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  const now = nowDate();
  await writeDb.insert(localBrowserHosts).values({
    orgId: args.orgId,
    userId: args.userId,
    displayName: `browser-${randomUUID()}`,
    tokenHash: `token-${randomUUID()}`,
    browser: "chrome",
    extensionVersion: "0.0.1",
    supportedCapabilities: ["tabs.list"],
    status: args.status,
    lastSeenAt: args.lastSeenAt ?? now,
    createdAt: now,
    updatedAt: now,
  });
}

async function deleteLocalBrowserConnectorFixture(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await Promise.all([
    writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId)),
    writeDb
      .delete(localBrowserHosts)
      .where(eq(localBrowserHosts.orgId, fixture.orgId)),
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

async function countLocalBrowserConnectors(args: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, "local-browser"),
      ),
    );
  return rows.length;
}

describe("POST /api/zero/connectors/local-browser", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteLocalBrowserConnectorFixture(fixture);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("connects when the user has an online local-browser host", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await enableLocalBrowser(orgId, userId);
    await seedLocalBrowserHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalBrowserConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "local-browser",
      authMethod: "api",
      needsReconnect: false,
    });
  });

  it("rejects connect when local browser use is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await seedLocalBrowserHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalBrowserConnectorContract);
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
    await enableLocalBrowser(orgId, userId);
    await seedLocalBrowserHost({ orgId, userId, status: "offline" });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroLocalBrowserConnectorContract);
    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("rejects OAuth authorization without deleting the connector", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    await enableLocalBrowser(orgId, userId);
    await seedLocalBrowserHost({ orgId, userId, status: "online" });
    mocks.clerk.session(userId, orgId);

    const connectClient = setupApp({ context })(
      zeroLocalBrowserConnectorContract,
    );
    await accept(
      connectClient.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const authorizeClient = setupApp({ context })(
      zeroConnectorAuthorizeContract,
    );
    const response = await accept(
      authorizeClient.authorize({
        params: { type: "local-browser" },
        query: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBe(
      "local-browser connector does not use OAuth",
    );
    await expect(countLocalBrowserConnectors({ orgId, userId })).resolves.toBe(
      1,
    );
  });
});
