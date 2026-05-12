import { randomUUID } from "node:crypto";

import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { secrets } from "@vm0/db/schema/secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherSecret$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/secrets", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns current user secret metadata sorted by name", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const updatedAt = new Date("2026-01-03T03:04:05.000Z");
    const fixture = await track(
      store.set(
        seedSecrets$,
        [
          {
            name: "Z_TOKEN",
            description: null,
            type: "connector",
            createdAt,
            updatedAt,
          },
          {
            name: "A_TOKEN",
            description: "alpha",
            type: "user",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherSecret$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.secrets).toHaveLength(2);
    expect(response.body.secrets).toMatchObject([
      {
        name: "A_TOKEN",
        description: "alpha",
        type: "user",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
      {
        name: "Z_TOKEN",
        description: null,
        type: "connector",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
    ]);
    for (const secret of response.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }
  });

  it("returns an empty list when the user has no secrets", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ secrets: [] });
  });
});

describe("POST /api/zero/secrets", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: {},
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
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
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("creates a user secret and stores an encrypted value", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_SECRET",
          value: "secret-value",
          description: "Test secret",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      name: "MY_SECRET",
      description: "Test secret",
      type: "user",
    });
    expect(response.body.id).toBeDefined();
    expect(response.body.createdAt).toBeDefined();
    expect(response.body.updatedAt).toBeDefined();
    expect(response.body).not.toHaveProperty("value");
    expect(response.body).not.toHaveProperty("encryptedValue");

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({
        encryptedValue: secrets.encryptedValue,
        type: secrets.type,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "MY_SECRET"),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("user");
    expect(rows[0]?.encryptedValue).not.toBe("secret-value");
  });

  it("updates an existing user secret without creating a duplicate", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const created = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_SECRET",
          value: "value-v1",
          description: "Initial description",
        },
      }),
      [200],
    );

    const updated = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_SECRET",
          value: "value-v2",
          description: "Updated description",
        },
      }),
      [200],
    );

    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.name).toBe("MY_SECRET");
    expect(updated.body.description).toBe("Updated description");

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "MY_SECRET"),
          eq(secrets.type, "user"),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe("Updated description");
    expect(rows[0]?.encryptedValue).not.toBe("value-v2");
  });

  it("returns 400 for invalid secret names", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "invalid name",
          value: "secret-value",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for empty secret values", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "MY_SECRET",
          value: "",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("does not overwrite another user's secret with the same name", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    const otherUserId = `user_${randomUUID()}`;
    const writeDb = store.set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId: fixture.orgId,
      userId: otherUserId,
      name: "SHARED_SECRET",
      encryptedValue: "other-user-encrypted",
      description: "Other user",
      type: "user",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "SHARED_SECRET",
          value: "current-user-value",
          description: "Current user",
        },
      }),
      [200],
    );

    expect(response.body.description).toBe("Current user");

    const rows = await writeDb
      .select({
        userId: secrets.userId,
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.name, "SHARED_SECRET"),
          eq(secrets.type, "user"),
        ),
      );

    expect(rows).toHaveLength(2);
    expect(
      rows.find((row) => {
        return row.userId === otherUserId;
      }),
    ).toMatchObject({
      encryptedValue: "other-user-encrypted",
      description: "Other user",
    });
    expect(
      rows.find((row) => {
        return row.userId === fixture.userId;
      }),
    ).toMatchObject({
      description: "Current user",
    });
  });
});
