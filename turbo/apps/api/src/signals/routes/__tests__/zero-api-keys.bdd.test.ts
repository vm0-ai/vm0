import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeysByIdContract,
  apiKeysContract,
  type CreateApiKeyResponse,
} from "@vm0/api-contracts/contracts/api-keys";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ApiKeyCleanup {
  readonly userId: string;
  readonly orgId: string | null;
  readonly keyId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function keysClient() {
  return setupApp({ context })(apiKeysContract);
}

function keyByIdClient() {
  return setupApp({ context })(apiKeysByIdContract);
}

function setSession(args: {
  readonly userId: string;
  readonly orgId: string | null;
}) {
  mocks.clerk.session(args.userId, args.orgId);
}

async function createApiKey(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
  readonly expiresInDays: number;
  readonly createdAt: string;
}): Promise<CreateApiKeyResponse> {
  mockNow(new Date(args.createdAt));
  setSession({ userId: args.userId, orgId: args.orgId });

  const response = await accept(
    keysClient().create({
      headers: authHeaders(),
      body: { name: args.name, expiresInDays: args.expiresInDays },
    }),
    [201],
  );

  await trackApiKey(
    Promise.resolve({
      userId: args.userId,
      orgId: args.orgId,
      keyId: response.body.id,
    }),
  );

  return response.body;
}

async function deleteApiKey(args: {
  readonly userId: string;
  readonly orgId: string | null;
  readonly keyId: string;
}) {
  setSession({ userId: args.userId, orgId: args.orgId });
  return await keyByIdClient().delete({
    params: { id: args.keyId },
    headers: authHeaders(),
  });
}

const trackApiKey = createFixtureTracker<ApiKeyCleanup>(async (apiKey) => {
  await accept(deleteApiKey(apiKey), [204, 404]);
});

afterEach(() => {
  clearMockNow();
});

describe("/api/zero/api-keys BDD", () => {
  it("enforces auth, organization, and create validation boundaries", async () => {
    const listUnauthenticated = await accept(
      keysClient().list({ headers: {} }),
      [401],
    );
    const createUnauthenticated = await accept(
      keysClient().create({
        headers: {},
        body: { name: "CI bot", expiresInDays: 90 },
      }),
      [401],
    );
    const deleteUnauthenticated = await accept(
      keyByIdClient().delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(listUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(createUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    setSession({ userId: `user_${randomUUID()}`, orgId: null });
    const noActiveOrg = await accept(
      keysClient().create({
        headers: authHeaders(),
        body: { name: "CI bot", expiresInDays: 90 },
      }),
      [400],
    );

    expect(noActiveOrg.body.error.code).toBe("BAD_REQUEST");

    setSession({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const emptyName = await accept(
      keysClient().create({
        headers: authHeaders(),
        body: { name: "", expiresInDays: 90 },
      }),
      [400],
    );
    const nonPositiveExpiry = await accept(
      keysClient().create({
        headers: authHeaders(),
        body: { name: "CI bot", expiresInDays: 0 },
      }),
      [400],
    );
    const aboveCapExpiry = await accept(
      keysClient().create({
        headers: authHeaders(),
        body: { name: "CI bot", expiresInDays: 4000 },
      }),
      [400],
    );

    expect(emptyName.body.error.code).toBe("BAD_REQUEST");
    expect(nonPositiveExpiry.body.error.code).toBe("BAD_REQUEST");
    expect(aboveCapExpiry.body.error.code).toBe("BAD_REQUEST");
  });

  it("creates, lists, hides full tokens, sorts, and deletes caller-owned keys", async () => {
    const owner = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const other = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };

    setSession(owner);
    const initiallyEmpty = await accept(
      keysClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(initiallyEmpty.body).toStrictEqual({ apiKeys: [] });

    const older = await createApiKey({
      ...owner,
      name: "Older",
      expiresInDays: 30,
      createdAt: "2026-03-01T00:00:00.000Z",
    });
    const newer = await createApiKey({
      ...owner,
      name: "Newer",
      expiresInDays: 90,
      createdAt: "2026-03-02T00:00:00.000Z",
    });
    const otherUserKey = await createApiKey({
      ...other,
      name: "Other user",
      expiresInDays: 30,
      createdAt: "2026-03-03T00:00:00.000Z",
    });

    expect(newer.token).toMatch(/^vm0_pat_/);
    expect(newer.tokenPrefix).toBe(`${newer.token.slice(0, 12)}\u2026`);
    expect(
      new Date(newer.expiresAt).getTime() - new Date(newer.createdAt).getTime(),
    ).toBe(90 * MS_PER_DAY);

    setSession(owner);
    const listed = await accept(
      keysClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(listed.body.apiKeys).toHaveLength(2);
    expect(
      listed.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).toStrictEqual([newer.id, older.id]);
    expect(listed.body.apiKeys).toMatchObject([
      {
        id: newer.id,
        name: "Newer",
        tokenPrefix: newer.tokenPrefix,
        createdAt: "2026-03-02T00:00:00.000Z",
        lastUsedAt: null,
      },
      {
        id: older.id,
        name: "Older",
        tokenPrefix: older.tokenPrefix,
        createdAt: "2026-03-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
    expect(
      Object.keys(
        listed.body.apiKeys.find((apiKey) => {
          return apiKey.id === newer.id;
        }) ?? {},
      ),
    ).not.toContain("token");
    expect(
      listed.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).not.toContain(otherUserKey.id);

    const deleteOtherUserKey = await accept(
      deleteApiKey({
        userId: owner.userId,
        orgId: owner.orgId,
        keyId: otherUserKey.id,
      }),
      [404],
    );

    expect(deleteOtherUserKey.body).toStrictEqual({
      error: { message: "API key not found", code: "NOT_FOUND" },
    });

    const deletedNewer = await accept(
      deleteApiKey({
        userId: owner.userId,
        orgId: owner.orgId,
        keyId: newer.id,
      }),
      [204],
    );

    expect(deletedNewer.body).toBeUndefined();

    const afterDelete = await accept(
      keysClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      afterDelete.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).toStrictEqual([older.id]);

    setSession(other);
    const otherStillHasKey = await accept(
      keysClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      otherStillHasKey.body.apiKeys.map((apiKey) => {
        return apiKey.id;
      }),
    ).toStrictEqual([otherUserKey.id]);
  });
});
