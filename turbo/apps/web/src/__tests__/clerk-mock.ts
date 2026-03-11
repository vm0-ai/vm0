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

// Module-level tracking of orgs created via createOrganization.
// Persists across mockClerk() calls so that re-mocking (e.g. to set orgId)
// doesn't lose orgs created by earlier API calls (like createTestScope).
let createdOrgs: Array<{
  id: string;
  slug: string;
  name: string;
  creatorUserId: string;
}> = [];

/**
 * Configure Clerk auth mock
 * @param options - Auth configuration
 * @param options.userId - User ID to return, or null for unauthenticated
 * @param options.email - Email address for the user (default: "test@example.com")
 * @param options.orgId - Organization ID from active org session (optional)
 * @param options.orgSlug - Organization slug from active org session (optional)
 * @param options.clerkOrgs - Clerk orgs the user belongs to (for JIT discovery)
 * @param options.orgTier - Tier to include in JWT sessionClaims.org_tier (optional)
 */
export function mockClerk(options: {
  userId: string | null;
  email?: string;
  orgId?: string | null;
  orgSlug?: string | null;
  orgRole?: string | null;
  orgTier?: string;
  clerkOrgs?: Array<{ id: string; slug: string; name: string; role?: string }>;
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

  // Note: createdOrgs is module-level (declared above) so it persists across
  // mockClerk() calls. This is critical: setupUser() calls mockClerk() then
  // createTestScope() (which calls createOrganization), and tests often call
  // mockClerk() again to configure orgId — without module-level tracking,
  // the org from createTestScope would be lost.

  mockAuth.mockResolvedValue({
    userId: options.userId,
    orgId: options.orgId,
    orgSlug: options.orgSlug,
    orgRole: options.orgRole ?? (options.orgId ? "org:admin" : undefined),
    sessionClaims: {
      ...(options.orgTier !== undefined && { org_tier: options.orgTier }),
    },
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
      getOrganizationMembershipList: vi
        .fn()
        .mockImplementation(({ userId: queryUserId }: { userId: string }) => {
          // Return orgs for the queried user, not just the session user.
          // This supports webhook routes where sandbox tokens pass a userId
          // different from the Clerk session.
          const queryCreated = createdOrgs.filter(
            (o) => o.creatorUserId === queryUserId,
          );
          const orgs =
            queryUserId === options.userId
              ? [...clerkOrgs, ...queryCreated]
              : queryCreated;
          return Promise.resolve({
            data: orgs.map((org) => ({
              organization: {
                id: org.id,
                slug: org.slug,
                name: org.name,
              },
              role: ("role" in org ? org.role : null) ?? "org:admin",
              publicUserData: { userId: queryUserId },
            })),
          });
        }),
    },
    organizations: {
      createOrganization: vi
        .fn()
        .mockImplementation(({ name }: { name: string }) => {
          const id = `org_mock_${name}`;
          createdOrgs.push({
            id,
            slug: name,
            name,
            creatorUserId: options.userId!,
          });
          return Promise.resolve({ id });
        }),
      getOrganizationMembershipList: vi
        .fn()
        .mockImplementation(
          ({ organizationId }: { organizationId: string }) => {
            // Return members of this org.
            // For clerkOrgs: session user is a member.
            // For createdOrgs: the creator is a member (regardless of session).
            const inClerkOrgs = clerkOrgs.some((o) => o.id === organizationId);
            if (inClerkOrgs && options.userId) {
              return Promise.resolve({
                data: [
                  {
                    role: "org:admin",
                    publicUserData: { userId: options.userId },
                    createdAt: Date.now(),
                  },
                ],
              });
            }
            const created = createdOrgs.find((o) => o.id === organizationId);
            if (created) {
              return Promise.resolve({
                data: [
                  {
                    role: "org:admin",
                    publicUserData: {
                      userId: created.creatorUserId,
                    },
                    createdAt: Date.now(),
                  },
                ],
              });
            }
            return Promise.resolve({ data: [] });
          },
        ),
      getOrganization: vi
        .fn()
        .mockImplementation(
          ({ organizationId }: { organizationId: string }) => {
            const created = createdOrgs.find((o) => o.id === organizationId);
            const fromClerk = clerkOrgs.find((o) => o.id === organizationId);
            const org = created ?? fromClerk;
            if (!org) {
              return Promise.reject(
                new Error(`Organization ${organizationId} not found`),
              );
            }
            return Promise.resolve({
              id: org.id,
              slug: org.slug,
              name: org.name,
              publicMetadata: {},
            });
          },
        ),
      updateOrganization: vi.fn().mockResolvedValue({}),
      updateOrganizationMetadata: vi.fn().mockResolvedValue({}),
      updateOrganizationMembershipMetadata: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);
}

/**
 * Clear all Clerk mock calls and reset to default state
 */
export function clearClerkMock() {
  mockAuth.mockClear();
  mockClerkClient.mockClear();
  createdOrgs = [];
}
