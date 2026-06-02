import { randomUUID } from "node:crypto";

import {
  zeroOrgContract,
  zeroOrgLeaveContract,
} from "@vm0/api-contracts/contracts/zero-org";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

interface SeedOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
  readonly slug?: string;
  readonly name?: string;
  readonly tier?: OrgTier;
}

interface ClerkOrgFixture {
  readonly orgId: string;
  readonly slug: string;
  readonly name: string;
  readonly createdBy?: string;
}

function mockClerkOrganization(args: ClerkOrgFixture): void {
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: args.orgId,
    slug: args.slug,
    name: args.name,
    createdBy: args.createdBy,
    createdAt: now(),
  });
}

async function seedOrg(args: SeedOrgArgs): Promise<OrgMembershipFixture> {
  const fixture = await store.set(
    seedOrgMembership$,
    {
      orgId: args.orgId,
      userId: args.userId,
      role: args.role,
      slug: args.slug,
      name: args.name,
    },
    context.signal,
  );
  if (args.tier) {
    const writeDb = store.set(writeDb$);
    await writeDb.insert(orgMetadata).values({
      orgId: args.orgId,
      tier: args.tier,
    });
  }
  return fixture;
}

async function seedOrgCacheOnly(
  orgId: string,
  slug?: string,
): Promise<OrgMembershipFixture> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgCache).values({
    orgId,
    slug: slug ?? `org-${orgId.slice(-8)}`,
  });
  return { orgId, userId: "" };
}

async function setOrgTier(orgId: string, tier: OrgTier): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(orgMetadata)
    .values({ orgId, tier })
    .onConflictDoUpdate({ target: orgMetadata.orgId, set: { tier } });
}

async function deleteOrgComposite(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, fixture.orgId),
        eq(orgMembersMetadata.userId, fixture.userId),
      ),
    );
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

async function readOrgCache(orgId: string): Promise<
  | {
      readonly slug: string;
      readonly name: string;
    }
  | undefined
> {
  const writeDb = store.set(writeDb$);
  const [cached] = await writeDb
    .select({
      slug: orgCache.slug,
      name: orgCache.name,
    })
    .from(orgCache)
    .where(eq(orgCache.orgId, orgId))
    .limit(1);
  return cached;
}

async function readOrgMemberCache(
  orgId: string,
  userId: string,
): Promise<{ readonly role: string } | undefined> {
  const writeDb = store.set(writeDb$);
  const [cached] = await writeDb
    .select({ role: orgMembersCache.role })
    .from(orgMembersCache)
    .where(
      and(eq(orgMembersCache.orgId, orgId), eq(orgMembersCache.userId, userId)),
    )
    .limit(1);
  return cached;
}

async function readOrgMemberMetadata(
  orgId: string,
  userId: string,
): Promise<{ readonly userId: string } | undefined> {
  const writeDb = store.set(writeDb$);
  const [metadata] = await writeDb
    .select({ userId: orgMembersMetadata.userId })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return metadata;
}

function readSlackConnections(
  workspaceId: string,
): Promise<{ readonly vm0UserId: string }[]> {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select({ vm0UserId: slackOrgConnections.vm0UserId })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
}

async function seedSlackOrgConnection(
  orgId: string,
  userId: string,
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const workspaceId = `T_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await writeDb.insert(slackOrgInstallations).values({
    slackWorkspaceId: workspaceId,
    slackWorkspaceName: "Test Workspace",
    orgId,
    encryptedBotToken: "encrypted-token",
    botUserId: "U_BOT",
  });
  await writeDb.insert(slackOrgConnections).values({
    slackUserId: `U_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    slackWorkspaceId: workspaceId,
    vm0UserId: userId,
  });
  return workspaceId;
}

async function deleteSlackWorkspace(workspaceId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  await writeDb
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
}

describe("GET /api/zero/org", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOrgComposite(fixture);
      }
    }
  });

  it("returns org info", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(
      await seedOrg({ orgId, userId, role: "admin", slug, name: "Test Org" }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
    expect(response.body.slug).toBe(slug);
    expect(response.body.name).toBe("Test Org");
    expect(response.body.permissionGrantMode).toBe("legacy");
  });

  it("returns 404 when no org in session", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(client.get({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns org info with zero token", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin", slug }));

    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
    expect(response.body.slug).toBe(slug);
    expect(response.body.role).toBe("admin");
    expect(response.body.permissionGrantMode).toBe("legacy");
  });

  it("returns user grant permission mode with zero token when enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "member", slug }));
    const writeDb = store.set(writeDb$);
    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.UserPermissionGrants]: true },
    });

    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
    expect(response.body.role).toBe("member");
    expect(response.body.permissionGrantMode).toBe("user-grants");
  });
});

