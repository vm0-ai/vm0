import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgModelProviders$,
  deleteUserModelProviders$,
  seedOrgModelProvider$,
  seedUserModelProvider$,
  type UserModelProviderFixture,
} from "./helpers/zero-model-providers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function uniqueOrgUser(prefix: string): UserModelProviderFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

async function setPersonalSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userFeatureSwitches)
    .values({ orgId, userId, switches })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches },
    });
}

async function deletePersonalSwitches(
  fixture: UserModelProviderFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
}

async function enableModelFirst(orgId: string, userId: string): Promise<void> {
  await setPersonalSwitches(orgId, userId, {
    [FeatureSwitchKey.ModelFirstModelProvider]: true,
  });
}

describe("GET /api/zero/me/model-providers", () => {
  const trackUsers = createFixtureTracker<UserModelProviderFixture>(
    async (fixture) => {
      await store.set(deleteUserModelProviders$, fixture, context.signal);
      await deletePersonalSwitches(fixture);
    },
  );
  const trackOrg = createFixtureTracker<{ readonly orgId: string }>(
    (fixture) => {
      return store.set(deleteOrgModelProviders$, fixture, context.signal);
    },
  );

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when ModelFirstModelProvider is off", async () => {
    const fixture = await trackUsers(
      Promise.resolve(uniqueOrgUser("zmmp-list-feature-off")),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });

  it("returns empty list when no personal providers exist", async () => {
    const fixture = await trackUsers(
      Promise.resolve(uniqueOrgUser("zmmp-list-empty")),
    );
    await enableModelFirst(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.modelProviders).toStrictEqual([]);
  });

  it("lists only the current user's model-first personal providers", async () => {
    const fixture = await trackUsers(
      Promise.resolve(uniqueOrgUser("zmmp-list-user")),
    );
    await trackOrg(Promise.resolve({ orgId: fixture.orgId }));
    await enableModelFirst(fixture.orgId, fixture.userId);
    await store.set(
      seedOrgModelProvider$,
      {
        orgId: fixture.orgId,
        type: "claude-code-oauth-token",
        isDefault: true,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "anthropic-api-key",
        isDefault: true,
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "claude-code-oauth-token",
        isDefault: false,
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersMainContract,
    );
    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.modelProviders).toHaveLength(1);
    expect(response.body.modelProviders[0]?.type).toBe(
      "claude-code-oauth-token",
    );
  });
});
