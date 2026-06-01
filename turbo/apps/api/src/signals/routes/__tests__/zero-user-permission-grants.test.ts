import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { permissionGrantsToFirewallPolicies } from "@vm0/connectors/firewalls";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { writeDb$ } from "../../external/db";
import { loadActiveUserPermissionGrants } from "../../services/zero-user-permission-grants.service";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;
const SLACK_CONNECTOR = "slack";
const SLACK_READ_PERMISSION = "channels:read";
const SLACK_WRITE_PERMISSION = "chat:write";

async function seedMember(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: "admin" | "member";
}): Promise<void> {
  await store.set(
    seedOrgMembership$,
    {
      orgId: args.orgId,
      userId: args.userId,
      role: args.role ?? "member",
      seedOrgCache: false,
    },
    context.signal,
  );
}

async function enableUserPermissionGrants(
  orgId: string,
  userId: string,
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: { [FeatureSwitchKey.UserPermissionGrants]: true } },
    });
}

async function seedAgent(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly visibility?: "public" | "private";
}): Promise<string> {
  const { agentId } = await store.set(
    seedCompose$,
    {
      orgId: args.orgId,
      userId: args.userId,
      visibility: args.visibility,
    },
    context.signal,
  );
  return agentId;
}

async function readStoredGrant(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly connectorRef: string;
  readonly permission: string;
}) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select()
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, args.orgId),
        eq(userPermissionGrants.userId, args.userId),
        eq(userPermissionGrants.agentId, args.agentId),
        eq(userPermissionGrants.connectorRef, args.connectorRef),
        eq(userPermissionGrants.permission, args.permission),
      ),
    )
    .limit(1);
  return row ?? null;
}