describe("PUT /api/zero/org", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOrgComposite(fixture);
      }
    }
  });

  it("updates org name", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(
      await seedOrg({ orgId, userId, role: "member", slug, name: "Old Org" }),
    );
    mockClerkOrganization({
      orgId,
      slug,
      name: "Updated Org",
      createdBy: userId,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { name: "Updated Org" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: orgId,
      slug,
      name: "Updated Org",
      tier: "pro-suspend",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(orgId, { name: "Updated Org" });
    await expect(readOrgCache(orgId)).resolves.toMatchObject({
      slug,
      name: "Updated Org",
    });
  });

  it("rejects slug update without force", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: `org-${randomUUID().slice(0, 8)}` },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Changing org slug may break existing references. Use --force to confirm.",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({ headers: {}, body: { name: "Updated Org" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 when authenticated without an org", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { name: "Updated Org" },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "No org configured. Set your org with: zero org set <slug>",
    });
  });

  it("rejects zero tokens", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: `Bearer ${token}` },
        body: { name: "Updated Org" },
      }),
      [403],
    );

    expect(response.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "This endpoint is not available for sandbox tokens",
    });
  });

  it("updates org slug with force and refreshes cache", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const oldSlug = `org-${randomUUID().slice(0, 8)}`;
    const newSlug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(
      await seedOrg({
        orgId,
        userId,
        role: "admin",
        slug: oldSlug,
        name: "Test Org",
      }),
    );
    mockClerkOrganization({
      orgId,
      slug: newSlug,
      name: "Test Org",
      createdBy: userId,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: newSlug, force: true },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: orgId,
      slug: newSlug,
      name: "Test Org",
      tier: "pro-suspend",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(orgId, { slug: newSlug });
    await expect(readOrgCache(orgId)).resolves.toMatchObject({
      slug: newSlug,
      name: "Test Org",
    });
  });

  it("returns 409 when slug belongs to another org", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const takenSlug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    seededFixtures.push(
      await seedOrg({
        orgId: otherOrgId,
        userId,
        role: "admin",
        slug: takenSlug,
      }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: takenSlug, force: true },
      }),
      [409],
    );

    expect(response.body.error).toMatchObject({
      code: "CONFLICT",
      message: `Org "${takenSlug}" already exists`,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
  });

  it("rejects reserved slugs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { slug: "vm0-team", force: true },
      }),
      [400],
    );

    expect(response.body.error).toMatchObject({
      code: "BAD_REQUEST",
      message: "Org slug is reserved",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns current org data for no-op body", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `org-${randomUUID().slice(0, 8)}`;
    seededFixtures.push(
      await seedOrg({
        orgId,
        userId,
        role: "admin",
        slug,
        name: "Current Org",
        tier: "pro",
      }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      id: orgId,
      slug,
      name: "Current Org",
      tier: "pro",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not an org member", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrgCacheOnly(orgId));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.update({
        headers: { authorization: "Bearer clerk-session" },
        body: { name: "Updated Org" },
      }),
      [403],
    );

    expect(response.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "Access denied",
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
  });
});

