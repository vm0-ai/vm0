import { randomUUID } from "node:crypto";

import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { createStore, command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

interface UserModelPreferenceFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface UserModelPreferenceSeedValues {
  readonly selectedModel?: string | null;
  readonly updatedAt?: Date;
}

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const seedUserModelPreferenceFixture$ = command(
  async (
    { set },
    values: UserModelPreferenceSeedValues,
    signal: AbortSignal,
  ): Promise<UserModelPreferenceFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    if ("selectedModel" in values) {
      await writeDb.insert(orgMembersMetadata).values({
        orgId,
        userId,
        selectedModel: values.selectedModel ?? null,
        updatedAt: values.updatedAt,
      });
      signal.throwIfAborted();
    }

    return { orgId, userId };
  },
);

const deleteUserModelPreferenceFixture$ = command(
  async (
    { set },
    fixture: UserModelPreferenceFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);

    await writeDb
      .delete(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    await writeDb
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

const track = createFixtureTracker<UserModelPreferenceFixture>((fixture) => {
  return store.set(deleteUserModelPreferenceFixture$, fixture, context.signal);
});

function apiClient() {
  return setupApp({ context })(zeroUserModelPreferenceContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedFixture(
  values: UserModelPreferenceSeedValues = {},
): Promise<UserModelPreferenceFixture> {
  return track(
    store.set(seedUserModelPreferenceFixture$, values, context.signal),
  );
}

describe("GET /api/zero/user-model-preference", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(apiClient().get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, null);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns null defaults when the member preference row does not exist", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
  });

  it("returns the persisted selected model for the current org member", async () => {
    const updatedAt = new Date("2026-01-02T03:04:05.000Z");
    const fixture = await seedFixture({
      selectedModel: "claude-sonnet-4-6",
      updatedAt,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: updatedAt.toISOString(),
    });
  });
});

describe("PUT /api/zero/user-model-preference", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      apiClient().update({
        headers: {},
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, null);

    const response = await accept(
      apiClient().update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 400 for invalid request bodies", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request("/api/zero/user-model-preference", {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: expect.stringContaining("selectedModel: Invalid option"),
        code: "BAD_REQUEST",
      },
    });
  });

  it("creates and returns a configured selected model preference", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "claude-sonnet-4-6" },
      }),
      [200],
    );

    expect(updateResponse.body.selectedModel).toBe("claude-sonnet-4-6");
    expect(updateResponse.body.updatedAt).toStrictEqual(expect.any(String));

    const getResponse = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(getResponse.body).toStrictEqual(updateResponse.body);
  });

  it("returns 400 without persisting an unconfigured supported model", async () => {
    const fixture = await seedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();

    const response = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: "gpt-5.4" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid request",
        code: "BAD_REQUEST",
      },
    });

    const getResponse = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(getResponse.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
  });

  it("clears an existing selected model preference", async () => {
    const fixture = await seedFixture({ selectedModel: "claude-sonnet-4-6" });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = apiClient();

    const updateResponse = await accept(
      client.update({
        headers: authHeaders(),
        body: { selectedModel: null },
      }),
      [200],
    );

    expect(updateResponse.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });

    const getResponse = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(getResponse.body).toStrictEqual({
      selectedModel: null,
      updatedAt: null,
    });
  });
});