describe("zero user permission grants", () => {
  const fixtures: UsageInsightFixture[] = [];
  const trackedOrgIds: string[] = [];

  async function createFixture(
    role: "admin" | "member" = "member",
  ): Promise<UsageInsightFixture> {
    const fixture = await store.set(
      seedUsageInsightFixture$,
      undefined,
      context.signal,
    );
    fixtures.push(fixture);
    trackedOrgIds.push(fixture.orgId);
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role },
      context.signal,
    );
    return fixture;
  }

  afterEach(async () => {
    const db = store.set(writeDb$);
    if (trackedOrgIds.length > 0) {
      await db
        .delete(userPermissionGrants)
        .where(inArray(userPermissionGrants.orgId, trackedOrgIds));
      await db
        .delete(userFeatureSwitches)
        .where(inArray(userFeatureSwitches.orgId, trackedOrgIds));
      trackedOrgIds.length = 0;
    }

    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteUsageInsightFixture$, fixture, context.signal);
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("blocks list and upsert while the feature is disabled", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context })(zeroUserPermissionGrantsContract);

    const listed = await accept(
      client.list({
        query: { agentId },
        headers: AUTH_HEADERS,
      }),
      [403],
    );
    expect(listed.body.error.code).toBe("FORBIDDEN");

    const upserted = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [403],
    );
    expect(upserted.body.error.code).toBe("FORBIDDEN");
  });

  it("upserts and lists only the authenticated user's active grants", async () => {
    const fixture = await createFixture();
    const otherUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: fixture.orgId, userId: otherUserId });
    const agentId = await seedAgent(fixture);
    await enableUserPermissionGrants(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroUserPermissionGrantsContract);
    const upserted = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    expect(upserted.body).toMatchObject({
      agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(upserted.body.expiresAt).toBeNull();

    const db = store.set(writeDb$);
    await db.insert(userPermissionGrants).values({
      orgId: fixture.orgId,
      userId: otherUserId,
      agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_WRITE_PERMISSION,
      action: "deny",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    const listed = await accept(
      client.list({
        query: { agentId },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });

    const stored = await readStoredGrant({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
    });
    expect(stored?.userId).toBe(fixture.userId);
  });

  it("uses visible-agent scope for private and cross-org agents", async () => {
    const owner = await createFixture();
    const otherOrgUser = await createFixture();
    const sameOrgUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: owner.orgId, userId: sameOrgUserId });
    const publicAgentId = await seedAgent({
      orgId: owner.orgId,
      userId: owner.userId,
      visibility: "public",
    });
    const privateAgentId = await seedAgent({
      orgId: owner.orgId,
      userId: owner.userId,
      visibility: "private",
    });

    await enableUserPermissionGrants(owner.orgId, owner.userId);
    await enableUserPermissionGrants(owner.orgId, sameOrgUserId);
    await enableUserPermissionGrants(otherOrgUser.orgId, otherOrgUser.userId);
    const client = setupApp({ context })(zeroUserPermissionGrantsContract);

    mocks.clerk.session(owner.userId, owner.orgId, "org:member");
    const ownerResponse = await accept(
      client.upsert({
        body: {
          agentId: privateAgentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(ownerResponse.body.agentId).toBe(privateAgentId);

    mocks.clerk.session(sameOrgUserId, owner.orgId, "org:member");
    const sameOrgPublicResponse = await accept(
      client.upsert({
        body: {
          agentId: publicAgentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(sameOrgPublicResponse.body.agentId).toBe(publicAgentId);

    const sameOrgResponse = await accept(
      client.upsert({
        body: {
          agentId: privateAgentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(sameOrgResponse.body.error.code).toBe("NOT_FOUND");

    mocks.clerk.session(otherOrgUser.userId, otherOrgUser.orgId, "org:member");
    const crossOrgResponse = await accept(
      client.list({
        query: { agentId: privateAgentId },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(crossOrgResponse.body.error.code).toBe("NOT_FOUND");

    const missingResponse = await accept(
      client.list({
        query: { agentId: randomUUID() },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(missingResponse.body.error.code).toBe("NOT_FOUND");
  });

  it("validates connector refs, permission names, ask, and __unknown__", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    await enableUserPermissionGrants(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context })(zeroUserPermissionGrantsContract);

    const unknownConnector = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: "not-a-real-connector",
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownConnector.body.error.code).toBe("VALIDATION_ERROR");

    const unknownPermissionForUnknownConnector = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: "not-a-real-connector",
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownPermissionForUnknownConnector.body.error.code).toBe(
      "VALIDATION_ERROR",
    );

    const unknownPermission = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: "not-a-real-permission",
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownPermission.body.error.code).toBe("VALIDATION_ERROR");

    const unknownGrant = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "deny",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(unknownGrant.body).toMatchObject({
      connectorRef: SLACK_CONNECTOR,
      permission: UNKNOWN_PERMISSION_GRANT,
      action: "deny",
    });

    const app = createApp({ signal: context.signal });
    const askResponse = await app.request("/api/zero/user-permission-grants", {
      method: "PUT",
      headers: {
        authorization: AUTH_HEADERS.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "ask",
      }),
    });
    expect(askResponse.status).toBe(400);
  });

  it("filters expired grants and folds active grants into legacy policies", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    await enableUserPermissionGrants(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const db = store.set(writeDb$);
    const checkedAt = new Date("2026-01-01T00:00:00.000Z");

    await db.insert(userPermissionGrants).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "allow",
        expiresAt: new Date("2025-12-31T23:59:59.000Z"),
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: "channels:history",
        action: "allow",
        expiresAt: checkedAt,
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: SLACK_WRITE_PERMISSION,
        action: "deny",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "deny",
        expiresAt: null,
      },
    ]);

    const client = setupApp({ context })(zeroUserPermissionGrantsContract);
    const listed = await accept(
      client.list({
        query: { agentId },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(
      listed.body.map((grant) => {
        return grant.permission;
      }),
    ).toStrictEqual([UNKNOWN_PERMISSION_GRANT, SLACK_WRITE_PERMISSION]);

    const active = await loadActiveUserPermissionGrants(
      db,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId,
      },
      checkedAt,
    );
    expect(
      active.map((grant) => {
        return grant.permission;
      }),
    ).toStrictEqual([UNKNOWN_PERMISSION_GRANT, SLACK_WRITE_PERMISSION]);

    expect(permissionGrantsToFirewallPolicies(active)).toStrictEqual({
      slack: {
        policies: { [SLACK_WRITE_PERMISSION]: "deny" },
        unknownPolicy: "deny",
      },
    });
    expect(permissionGrantsToFirewallPolicies([])).toBeNull();
  });

  it("updates action and updatedAt without changing createdAt", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    await enableUserPermissionGrants(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({ context })(zeroUserPermissionGrantsContract);

    await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );

    const oldTimestamp = new Date("2024-01-01T00:00:00.000Z");
    const oldExpiresAt = new Date("2024-01-01T00:05:00.000Z");
    const db = store.set(writeDb$);
    await db
      .update(userPermissionGrants)
      .set({
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp,
        expiresAt: oldExpiresAt,
      })
      .where(
        and(
          eq(userPermissionGrants.orgId, fixture.orgId),
          eq(userPermissionGrants.userId, fixture.userId),
          eq(userPermissionGrants.agentId, agentId),
          eq(userPermissionGrants.connectorRef, SLACK_CONNECTOR),
          eq(userPermissionGrants.permission, SLACK_READ_PERMISSION),
        ),
      );

    const second = await accept(
      client.upsert({
        body: {
          agentId,
          connectorRef: SLACK_CONNECTOR,
          permission: SLACK_READ_PERMISSION,
          action: "deny",
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(second.body.action).toBe("deny");
    expect(second.body.expiresAt).toBeNull();

    const stored = await readStoredGrant({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
    });
    expect(stored?.action).toBe("deny");
    expect(stored?.createdAt.getTime()).toBe(oldTimestamp.getTime());
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(oldTimestamp.getTime());
    expect(stored?.expiresAt).toBeNull();
  });
});