describe("POST /api/zero/org/leave", () => {
  const seededFixtures: OrgMembershipFixture[] = [];
  const slackWorkspaces: string[] = [];

  beforeEach(() => {
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockReset();
    context.mocks.clerk.organizations.deleteOrganizationMembership.mockResolvedValue(
      {},
    );
  });

  afterEach(async () => {
    while (slackWorkspaces.length > 0) {
      const workspaceId = slackWorkspaces.pop();
      if (workspaceId) {
        await deleteSlackWorkspace(workspaceId);
      }
    }

    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOrgComposite(fixture);
      }
    }
  });

  it("lets a member leave the active org and cleans local membership state", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "member" }));
    const workspaceId = await seedSlackOrgConnection(orgId, userId);
    slackWorkspaces.push(workspaceId);
    const writeDb = store.set(writeDb$);
    await writeDb.insert(orgMembersMetadata).values({ orgId, userId });
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroOrgLeaveContract);
    const response = await accept(
      client.leave({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(response).toMatchObject({ body: { message: "Left org" } });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).toHaveBeenCalledWith({ organizationId: orgId, userId });
    await expect(readOrgMemberCache(orgId, userId)).resolves.toBeUndefined();
    await expect(readOrgMemberMetadata(orgId, userId)).resolves.toBeUndefined();
    await expect(readSlackConnections(workspaceId)).resolves.toHaveLength(0);
  });

  it("rejects admins", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroOrgLeaveContract);
    const response = await accept(
      client.leave({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [403],
    );

    expect(response).toMatchObject({
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Admins cannot leave the organization",
        },
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
    await expect(readOrgMemberCache(orgId, userId)).resolves.toMatchObject({
      role: "admin",
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgLeaveContract);
    const response = await accept(
      client.leave({ headers: {}, body: {} }),
      [401],
    );

    expect(response).toMatchObject({
      body: { error: { code: "UNAUTHORIZED" } },
    });
  });

  it("returns 400 when authenticated without an org", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgLeaveContract);
    const response = await accept(
      client.leave({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [400],
    );

    expect(response).toMatchObject({
      body: {
        error: {
          code: "BAD_REQUEST",
          message:
            "Explicit org context required — ensure active org in session",
        },
      },
    });
  });

  it("rejects zero tokens", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "member" }));
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroOrgLeaveContract);
    const response = await accept(
      client.leave({
        headers: { authorization: `Bearer ${token}` },
        body: {},
      }),
      [403],
    );

    expect(response).toMatchObject({
      body: {
        error: {
          code: "FORBIDDEN",
          message: "This endpoint is not available for sandbox tokens",
        },
      },
    });
    expect(
      context.mocks.clerk.organizations.deleteOrganizationMembership,
    ).not.toHaveBeenCalled();
  });
});

describe("GET /api/zero/org — org resolution", () => {
  const seededFixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteOrgComposite(fixture);
      }
    }
  });

  it("resolves org from session context", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
  });

  it("returns 404 when no org context available", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("resolves correct org when user has multiple orgs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId1 = `org_${randomUUID()}`;
    const orgId2 = `org_${randomUUID()}`;
    seededFixtures.push(
      await seedOrg({ orgId: orgId1, userId, role: "admin" }),
    );
    seededFixtures.push(
      await seedOrg({ orgId: orgId2, userId, role: "admin" }),
    );
    mocks.clerk.session(userId, orgId2);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.id).toBe(orgId2);
    expect(response.body.id).not.toBe(orgId1);
  });

  it("returns tier from org table", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(
      await seedOrg({ orgId, userId, role: "admin", tier: "pro" }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
    expect(response.body.tier).toBe("pro");
  });

  it("returns default suspended tier for new org", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("pro-suspend");
  });

  it("reflects updated tier value", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);

    const first = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(first.body.tier).toBe("pro-suspend");

    await setOrgTier(orgId, "team");

    const second = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(second.body.tier).toBe("team");
  });

  it("returns suspended tier for brand-new org without metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrgCacheOnly(orgId));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.id).toBe(orgId);
    expect(response.body.tier).toBe("pro-suspend");
  });

  it("refreshes org identity from Clerk when cache row is missing", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `clerk-${randomUUID().slice(0, 8)}`;
    seededFixtures.push({ orgId, userId });
    mockClerkOrganization({
      orgId,
      slug,
      name: "Clerk Fresh Org",
      createdBy: userId,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: orgId,
      slug,
      name: "Clerk Fresh Org",
      tier: "pro-suspend",
      role: "admin",
      createdBy: userId,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledWith({ organizationId: orgId });

    const writeDb = store.set(writeDb$);
    const [cached] = await writeDb
      .select({
        slug: orgCache.slug,
        name: orgCache.name,
        createdBy: orgCache.createdBy,
      })
      .from(orgCache)
      .where(eq(orgCache.orgId, orgId))
      .limit(1);
    expect(cached).toStrictEqual({
      slug,
      name: "Clerk Fresh Org",
      createdBy: userId,
    });
  });

  it("returns member with correct role", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.role).toBe("admin");
  });
});
