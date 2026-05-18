import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import type { OrgMember } from "@vm0/api-contracts/contracts/org-members";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface ClerkOrgFixture {
  readonly slug: string;
  readonly createdAt: number;
}

interface ClerkMembershipFixture {
  readonly userId: string;
  readonly role: "org:admin" | "org:member";
  readonly createdAtMs: number;
}

interface ClerkUserFixture {
  readonly id: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

function clerkUserPayload(args: ClerkUserFixture): {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
} {
  return {
    id: args.id,
    emailAddresses: [{ id: `email-${args.id}`, emailAddress: args.email }],
    primaryEmailAddressId: `email-${args.id}`,
    firstName: args.firstName,
    lastName: args.lastName,
    imageUrl: args.imageUrl,
  };
}

function mockClerkOrg(args: ClerkOrgFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue(args);
}

function mockClerkMemberships(rows: readonly ClerkMembershipFixture[]): void {
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: rows.map((row) => {
        return {
          publicUserData: { userId: row.userId },
          role: row.role,
          createdAt: row.createdAtMs,
        };
      }),
    },
  );
}

function mockClerkNoInvitations(): void {
  context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
    { data: [] },
  );
}

function mockClerkUsers(users: readonly ClerkUserFixture[]): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: users.map(clerkUserPayload),
  });
}

function clerkUser(args: {
  readonly id: string;
  readonly email: string;
}): ClerkUserFixture {
  return {
    id: args.id,
    email: args.email,
    firstName: null,
    lastName: null,
    imageUrl: "",
  };
}

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

