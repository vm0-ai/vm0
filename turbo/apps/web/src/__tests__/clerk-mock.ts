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
 * @param options.email - Email address for the user (default: "test@example.com")
 * @param options.orgId - Organization ID from active org session (optional)
 * @param options.orgSlug - Organization slug from active org session (optional)
 * @param options.clerkOrgs - Clerk orgs the user belongs to (for JIT discovery)
 */
export function mockClerk(options: {
  userId: string | null;
  email?: string;
  orgId?: string | null;
  orgSlug?: string | null;
  clerkOrgs?: Array<{ id: string; slug: string; name: string }>;
}) {
  const email = options.email ?? "test@example.com";

  // Default: one org per user (simulates signup-created org).
  // The org ID is derived from userId to ensure uniqueness across tests.
  const safeSlug = options.userId
    ? `org-${options.userId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 64)
    : "";
  const clerkOrgs =
    options.clerkOrgs ??
    (options.userId
      ? [
          {
            id: `org_mock_${options.userId}`,
            slug: safeSlug,
            name: `org-${options.userId}`,
          },
        ]
      : []);

  mockAuth.mockResolvedValue({
    userId: options.userId,
    orgId: options.orgId,
    orgSlug: options.orgSlug,
  } as Awaited<ReturnType<typeof auth>>);

  // Also set up clerkClient mock to return user data with email
  mockClerkClient.mockResolvedValue({
    users: {
      getUser: vi.fn().mockResolvedValue({
        emailAddresses: [{ id: "email_1", emailAddress: email }],
        primaryEmailAddressId: "email_1",
      }),
      getUserList: vi.fn().mockImplementation(({ emailAddress }) => {
        // Return user if email matches, empty array otherwise
        const queryEmail = emailAddress?.[0];
        if (queryEmail === email && options.userId) {
          return Promise.resolve({
            data: [{ id: options.userId }],
          });
        }
        return Promise.resolve({ data: [] });
      }),
      getOrganizationMembershipList: vi.fn().mockResolvedValue({
        data: clerkOrgs.map((org) => ({
          organization: { id: org.id, slug: org.slug, name: org.name },
          role: "org:admin",
          publicUserData: { userId: options.userId },
        })),
      }),
    },
    organizations: {
      createOrganization: vi
        .fn()
        .mockImplementation(({ name }: { name: string }) =>
          Promise.resolve({ id: `org_mock_${name}` }),
        ),
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
