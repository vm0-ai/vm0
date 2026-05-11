import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroPersonalModelProvidersDefaultContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { modelProviders } from "@vm0/db/schema/model-provider";
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

describe("POST /api/zero/me/model-providers/:type/default", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersDefaultContract,
    );
    const response = await accept(
      client.setDefault({
        params: { type: "anthropic-api-key" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersDefaultContract,
    );
    const response = await accept(
      client.setDefault({
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
    const fixture = uniqueOrgUser("zmmpsd-feature-off");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersDefaultContract,
    );
    const response = await accept(
      client.setDefault({
        params: { type: "anthropic-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });

  it("flips the user's default and returns the updated provider", async () => {
    const fixture = uniqueOrgUser("zmmpsd-flip");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);

    // Seed two providers; anthropic is default, openai is not.
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
        type: "openai-api-key",
        isDefault: false,
        selectedModel: "gpt-5.5",
        secretName: "OPENAI_API_KEY",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersDefaultContract,
    );
    const response = await accept(
      client.setDefault({
        params: { type: "openai-api-key" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      type: "openai-api-key",
      isDefault: true,
      selectedModel: "gpt-5.5",
      secretName: "OPENAI_API_KEY",
    });

    // DB read-after-write proves atomic flip: only one row is default and it's
    // the one we just targeted.
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({
        type: modelProviders.type,
        isDefault: modelProviders.isDefault,
      })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, fixture.userId),
        ),
      );
    const byType = Object.fromEntries(
      rows.map((row) => {
        return [row.type, row.isDefault] as const;
      }),
    );
    expect(byType["openai-api-key"]).toBeTruthy();
    expect(byType["anthropic-api-key"]).toBeFalsy();
  });

  it("returns 404 with 'Resource not found' when type doesn't exist for the user", async () => {
    const fixture = uniqueOrgUser("zmmpsd-missing");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersDefaultContract,
    );
    const response = await accept(
      client.setDefault({
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
