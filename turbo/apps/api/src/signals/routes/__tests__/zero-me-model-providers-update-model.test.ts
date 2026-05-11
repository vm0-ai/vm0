import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroPersonalModelProvidersUpdateModelContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
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

describe("PATCH /api/zero/me/model-providers/:type/model", () => {
  const track = createFixtureTracker<UserModelProviderFixture>((fixture) => {
    return store.set(deleteUserModelProviders$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(
      zeroPersonalModelProvidersUpdateModelContract,
    );
    const response = await accept(
      client.updateModel({
        params: { type: "anthropic-api-key" },
        body: { selectedModel: "claude-x" },
        headers: {},
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(
      zeroPersonalModelProvidersUpdateModelContract,
    );
    const response = await accept(
      client.updateModel({
        params: { type: "anthropic-api-key" },
        body: { selectedModel: "claude-x" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("returns 404 'Not found' when PersonalModelProvider feature is off", async () => {
    const fixture = uniqueOrgUser("zmmp-um-feature-off");
    await track(Promise.resolve(fixture));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersUpdateModelContract,
    );
    const response = await accept(
      client.updateModel({
        params: { type: "openai-api-key" },
        body: { selectedModel: "gpt-5.5" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not found", code: "NOT_FOUND" },
    });
  });

  it("updates selectedModel and persists (DB read-after-write)", async () => {
    const fixture = uniqueOrgUser("zmmp-um-update");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);
    await store.set(
      seedUserModelProvider$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        type: "openai-api-key",
        secretName: "OPENAI_API_KEY",
        selectedModel: "gpt-5",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersUpdateModelContract,
    );
    const response = await accept(
      client.updateModel({
        params: { type: "openai-api-key" },
        body: { selectedModel: "gpt-5.5" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.selectedModel).toBe("gpt-5.5");
    expect(response.body.type).toBe("openai-api-key");

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ selectedModel: modelProviders.selectedModel })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, fixture.orgId),
          eq(modelProviders.userId, fixture.userId),
          eq(modelProviders.type, "openai-api-key"),
        ),
      );
    expect(row?.selectedModel).toBe("gpt-5.5");
  });

  it("returns 404 'Resource not found' when the personal provider does not exist", async () => {
    const fixture = uniqueOrgUser("zmmp-um-missing");
    await track(Promise.resolve(fixture));
    await enablePersonalProvider(fixture.orgId, fixture.userId);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(
      zeroPersonalModelProvidersUpdateModelContract,
    );
    const response = await accept(
      client.updateModel({
        params: { type: "openai-api-key" },
        body: { selectedModel: "gpt-5.5" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });
});
