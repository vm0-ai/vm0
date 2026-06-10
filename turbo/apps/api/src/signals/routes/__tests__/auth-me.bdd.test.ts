import { randomUUID } from "node:crypto";

import { authContract } from "@vm0/api-contracts/contracts/auth";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { userCache } from "@vm0/db/schema/user-cache";
import { createStore } from "ccstate";
import { eq, inArray } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";

// BDD migration of the legacy `auth-me.test.ts`. The 7 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) auth boundary (401
// unauth → 200 returns email after Clerk lookup + cache is
// populated), (2) 200 token types (sandbox token → zero token
// with `file:write` capability → zero token with no
// capabilities), (3) 200 cache chain (fresh cache short-circuits
// Clerk → stale cache refreshes from Clerk + re-caches).
//
// Service-Level Exception: post-fetch cache state is verified
// via direct DB reads against `user_cache` because no follow-up
// endpoint for a single user cache row exists.

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

function clerkUser(
  userId: string,
  email: string,
  name: { readonly firstName?: string; readonly lastName?: string } = {},
) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    firstName: name.firstName ?? null,
    lastName: name.lastName ?? null,
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

function zeroToken(
  userId: string,
  capabilities: readonly ZeroCapability[],
): string {
  const nowSeconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId,
    orgId: `org_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    capabilities,
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

function mockNoMembership(): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
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

async function readUserCache(userId: string): Promise<{
  readonly email: string;
  readonly name: string | null;
  readonly cachedAt: Date;
} | null> {
  const writeDb = store.set(writeDb$);
  const [cached] = await writeDb
    .select({
      email: userCache.email,
      name: userCache.name,
      cachedAt: userCache.cachedAt,
    })
    .from(userCache)
    .where(eq(userCache.userId, userId))
    .limit(1);
  return cached ?? null;
}

describe("BDD GET /api/auth/me — auth boundary", () => {
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

  it("gwt-wt-wt: 401 unauth → 200 returns email after Clerk lookup + cache is populated", async () => {
    mockNow(NOW_MS);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(apiClient().me({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a fresh user + a Clerk session.
    const userId = `user_${randomUUID()}`;
    seededUserCacheIds.push(userId);
    mockSession(userId);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        clerkUser(userId, "test@example.com", {
          firstName: "Test",
          lastName: "User",
        }),
      ],
    });

    // When: call /api/auth/me.
    const response = await accept(
      apiClient().me({ headers: authHeaders() }),
      [200],
    );

    // Then: 200 with userId + email + the user cache row is
    // populated.
    expect(response.body).toStrictEqual({
      userId,
      email: "test@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [userId],
    });
    await expect(readUserCache(userId)).resolves.toStrictEqual({
      email: "test@example.com",
      name: "Test User",
      cachedAt: new Date(NOW_MS),
    });
  });
});

describe("BDD GET /api/auth/me — 200 token types", () => {
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

  it("gwt-wt-wt: sandbox token → zero token with `file:write` capability → zero token with no capabilities", async () => {
    mockNow(NOW_MS);

    // Given: a sandbox token for a fresh user.
    const sandboxUserId = `user_${randomUUID()}`;
    seededUserCacheIds.push(sandboxUserId);
    const sandboxJwt = sandboxToken(sandboxUserId);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(sandboxUserId, "sandbox@example.com")],
    });

    // When + Then: 200 with the sandbox user's email.
    const sandbox = await accept(
      apiClient().me({ headers: authHeaders(sandboxJwt) }),
      [200],
    );
    expect(sandbox.body).toStrictEqual({
      userId: sandboxUserId,
      email: "sandbox@example.com",
    });

    // Given: a zero token with `file:write` capability.
    const fileUserId = `user_${randomUUID()}`;
    seededUserCacheIds.push(fileUserId);
    mockNoMembership();
    const fileJwt = zeroToken(fileUserId, ["file:write"]);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(fileUserId, "file@example.com")],
    });

    // When + Then: 200 with the file user's email.
    const file = await accept(
      apiClient().me({ headers: authHeaders(fileJwt) }),
      [200],
    );
    expect(file.body).toStrictEqual({
      userId: fileUserId,
      email: "file@example.com",
    });

    // Given: a zero token with no capabilities.
    const emptyUserId = `user_${randomUUID()}`;
    seededUserCacheIds.push(emptyUserId);
    mockNoMembership();
    const emptyJwt = zeroToken(emptyUserId, []);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(emptyUserId, "empty-capabilities@example.com")],
    });

    // When + Then: 200 with the empty-capabilities user's
    // email.
    const empty = await accept(
      apiClient().me({ headers: authHeaders(emptyJwt) }),
      [200],
    );
    expect(empty.body).toStrictEqual({
      userId: emptyUserId,
      email: "empty-capabilities@example.com",
    });
  });
});

describe("BDD GET /api/auth/me — 200 cache chain", () => {
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

  it("gwt-wt-wt: fresh cached email short-circuits Clerk → stale cache refreshes from Clerk + re-caches", async () => {
    mockNow(NOW_MS);

    // Given: a sandbox token + a fresh cache row (1s old).
    const cachedUserId = `user_${randomUUID()}`;
    const cachedToken = sandboxToken(cachedUserId);
    await seedUserCache(
      seededUserCacheIds,
      cachedUserId,
      "cached@example.com",
      new Date(NOW_MS - 1000),
    );

    // When + Then: 200 with the cached email; Clerk is not
    // called.
    const cached = await accept(
      apiClient().me({ headers: authHeaders(cachedToken) }),
      [200],
    );
    expect(cached.body).toStrictEqual({
      userId: cachedUserId,
      email: "cached@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();

    // Given: a sandbox token + a stale cache row (16min old) +
    // Clerk returns a fresh email.
    const staleUserId = `user_${randomUUID()}`;
    seededUserCacheIds.push(staleUserId);
    const staleToken = sandboxToken(staleUserId);
    await seedUserCache(
      seededUserCacheIds,
      staleUserId,
      "stale@example.com",
      new Date(NOW_MS - 16 * 60 * 1000),
    );
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUser(staleUserId, "fresh@example.com")],
    });

    // When + Then: 200 with the fresh email; Clerk is called
    // + the cache is refreshed.
    const stale = await accept(
      apiClient().me({ headers: authHeaders(staleToken) }),
      [200],
    );
    expect(stale.body).toStrictEqual({
      userId: staleUserId,
      email: "fresh@example.com",
    });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledWith({
      userId: [staleUserId],
    });
    await expect(readUserCache(staleUserId)).resolves.toStrictEqual({
      email: "fresh@example.com",
      name: null,
      cachedAt: new Date(NOW_MS),
    });
  });
});
