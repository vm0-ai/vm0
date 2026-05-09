import { randomUUID } from "node:crypto";

import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface SeededOrg {
  readonly orgId: string;
  readonly userId: string;
  readonly slug: string;
  readonly role: string;
}

async function seedOrgMembership(args: SeededOrg): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgCache).values({ orgId: args.orgId, slug: args.slug });
  await writeDb.insert(orgMembersCache).values({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role,
  });
}

async function deleteOrgMembership(orgId: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMembersCache).where(eq(orgMembersCache.orgId, orgId));
  await writeDb.delete(orgCache).where(eq(orgCache.orgId, orgId));
}

describe("GET /api/zero/org/list", () => {
  const seededOrgIds: string[] = [];

  afterEach(async () => {
    while (seededOrgIds.length > 0) {
      const orgId = seededOrgIds.pop();
      if (orgId) {
        await deleteOrgMembership(orgId);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns list of user orgs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const slug = `solo-${randomUUID().slice(0, 8)}`;
    await seedOrgMembership({ orgId, userId, slug, role: "admin" });
    seededOrgIds.push(orgId);

    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs.length).toBeGreaterThanOrEqual(1);
    expect(response.body.orgs[0]).toHaveProperty("slug");
    expect(response.body.orgs[0]).toHaveProperty("role");
  });

  it("returns multiple orgs when user belongs to several", async () => {
    const userId = `user_${randomUUID()}`;
    const orgIdA = `org_${randomUUID()}`;
    const orgIdB = `org_${randomUUID()}`;
    await seedOrgMembership({
      orgId: orgIdA,
      userId,
      slug: "team-alpha",
      role: "admin",
    });
    seededOrgIds.push(orgIdA);
    await seedOrgMembership({
      orgId: orgIdB,
      userId,
      slug: "team-beta",
      role: "member",
    });
    seededOrgIds.push(orgIdB);

    mocks.clerk.session(userId, orgIdA);

    const client = setupApp({ context })(zeroOrgListContract);

    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    expect(response.body.orgs).toHaveLength(2);
    expect(response.body.orgs).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "team-alpha", role: "admin" }),
        expect.objectContaining({ slug: "team-beta", role: "member" }),
      ]),
    );
  });
});
