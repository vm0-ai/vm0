import { randomUUID } from "node:crypto";

import { zeroDebugSetCreditsContract } from "@vm0/api-contracts/contracts/zero-debug-credits";
import { createStore } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface OrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

async function seedOrg(initialCredits: number): Promise<OrgFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(orgMetadata)
    .values({ orgId, credits: initialCredits, tier: "free" });
  return { orgId, userId };
}

async function deleteOrg(fixture: OrgFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
}

const track = createFixtureTracker<OrgFixture>(deleteOrg);

function client() {
  return setupApp({ context })(zeroDebugSetCreditsContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/zero/debug/set-credits", () => {
  it("zeros out the caller's org credits", async () => {
    const fixture = await track(seedOrg(5000));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().create({ headers: authHeaders(), body: { credits: 0 } }),
      [200],
    );

    expect(response.body).toStrictEqual({ credits: 0 });

    const [row] = await store
      .set(writeDb$)
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(row?.credits).toBe(0);
  });

  it("returns 404 in production", async () => {
    mockEnv("ENV", "production");
    const fixture = await track(seedOrg(5000));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().create({ headers: authHeaders(), body: { credits: 0 } }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });

    const [row] = await store
      .set(writeDb$)
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(row?.credits).toBe(5000);
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      client().create({ headers: {}, body: { credits: 0 } }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
