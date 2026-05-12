import { randomUUID } from "node:crypto";

import { authContract } from "@vm0/api-contracts/contracts/auth";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";

const NOW_MS = Date.parse("2026-05-12T04:00:00.000Z");
const context = testContext();
const store = createStore();

function apiClient() {
  return setupApp({ context })(authContract);
}

function authHeaders(token = "clerk-session") {
  return { authorization: `Bearer ${token}` };
}

function currentSecond(): number {
  return Math.floor(NOW_MS / 1000);
}

function clerkUser(userId: string, email: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    emailAddresses: [{ id: emailId, emailAddress: email }],
    primaryEmailAddressId: emailId,
  };
}

function sandboxToken(userId: string): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId,
    orgId: `org_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    iat: nowSeconds,
    exp: nowSeconds + 60,
  });
}

function mockSession(userId: string): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId: `org_${randomUUID()}`,
        orgRole: "org:admin",
      };
    },
  });
}

async function seedUserCache(
  seededUserCacheIds: string[],
  userId: string,
  email: string,
  cachedAt: Date,
): Promise<void> {
  seededUserCacheIds.push(userId);
  const writeDb = store.set(writeDb$);
  await writeDb
    .insert(userCache)
    .values({
      userId,
      email,
      name: null,
      cachedAt,
    })
    .onConflictDoUpdate({
      target: userCache.userId,
      set: { email, name: null, cachedAt },
    });
}

beforeEach(() => {
  mockNow(NOW_MS);
});

describe("GET /api/auth/me", () => {
  let seededUserCacheIds: string[] = [];

  afterEach(async () => {
    if (seededUserCacheIds.length === 0) {
      return;
    }

    const ids = seededUserCacheIds;
    seededUserCacheIds = [];
    const writeDb = store.set(writeDb$);
    await writeDb.delete(userCache).where(inArray(userCache.userId, ids));
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = apiClient();

    const response = await accept(client.me({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns authenticated user info with email", async () => {
    const userId = `user_${randomUUID()}`;
    mockSession(userId);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(userId, "test@example.com")],
    });
    const client = apiClient();

    const response = await accept(client.me({ headers: authHeaders() }), [200]);

    expect(response.body).toStrictEqual({
      userId,
      email: "test@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [userId],
    });
  });

  it("accepts sandbox tokens without a required capability", async () => {
    const userId = `user_${randomUUID()}`;
    const token = sandboxToken(userId);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(userId, "sandbox@example.com")],
    });
    const client = apiClient();

    const response = await accept(
      client.me({ headers: authHeaders(token) }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId,
      email: "sandbox@example.com",
    });
  });

  it("uses a fresh cached email without fetching a Clerk profile", async () => {
    const userId = `user_${randomUUID()}`;
    const token = sandboxToken(userId);
    await seedUserCache(
      seededUserCacheIds,
      userId,
      "cached@example.com",
      new Date(NOW_MS - 1000),
    );
    const client = apiClient();

    const response = await accept(
      client.me({ headers: authHeaders(token) }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId,
      email: "cached@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("resolves stale cached email from Clerk for the response", async () => {
    const userId = `user_${randomUUID()}`;
    const token = sandboxToken(userId);
    await seedUserCache(
      seededUserCacheIds,
      userId,
      "stale@example.com",
      new Date(NOW_MS - 16 * 60 * 1000),
    );
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(userId, "fresh@example.com")],
    });
    const client = apiClient();

    const response = await accept(
      client.me({ headers: authHeaders(token) }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId,
      email: "fresh@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [userId],
    });
  });
});