async function seedMemberRows(orgId: string, userId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await trackCleanup(Promise.resolve({ orgId }));
  await writeDb.insert(orgMembersCache).values({
    orgId,
    userId,
    role: "member",
  });
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
    slackWorkspaceName: "Org Members Test Workspace",
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

interface MembershipRequestFixture {
  readonly id: string;
  readonly userId: string;
  readonly createdAtMs: number;
}

const CLERK_MEMBERSHIP_REQUESTS_URL =
  "https://api.clerk.com/v1/organizations/:orgId/membership_requests";

function mockClerkMembershipRequests(
  expectedOrgId: string,
  requests: readonly MembershipRequestFixture[],
): { readonly callCount: () => number } {
  let calls = 0;
  server.use(
    http.get(CLERK_MEMBERSHIP_REQUESTS_URL, ({ params, request }) => {
      calls++;
      const orgId = params.orgId;
      if (orgId !== expectedOrgId) {
        return HttpResponse.json({ errors: ["wrong org"] }, { status: 500 });
      }
      const auth = request.headers.get("authorization");
      if (auth !== "Bearer sk_test_dummy_for_unit_tests") {
        return HttpResponse.json({ errors: ["bad auth"] }, { status: 401 });
      }
      return HttpResponse.json({
        data: requests.map((r) => {
          return {
            id: r.id,
            public_user_data: { user_id: r.userId },
            created_at: r.createdAtMs,
          };
        }),
      });
    }),
  );
  return {
    callCount: () => {
      return calls;
    },
  };
}

function mockClerkMembershipRequestsStatus(
  expectedOrgId: string,
  status: number,
): { readonly callCount: () => number } {
  let calls = 0;
  server.use(
    http.get(CLERK_MEMBERSHIP_REQUESTS_URL, ({ params }) => {
      calls++;
      if (params.orgId !== expectedOrgId) {
        return HttpResponse.json({ errors: ["wrong org"] }, { status: 500 });
      }
      return HttpResponse.json({ errors: ["err"] }, { status });
    }),
  );
  return {
    callCount: () => {
      return calls;
    },
  };
}

describe("GET /api/zero/org/members", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(client.members({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects zero tokens", async () => {
    const token = zeroToken({
      userId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.members({ headers: { authorization: `Bearer ${token}` } }),
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
  });

  it("returns members and admin-only data for an admin caller", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const requestUserId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
      {
        userId: memberUserId,
        role: "org:member",
        createdAtMs: 1_700_000_100_000,
      },
    ]);
    mockClerkNoInvitations();
    // Two getUserList calls happen (one for members, one for membership
    // requests). Both reference the same fixture set so a single mock response
    // serves both — order is an implementation detail we deliberately don't
    // assert.
    mockClerkUsers([
      {
        id: adminUserId,
        email: "admin@acme.com",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "https://img.example/ada.png",
      },
      {
        id: memberUserId,
        email: "member@acme.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
      {
        id: requestUserId,
        email: "req@x.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
    ]);
    const reqs = mockClerkMembershipRequests(orgId, [
      {
        id: "req_test_1",
        userId: requestUserId,
        createdAtMs: 1_700_000_200_000,
      },
    ]);
    mocks.clerk.session(adminUserId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.role).toBe("admin");
    expect(response.body.slug).toBe("acme");
    expect(response.body.members).toHaveLength(2);

    const admin = response.body.members.find((m: OrgMember) => {
      return m.userId === adminUserId;
    });
    expect(admin?.email).toBe("admin@acme.com");
    expect(admin?.firstName).toBe("Ada");
    expect(admin?.lastName).toBe("Lovelace");
    expect(admin?.imageUrl).toBe("https://img.example/ada.png");
    expect(admin?.role).toBe("admin");
    expect(admin?.joinedAt).toBe(new Date(1_700_000_000_000).toISOString());

    const member = response.body.members.find((m: OrgMember) => {
      return m.userId === memberUserId;
    });
    expect(member?.email).toBe("member@acme.com");
    expect(member?.firstName).toBeNull();
    expect(member?.role).toBe("member");

    expect(response.body.membershipRequests).toHaveLength(1);
    expect(response.body.membershipRequests?.[0]?.id).toBe("req_test_1");
    expect(response.body.membershipRequests?.[0]?.userId).toBe(requestUserId);
    expect(response.body.membershipRequests?.[0]?.email).toBe("req@x.com");
    expect(reqs.callCount()).toBe(1);
  });

  it("does not call membership_requests endpoint or return admin-only data for non-admin", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([]);
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockResolvedValue(
      {
        data: [
          {
            id: "inv_admin_only",
            emailAddress: "x@y.com",
            role: "org:member",
            createdAt: 1_700_000_000_000,
          },
        ],
      },
    );
    const reqs = mockClerkMembershipRequests(orgId, [
      {
        id: "req_should_not_be_seen",
        userId: "user_xyz",
        createdAtMs: 1,
      },
    ]);
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.role).toBe("member");
    expect(response.body.pendingInvitations).toStrictEqual([]);
    expect(response.body.membershipRequests).toStrictEqual([]);
    // Critical security guarantee: the membership_requests REST endpoint
    // (admin-only) MUST NOT be called for non-admin sessions.
    expect(reqs.callCount()).toBe(0);
  });

  it("returns empty members and skips getUserList when memberships are empty", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "empty-org", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([]);
    mockClerkNoInvitations();
    mockClerkMembershipRequests(orgId, []);
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.members).toStrictEqual([]);
    expect(response.body.slug).toBe("empty-org");
    // Optimization: with no userIds we must not hit Clerk's getUserList.
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("treats Clerk membership_requests 404 as empty (feature disabled)", async () => {
    const orgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;

    mockClerkOrg({ slug: "acme", createdAt: 1_700_000_000_000 });
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    mockClerkNoInvitations();
    mockClerkUsers([
      {
        id: adminUserId,
        email: "admin@acme.com",
        firstName: "Ada",
        lastName: "Lovelace",
        imageUrl: "",
      },
    ]);
    mockClerkMembershipRequestsStatus(orgId, 404);
    mocks.clerk.session(adminUserId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgMembersContract);
    const response = await accept(
      client.members({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.membershipRequests).toStrictEqual([]);
    expect(response.body.members).toHaveLength(1);
  });
});

describe("PATCH /api/zero/org/members", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: {},
        body: { email: "member@example.com", role: "admin" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(uniqueId("user"), null);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "member@example.com", role: "admin" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects zero tokens", async () => {
    const token = zeroToken({
      userId: uniqueId("user"),
      orgId: uniqueId("org"),
    });
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: `Bearer ${token}` },
        body: { email: "member@example.com", role: "admin" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body without updating Clerk", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    mocks.clerk.session(userId, orgId, "org:admin");
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/zero/org/members", {
      method: "PATCH",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "not-an-email", role: "admin" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("updates another member role for an admin caller", async () => {
    const orgId = uniqueId("org");
    const adminUserId = uniqueId("user-admin");
    const targetUserId = uniqueId("user-target");
    const targetEmail = "member@example.com";
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([clerkUser({ id: targetUserId, email: targetEmail })]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: targetEmail, role: "admin" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: `Updated role for ${targetEmail}`,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).toHaveBeenCalledWith({
      organizationId: orgId,
      userId: targetUserId,
      role: "org:admin",
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin callers without updating Clerk", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    mocks.clerk.session(userId, orgId, "org:member");
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "member@example.com", role: "admin" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the target email does not resolve to a user", async () => {
    const orgId = uniqueId("org");
    const adminUserId = uniqueId("user-admin");
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "missing@example.com", role: "member" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when the only admin tries to demote themselves", async () => {
    const orgId = uniqueId("org");
    const adminUserId = uniqueId("user-admin");
    const adminEmail = "admin@example.com";
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([clerkUser({ id: adminUserId, email: adminEmail })]);
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: adminEmail, role: "member" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("allows an admin to demote themselves when another admin exists", async () => {
    const orgId = uniqueId("org");
    const adminUserId = uniqueId("user-admin");
    const otherAdminUserId = uniqueId("user-other-admin");
    const adminEmail = "admin@example.com";
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([clerkUser({ id: adminUserId, email: adminEmail })]);
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
      {
        userId: otherAdminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_100_000,
      },
    ]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.updateRole({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: adminEmail, role: "member" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: `Updated role for ${adminEmail}`,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationMembership,
    ).toHaveBeenCalledWith({
      organizationId: orgId,
      userId: adminUserId,
      role: "org:member",
    });
  });
});

describe("DELETE /api/zero/org/members", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: {},
        body: { email: "member@example.com" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(uniqueId("user"), null);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "member@example.com" },
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
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: `Bearer ${token}` },
        body: { email: "member@example.com" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "This endpoint is not available for sandbox tokens",
      code: "FORBIDDEN",
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    mocks.clerk.session(userId, orgId, "org:admin");
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/zero/org/members", {
      method: "DELETE",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "invalid-email" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin members", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    mocks.clerk.session(userId, orgId, "org:member");
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "member@example.com" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the target email does not resolve to a Clerk user", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkUsers([]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "missing@example.com" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: ["missing@example.com"],
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 when an admin attempts to remove themselves", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    mocks.clerk.session(userId, orgId, "org:admin");
    mockClerkUsers([
      {
        id: userId,
        email: "admin@example.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
    ]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "admin@example.com" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when the target user is not an organization member", async () => {
    const adminUserId = uniqueId("user-admin");
    const targetUserId = uniqueId("user-target");
    const orgId = uniqueId("org");
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([
      {
        id: targetUserId,
        email: "target@example.com",
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
    ]);
    mockClerkMemberships([
      {
        userId: adminUserId,
        role: "org:admin",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: "target@example.com" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });

  it("removes a target member through Clerk and cleans member-local rows", async () => {
    const adminUserId = uniqueId("user-admin");
    const targetUserId = uniqueId("user-target");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("workspace");
    const targetEmail = "target@example.com";
    mocks.clerk.session(adminUserId, orgId, "org:admin");
    mockClerkUsers([
      {
        id: targetUserId,
        email: targetEmail,
        firstName: null,
        lastName: null,
        imageUrl: "",
      },
    ]);
    mockClerkMemberships([
      {
        userId: targetUserId,
        role: "org:member",
        createdAtMs: 1_700_000_000_000,
      },
    ]);
    await seedMemberRows(orgId, targetUserId);
    await seedSlackConnection({ orgId, workspaceId, userId: targetUserId });
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
    const client = setupApp({ context })(zeroOrgMembersContract);

    const response = await accept(
      client.removeMember({
        headers: { authorization: "Bearer clerk-session" },
        body: { email: targetEmail },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      message: `Removed ${targetEmail} from org`,
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      emailAddress: [targetEmail],
    });
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledWith({ organizationId: orgId });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).toHaveBeenCalledWith({ organizationId: orgId, userId: targetUserId });
    await expect(readMemberCache(orgId, targetUserId)).resolves.toBeUndefined();
    await expect(
      readMemberMetadata(orgId, targetUserId),
    ).resolves.toBeUndefined();
    await expect(
      readSlackConnection(workspaceId, targetUserId),
    ).resolves.toBeUndefined();
  });
});
