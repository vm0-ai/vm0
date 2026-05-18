import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { zeroOrgDeleteContract } from "@vm0/api-contracts/contracts/zero-org";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

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

describe("POST /api/zero/org/delete", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({ headers: {}, body: { slug: "delete-test" } }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated without an active org", async () => {
    mocks.clerk.session(uniqueId("user"), null);
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: "delete-test" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("rejects zero tokens", async () => {
    const token = zeroToken({
      userId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: `Bearer ${token}` },
        body: { slug: "delete-test" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
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
  });

  it("returns 400 for an invalid body", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({ userId, orgId, role: "admin", slug });
    mocks.clerk.session(userId, orgId, "org:admin");
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/zero/org/delete", {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when the slug does not match the active org", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({ userId, orgId, role: "admin", slug });
    mocks.clerk.session(userId, orgId, "org:admin");
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: `different-${randomUUID().slice(0, 8)}` },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Organization name does not match",
        code: "BAD_REQUEST",
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin members", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const slug = `org-${randomUUID().slice(0, 8)}`;
    await seedOrg({ userId, orgId, role: "member", slug });
    mocks.clerk.session(userId, orgId, "org:member");
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
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
  });

  it("returns 404 when the org identity is missing", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    await trackCleanup(Promise.resolve({ orgId }));
    await store.set(writeDb$).insert(orgMetadata).values({ orgId });
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
      statusCode: 404,
    });
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: "missing-org" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganization,
    ).not.toHaveBeenCalled();
  });

  it("deletes the organization through Clerk and cleans member-local rows", async () => {
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
    const client = setupApp({ context })(zeroOrgDeleteContract);

    const response = await accept(
      client.delete({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
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
