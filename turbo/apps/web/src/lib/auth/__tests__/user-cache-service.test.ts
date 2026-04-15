import { describe, it, expect, beforeEach, vi } from "vitest";
import type { User } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestOrg,
  insertUserCacheEntry,
} from "../../../__tests__/api-test-helpers";
// eslint-disable-next-line web/no-direct-db-in-tests -- Internal infrastructure: no API route
import { getCachedUser, getCachedUserIdByEmail } from "../user-cache-service";

/**
 * Build a minimal partial Clerk User object containing only the fields read by
 * user-cache-service. Casting to User is safe because the service only accesses
 * emailAddresses, primaryEmailAddressId, firstName, and lastName.
 */
function buildClerkUserMock(fields: {
  emailAddresses: Array<{ id: string; emailAddress: string }>;
  primaryEmailAddressId: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): User {
  return fields as unknown as User;
}

const context = testContext();

describe("getCachedUser", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("fetches from Clerk and caches on miss", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@example.com`;
    mockClerk({ userId, email });
    // createTestOrg triggers initServices() via the route handler
    await createTestOrg(uniqueId("org"));

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email, name: null });

    // Verify Clerk API was called
    const client = await clerkClient();
    expect(client.users.getUser).toHaveBeenCalledWith(userId);

    // Verify cache was populated: second call should NOT hit Clerk again
    vi.mocked(client.users.getUser).mockClear();
    const cached = await getCachedUser(userId);
    expect(cached).toEqual({ userId, email, name: null });
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("returns cached data without Clerk call when fresh", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@cached.com`;
    mockClerk({ userId });
    await createTestOrg(uniqueId("org"));

    // Pre-populate cache with fresh entry
    await insertUserCacheEntry({ userId, email });

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email, name: null });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("refetches from Clerk when cache is stale", async () => {
    const userId = uniqueId("test-user");
    const freshEmail = `${userId}@example.com`;
    mockClerk({ userId, email: freshEmail });
    await createTestOrg(uniqueId("org"));

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

  it("fetches and caches user name from Clerk", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@example.com`;
    mockClerk({ userId, email, firstName: "Alice", lastName: "Zhang" });
    await createTestOrg(uniqueId("org"));

    // Override getUser to include firstName and lastName
    const client = await clerkClient();
    vi.mocked(client.users.getUser).mockResolvedValueOnce(
      buildClerkUserMock({
        emailAddresses: [{ id: "email_1", emailAddress: email }],
        primaryEmailAddressId: "email_1",
        firstName: "Alice",
        lastName: "Zhang",
      }),
    );

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email, name: "Alice Zhang" });

    // Verify cache was populated with name: second call uses cache
    vi.mocked(client.users.getUser).mockClear();
    const cached = await getCachedUser(userId);
    expect(cached).toEqual({ userId, email, name: "Alice Zhang" });
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("returns cached name from fresh cache entry", async () => {
    const userId = uniqueId("test-user");
    const email = `${userId}@cached.com`;
    mockClerk({ userId });
    await createTestOrg(uniqueId("org"));

    // Pre-populate cache with name
    await insertUserCacheEntry({ userId, email, name: "Bob Smith" });

    const result = await getCachedUser(userId);

    expect(result).toEqual({ userId, email, name: "Bob Smith" });

    // Clerk API should NOT have been called
    const client = await clerkClient();
    expect(client.users.getUser).not.toHaveBeenCalled();
  });

  it("throws when user has no primary email", async () => {
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("org"));

    // Override getUser to return no primary email
    const client = await clerkClient();
    vi.mocked(client.users.getUser).mockResolvedValueOnce(
      buildClerkUserMock({
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    );

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
    await createTestOrg(uniqueId("org"));

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
    await createTestOrg(uniqueId("org"));

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
    await createTestOrg(uniqueId("org"));

    const result = await getCachedUserIdByEmail("nonexistent@example.com");

    expect(result).toBeNull();
  });
});
