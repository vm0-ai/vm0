import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { onboardingCompleteContract } from "@vm0/api-contracts/contracts/onboarding";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteOnboardingStatusOrg$,
  seedOnboardingStatusOrg$,
  type OnboardingStatusFixture,
} from "./helpers/zero-onboarding-status";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(onboardingCompleteContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("POST /api/zero/onboarding/complete", () => {
  const track = createFixtureTracker<OnboardingStatusFixture>((fixture) => {
    return store.set(deleteOnboardingStatusOrg$, fixture, context.signal);
  });

  async function getOnboardingDone(
    orgId: string,
    userId: string,
  ): Promise<boolean | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ onboardingDone: orgMembersMetadata.onboardingDone })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    return row?.onboardingDone;
  }

  async function countOnboardingRows(
    orgId: string,
    userId: string,
  ): Promise<number> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ orgId: orgMembersMetadata.orgId })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    return rows.length;
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().complete({ headers: {}, body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      apiClient().complete({ headers: authHeaders(), body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("marks onboarding as done for a member (DB read-after-write)", async () => {
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await expect(
      getOnboardingDone(fixture.orgId, fixture.userId),
    ).resolves.toBeUndefined();

    const response = await accept(
      apiClient().complete({ headers: authHeaders(), body: {} }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
    await expect(
      getOnboardingDone(fixture.orgId, fixture.userId),
    ).resolves.toBeTruthy();
  });

  it("is idempotent when called multiple times", async () => {
    const fixture = await track(
      store.set(seedOnboardingStatusOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const first = await accept(
      apiClient().complete({ headers: authHeaders(), body: {} }),
      [200],
    );
    expect(first.body).toStrictEqual({ ok: true });

    const second = await accept(
      apiClient().complete({ headers: authHeaders(), body: {} }),
      [200],
    );
    expect(second.body).toStrictEqual({ ok: true });

    await expect(
      countOnboardingRows(fixture.orgId, fixture.userId),
    ).resolves.toBe(1);
  });
});
