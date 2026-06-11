import { randomUUID } from "node:crypto";

import { zeroOrgDeleteContract } from "@vm0/api-contracts/contracts/zero-org";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-org-delete.test.ts`.
// The 8 legacy `it()`s collapse into 2 BDD `it()`s:
// (1) auth + role + validation chain (401 unauthenticated
// → 401 user has no active org → 403 zero token rejected
// → 400 invalid body → 400 slug mismatch → 403 non-admin
// member → 404 missing org identity),
// (2) success + cleanup chain (200 deletes via Clerk +
// cleans member cache + cleans member metadata + cleans
// slack connections + keeps org_metadata row).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface CleanupFixture {
  readonly orgId?: string;
  readonly workspaceId?: string;
}

const trackCleanup = createFixtureTracker(
  async (fixture: CleanupFixture): Promise<void> => {
    const writeDb = store.set(writeDb$);
    if (fixture.workspaceId) {
      await writeDb
        .delete(slackOrgConnections)
        .where(eq(slackOrgConnections.slackWorkspaceId, fixture.workspaceId));
      await writeDb
        .delete(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, fixture.workspaceId));
    }

    if (fixture.orgId) {
      await writeDb
        .delete(orgMembersMetadata)
        .where(eq(orgMembersMetadata.orgId, fixture.orgId));
      await writeDb
        .delete(orgMembersCache)
        .where(eq(orgMembersCache.orgId, fixture.orgId));
      await writeDb
        .delete(orgMetadata)
        .where(eq(orgMetadata.orgId, fixture.orgId));
      await writeDb.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    }
  },
);

function uniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: uniqueId("run"),
    capabilities: [],
    iat: seconds,
    exp: seconds + 600,
  });
}

async function seedOrg(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly role: "admin" | "member";
  readonly slug: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await trackCleanup(Promise.resolve({ orgId: args.orgId }));
  await writeDb.insert(orgCache).values({
    orgId: args.orgId,
    slug: args.slug,
    name: "Delete Test Org",
  });
  await writeDb.insert(orgMetadata).values({ orgId: args.orgId });
  await writeDb.insert(orgMembersCache).values({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role,
  });
}

async function seedMemberMetadata(
  orgId: string,
  userId: string,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgMembersMetadata).values({ orgId, userId });
}

async function seedSlackConnection(args: {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly userId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await trackCleanup(Promise.resolve({ workspaceId: args.workspaceId }));
  await writeDb.insert(slackOrgInstallations).values({
    slackWorkspaceId: args.workspaceId,
    slackWorkspaceName: "Delete Test Workspace",
    orgId: args.orgId,
    encryptedBotToken: "encrypted-token",
    botUserId: uniqueId("bot"),
  });
  await writeDb.insert(slackOrgConnections).values({
    slackUserId: uniqueId("slack-user"),
    slackWorkspaceId: args.workspaceId,
    vm0UserId: args.userId,
  });
}

function mockMemberships(userIds: readonly string[]): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: userIds.map((userId) => {
        return { publicUserData: { userId } };
      }),
    },
  );
}

async function readMemberCache(
  orgId: string,
  userId: string,
): Promise<typeof orgMembersCache.$inferSelect | undefined> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  return row;
}

async function readMemberMetadata(
  orgId: string,
  userId: string,
): Promise<typeof orgMembersMetadata.$inferSelect | undefined> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return row;
}

async function readSlackConnection(
  workspaceId: string,
  userId: string,
): Promise<typeof slackOrgConnections.$inferSelect | undefined> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
        eq(slackOrgConnections.vm0UserId, userId),
      ),
    )
    .limit(1);
  return row;
}

function apiClient() {
  return setupApp({ context })(zeroOrgDeleteContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD POST /api/zero/org/delete — auth + role + validation chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 user has no active org → 403 zero token rejected → 400 invalid body → 400 slug mismatch → 403 non-admin member → 404 missing org identity", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().delete({ headers: {}, body: { slug: "delete-test" } }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no active org.

    // When + Then: 401.
    mocks.clerk.session(uniqueId("user"), null);
    const noOrg = await accept(
      apiClient().delete({
        headers: sessionHeaders(),
        body: { slug: "delete-test" },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a zero (sandbox) token.

    // When + Then: 403 — sandbox tokens are rejected +
    // no Clerk lookups or deletes are made.
    const token = zeroToken({
      userId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    const sandboxResponse = await accept(
      apiClient().delete({
        headers: { authorization: `Bearer ${token}` },
        body: { slug: "delete-test" },
      }),
      [403],
    );
    expect(sandboxResponse.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();

    // Given: a seeded admin org + a Clerk session +
    // an empty body.

    // When + Then: 400 — invalid body + Clerk delete is
    // not called.
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({ userId, orgId, role: "admin", slug });
    mocks.clerk.session(userId, orgId, "org:admin");
    const app = createApp({ signal: context.signal });
    const invalidBodyResponse = await app.request("/api/zero/org/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const invalidBodyJson = await invalidBodyResponse.json();
    expect(invalidBodyResponse.status).toBe(400);
    expect(invalidBodyJson).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();

    // Given: a seeded admin org + a Clerk session + a
    // mismatched slug.

    // When + Then: 400 — Organization name does not
    // match + Clerk delete is not called.
    const slugMismatch = await accept(
      apiClient().delete({
        headers: sessionHeaders(),
        body: { slug: `different-${randomUUID().slice(0, 8)}` },
      }),
      [400],
    );
    expect(slugMismatch.body).toStrictEqual({
      error: {
        message: "Organization name does not match",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();

    // Given: a seeded member org + a Clerk session as
    // `org:member`.

    // When + Then: 403 — Only admins can delete the
    // organization + Clerk lookups are not called.
    const memberUserId = uniqueId("user");
    const memberOrgId = uniqueId("org");
    const memberSlug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({
      userId: memberUserId,
      orgId: memberOrgId,
      role: "member",
      slug: memberSlug,
    });
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");
    const memberResponse = await accept(
      apiClient().delete({
        headers: sessionHeaders(),
        body: { slug: memberSlug },
      }),
      [403],
    );
    expect(memberResponse.body).toStrictEqual({
      error: {
        message: "Only admins can delete the organization",
        code: "FORBIDDEN",
      },
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();

    // Given: a Clerk session that points at an
    // org_metadata row with no Clerk org behind it.

    // When + Then: 404 — Resource not found + Clerk
    // delete is not called.
    const missingUserId = uniqueId("user");
    const missingOrgId = uniqueId("org");
    await trackCleanup(Promise.resolve({ orgId: missingOrgId }));
    await store.set(writeDb$).insert(orgMetadata).values({
      orgId: missingOrgId,
    });
    mocks.clerk.session(missingUserId, missingOrgId, "org:admin");
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
      statusCode: 404,
    });
    const missingResponse = await accept(
      apiClient().delete({
        headers: sessionHeaders(),
        body: { slug: "missing-org" },
      }),
      [404],
    );
    expect(missingResponse.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/zero/org/delete — success + cleanup chain", () => {
  it("gwt-wt-wt: 200 deletes via Clerk + cleans member cache + cleans member metadata + cleans slack connections + keeps org_metadata row", async () => {
    // Given: a seeded admin org with a second member
    // + member metadata rows for both + a Slack
    // connection bound to the member's userId +
    // memberships mocked + Clerk deleteOrganization
    // mocked + a Clerk admin session.

    // When + Then: 200 — `Organization deleted` +
    // Clerk delete is invoked with the orgId +
    // member cache rows for both users are gone +
    // member metadata rows for both users are gone +
    // the Slack connection row is gone + the
    // org_metadata row survives the cleanup.
    const adminUserId = uniqueId("user-admin");
    const memberUserId = uniqueId("user-member");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("workspace");
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({ userId: adminUserId, orgId, role: "admin", slug });
    await store.set(writeDb$).insert(orgMembersCache).values({
      orgId,
      userId: memberUserId,
      role: "member",
    });
    await seedMemberMetadata(orgId, adminUserId);
    await seedMemberMetadata(orgId, memberUserId);
    await seedSlackConnection({ orgId, workspaceId, userId: memberUserId });
    mockMemberships([adminUserId, memberUserId]);
    context.mocks.clerk.organizations.deleteOrganization.mockResolvedValue({});
    mocks.clerk.session(adminUserId, orgId, "org:admin");

    const successResponse = await accept(
      apiClient().delete({
        headers: sessionHeaders(),
        body: { slug },
      }),
      [200],
    );

    expect(successResponse.body).toStrictEqual({
      message: "Organization deleted",
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledWith({ organizationId: orgId });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).toHaveBeenCalledWith(orgId);
    await expect(readMemberCache(orgId, adminUserId)).resolves.toBeUndefined();
    await expect(readMemberCache(orgId, memberUserId)).resolves.toBeUndefined();
    await expect(
      readMemberMetadata(orgId, adminUserId),
    ).resolves.toBeUndefined();
    await expect(
      readMemberMetadata(orgId, memberUserId),
    ).resolves.toBeUndefined();
    await expect(
      readSlackConnection(workspaceId, memberUserId),
    ).resolves.toBeUndefined();

    const writeDb = store.set(writeDb$);
    const [metadata] = await writeDb
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId));
    expect(metadata?.orgId).toBe(orgId);
  });
});
