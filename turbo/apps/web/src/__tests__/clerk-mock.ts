import { vi } from "vitest";
import { auth, clerkClient } from "@clerk/nextjs/server";

/**
 * Mock Clerk auth for testing
 *
 * @example
 * ```typescript
 * import { mockClerk, clearClerkMock } from '@/__tests__/clerk-mock';
 *
 * beforeEach(() => {
 *   mockClerk({ userId: 'test-user-123' });
 * });
 *
 * afterEach(() => {
 *   clearClerkMock();
 * });
 *
 * it('should reject unauthenticated request', () => {
 *   mockClerk({ userId: null });
 *   // ...
 * });
 * ```
 */

/** The email address returned by the Clerk mock for all test users */
export const MOCK_USER_EMAIL = "test@example.com";

const mockAuth = vi.mocked(auth);
const mockClerkClient = vi.mocked(clerkClient);

/**
 * Configure Clerk auth mock
 * @param options - Auth configuration
 * @param options.userId - User ID to return, or null for unauthenticated
 */
export function mockClerk(options: { userId: string | null }) {
  mockAuth.mockResolvedValue({
    userId: options.userId,
  } as Awaited<ReturnType<typeof auth>>);

  // Also set up clerkClient mock to return user data with email
  mockClerkClient.mockResolvedValue({
    users: {
      getUser: vi.fn().mockResolvedValue({
        emailAddresses: [{ id: "email_1", emailAddress: MOCK_USER_EMAIL }],
        primaryEmailAddressId: "email_1",
      }),
    },
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);
}

/**
 * Clear all Clerk mock calls and reset to default state
 */
export function clearClerkMock() {
  mockAuth.mockClear();
  mockClerkClient.mockClear();
}
