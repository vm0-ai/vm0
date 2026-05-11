import { randomUUID } from "node:crypto";

import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

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
  readonly tier?: "free" | "pro" | "team";
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

async function setOrgTier(
  orgId: string,
  tier: "free" | "pro" | "team",
): Promise<void> {
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
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
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

  it("returns default free tier for new org", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededFixtures.push(await seedOrg({ orgId, userId, role: "admin" }));
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgContract);
    const response = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.tier).toBe("free");
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
    expect(first.body.tier).toBe("free");

    await setOrgTier(orgId, "team");

    const second = await accept(
      client.get({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );
    expect(second.body.tier).toBe("team");
  });

  it("returns free tier for brand-new org without metadata", async () => {
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
    expect(response.body.tier).toBe("free");
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
      tier: "free",
      role: "member",
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
