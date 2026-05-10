import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteUserModelProviders$,
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

async function enablePersonalProvider(orgId: string, userId: string) {
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: { [FeatureSwitchKey.PersonalModelProvider]: true },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: { [FeatureSwitchKey.PersonalModelProvider]: true } },
    });
}

describe("DELETE /api/zero/me/model-providers/:type", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({ params: { type: "anthropic-api-key" }, headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "anthropic-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 with 'Not found' when PersonalModelProvider feature is off", async () => {
    const fixture = uniqueOrgUser("zmmp-feature-off");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "anthropic-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });

  it("deletes the user's personal provider and removes the row + secret", async () => {
    const fixture = uniqueOrgUser("zmmp-delete");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "anthropic-api-key",
        secretName: "ANTHROPIC_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await client.delete({
      params: { type: "anthropic-api-key" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    // model_provider row removed
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, fixture.userId),
        ),
      );
    expect(remaining).toStrictEqual([]);

    // secret row also removed (FK cascade for legacy single-secret providers)
    const remainingSecrets = await writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "ANTHROPIC_API_KEY"),
        ),
      );
    expect(remainingSecrets).toStrictEqual([]);
  });

  it("returns 404 with 'Resource not found' when deleting a nonexistent provider", async () => {
    const fixture = uniqueOrgUser("zmmp-missing");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersByTypeContract,
    );
    const response = await accept(
      client.delete({
        params: { type: "anthropic-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });
});
