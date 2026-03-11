import { describe, it, expect, beforeEach, vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestScope,
  insertUserCacheEntry,
} from "../../../__tests__/api-test-helpers";
import { getCachedUser, getCachedUserIdByEmail } from "../user-cache-service";

const context = testContext();

describe("getCachedUser", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@example.com`;
    mockClerk({ userId, email });
    // createTestScope triggers initServices() via the route handler
    await createTestScope(uniqueId("scope"));

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email });

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.users.getUser).toHaveBeenCalledWith(userId);

    // Verify cache was populated: second call should NOT hit Clerk again
    vi.mocked(client.users.getUser).mockClear();
    const cached = await getCachedUser(userId);
    expect(cached).toEqual({ userId, email });
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("returns cached data without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@cached.com`;
    mockClerk({ userId });
    await createTestScope(uniqueId("scope"));

    // Pre-populate cache with fresh entry
    await insertUserCacheEntry({ userId, email });

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const freshEmail = `${userId}@example.com`;
    mockClerk({ userId, email: freshEmail });
    await createTestScope(uniqueId("scope"));

    // Pre-populate cache with stale entry (2 minutes ago)
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await insertUserCacheEntry({
      userId,
      email: "old@stale.com",
      cachedAt: twoMinutesAgo,
    });

    const result = await getCachedUser(userId);

    // Should have fresh data from Clerk mock
    expect(result.email).toBe(freshEmail);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.users.getUser).toHaveBeenCalledWith(userId);

    // Verify cache was updated: second call should use fresh cache
    vi.mocked(client.users.getUser).mockClear();
    const cached = await getCachedUser(userId);
    expect(cached.email).toBe(freshEmail);
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("throws when user has no primary email", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("scope"));

    // Override getUser to return no primary email
    const client = await clerkClient();
    vi.mocked(client.users.getUser).mockResolvedValueOnce({
      emailAddresses: [],
      primaryEmailAddressId: null,
    } as unknown as Awaited<ReturnType<typeof client.users.getUser>>);

    await expect(getCachedUser(userId)).rejects.toThrow(
      `No primary email found for user ${userId}`,
    );
  });
});

describe("getCachedUserIdByEmail", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns userId from cache when fresh", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@cached.com`;
    mockClerk({ userId });
    await createTestScope(uniqueId("scope"));

    // Pre-populate cache
    await insertUserCacheEntry({ userId, email });

    const result = await getCachedUserIdByEmail(email);

    expect(result).toBe(userId);

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.users.getUserList).not.toHaveBeenCalled();
  });

  it("fetches from Clerk on cache miss and caches result", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@example.com`;
    mockClerk({ userId, email });
    await createTestScope(uniqueId("scope"));

    const result = await getCachedUserIdByEmail(email);

    expect(result).toBe(userId);

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.users.getUserList).toHaveBeenCalled();

    // Verify cache was populated: second call should NOT hit Clerk again
    vi.mocked(client.users.getUserList).mockClear();
    const cached = await getCachedUserIdByEmail(email);
    expect(cached).toBe(userId);
    expect(client.users.getUserList).not.toHaveBeenCalled();
  });

  it("returns null when user not found", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("scope"));

    const result = await getCachedUserIdByEmail("nonexistent@example.com");

    expect(result).toBeNull();
  });
});
