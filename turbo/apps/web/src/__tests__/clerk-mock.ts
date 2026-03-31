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

const mockAuth = vi.mocked(auth);
const mockClerkClient = vi.mocked(clerkClient);

// Module-level tracking of orgs created via createOrganization.
// Persists across mockClerk() calls so that re-mocking (e.g. to set orgId)
// doesn't lose orgs created by earlier API calls (like createTestOrg).
let createdOrgs: Array<{
  id: string;
  slug: string;
  name: string;
  creatorUserId: string;
}> = [];

// Module-level tracking of org slug mutations.
// Persists across mockClerk() calls so that route handlers that mutate
// org data (e.g. updateOrganization) are reflected in subsequent
// getOrganization calls.
let orgSlugOverrides = new Map<string, string>();

// Module-level tracking of all userIds configured via mockClerk().
// Used by testContext afterEach to scope user_cache cleanup to rows created
// by this test, avoiding cross-file interference in parallel test runs.
let mockUserIds: string[] = [];

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
  firstName?: string | null;
  lastName?: string | null;
  orgId?: string | null;
  orgSlug?: string | null;
  orgRole?: string | null;
  clerkOrgs?: Array<{ id: string; slug: string; name: string; role?: string }>;
}) {
  const email = options.email ?? "test@example.com";

  // Track userId for scoped user_cache cleanup in testContext afterEach
  if (options.userId) {
    mockUserIds.push(options.userId);
  }

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
  // createTestOrg() (which calls createOrganization), and tests often call
  // mockClerk() again to configure orgId — without module-level tracking,
  // the org from createTestOrg would be lost.

  // Default orgId: use user's default org when not explicitly set.
  // Pass orgId: null to simulate CLI tokens with no active org.
  const effectiveOrgId =
    options.orgId !== undefined
      ? options.orgId
      : options.userId
        ? `org_mock_${options.userId}`
        : undefined;

  mockAuth.mockResolvedValue({
    userId: options.userId,
    orgId: effectiveOrgId,
    orgSlug: options.orgSlug,
    orgRole: options.orgRole ?? (effectiveOrgId ? "org:admin" : undefined),
    sessionClaims: {},
  } as Awaited<ReturnType<typeof auth>>);

  // Also set up clerkClient mock to return user data with email
  mockClerkClient.mockResolvedValue({
    users: {
      getUser: vi.fn().mockResolvedValue({
        emailAddresses: [{ id: "email_1", emailAddress: email }],
        primaryEmailAddressId: "email_1",
      }),
      getUserList: vi
        .fn()
        .mockImplementation(
          ({
            emailAddress,
            userId: userIdQuery,
          }: {
            emailAddress?: string[];
            userId?: string[];
          }) => {
            // Return user if email matches
            const queryEmail = emailAddress?.[0];
            if (queryEmail === email && options.userId) {
              return Promise.resolve({
                data: [
                  {
                    id: options.userId,
                    emailAddresses: [{ id: "email_1", emailAddress: email }],
                    primaryEmailAddressId: "email_1",
                    firstName: options.firstName ?? null,
                    lastName: options.lastName ?? null,
                    imageUrl: "",
                  },
                ],
              });
            }
            // Return matching users when queried by userId array
            if (userIdQuery && userIdQuery.length > 0 && options.userId) {
              const matchedUsers = userIdQuery
                .filter((uid) => {
                  return uid === options.userId;
                })
                .map((uid) => {
                  return {
                    id: uid,
                    emailAddresses: [{ id: "email_1", emailAddress: email }],
                    primaryEmailAddressId: "email_1",
                    firstName: options.firstName ?? null,
                    lastName: options.lastName ?? null,
                    imageUrl: "",
                  };
                });
              return Promise.resolve({ data: matchedUsers });
            }
            return Promise.resolve({ data: [] });
          },
        ),
      getOrganizationMembershipList: vi
        .fn()
        .mockImplementation(({ userId: queryUserId }: { userId: string }) => {
          // Return orgs for the queried user, not just the session user.
          // This supports webhook routes where sandbox tokens pass a userId
          // different from the Clerk session.
          const queryCreated = createdOrgs.filter((o) => {
            return o.creatorUserId === queryUserId;
          });
          const orgs =
            queryUserId === options.userId
              ? [...clerkOrgs, ...queryCreated]
              : queryCreated;
          return Promise.resolve({
            data: orgs.map((org) => {
              return {
                organization: {
                  id: org.id,
                  slug: org.slug,
                  name: org.name,
                },
                role: ("role" in org ? org.role : null) ?? "org:admin",
                publicUserData: { userId: queryUserId },
              };
            }),
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
            const matchedClerkOrg = clerkOrgs.find((o) => {
              return o.id === organizationId;
            });
            if (matchedClerkOrg && options.userId) {
              return Promise.resolve({
                data: [
                  {
                    role: matchedClerkOrg.role ?? "org:admin",
                    publicUserData: { userId: options.userId },
                    publicMetadata: {},
                    createdAt: Date.now(),
                  },
                ],
              });
            }
            const created = createdOrgs.find((o) => {
              return o.id === organizationId;
            });
            if (created) {
              return Promise.resolve({
                data: [
                  {
                    role: "org:admin",
                    publicUserData: {
                      userId: created.creatorUserId,
                    },
                    publicMetadata: {},
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
          (params: { organizationId?: string; slug?: string }) => {
            // Check slug overrides for reverse lookup
            let org;
            if (params.organizationId) {
              org =
                createdOrgs.find((o) => {
                  return o.id === params.organizationId;
                }) ??
                clerkOrgs.find((o) => {
                  return o.id === params.organizationId;
                });
            } else if (params.slug) {
              // Also check slug overrides (an org's slug may have been updated)
              const overriddenOrgId = [...orgSlugOverrides.entries()].find(
                ([, slug]) => {
                  return slug === params.slug;
                },
              )?.[0];
              if (overriddenOrgId) {
                org =
                  createdOrgs.find((o) => {
                    return o.id === overriddenOrgId;
                  }) ??
                  clerkOrgs.find((o) => {
                    return o.id === overriddenOrgId;
                  });
              } else {
                org =
                  createdOrgs.find((o) => {
                    return o.slug === params.slug;
                  }) ??
                  clerkOrgs.find((o) => {
                    return o.slug === params.slug;
                  });
              }
            }
            if (!org) {
              const err = new Error(
                `Organization ${params.organizationId ?? params.slug} not found`,
              );
              // Match Clerk API 404 behavior so isNotFound() recognizes the error
              (err as { name: string }).name = "NotFoundError";
              (err as unknown as { statusCode: number }).statusCode = 404;
              (err as unknown as { code: string }).code = "NOT_FOUND";
              return Promise.reject(err);
            }
            // Apply slug overrides
            const slug = orgSlugOverrides.get(org.id) ?? org.slug;
            return Promise.resolve({
              id: org.id,
              slug,
              name: org.name,
              publicMetadata: {},
              createdAt: Date.now(),
            });
          },
        ),
      updateOrganization: vi
        .fn()
        .mockImplementation((orgId: string, data: { slug?: string }) => {
          if (data.slug) {
            orgSlugOverrides.set(orgId, data.slug);
          }
          return Promise.resolve({});
        }),
      updateOrganizationMetadata: vi.fn().mockResolvedValue({}),
      updateOrganizationMembershipMetadata: vi.fn().mockResolvedValue({}),
      getOrganizationInvitationList: vi.fn().mockResolvedValue({ data: [] }),
      createOrganizationInvitation: vi.fn().mockResolvedValue({}),
      revokeOrganizationInvitation: vi.fn().mockResolvedValue({}),
      getOrganizationDomainList: vi.fn().mockResolvedValue({ data: [] }),
      createOrganizationDomain: vi.fn().mockResolvedValue({}),
      deleteOrganizationDomain: vi.fn().mockResolvedValue({}),
      updateOrganizationDomain: vi.fn().mockResolvedValue({}),
    },
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);
}

/**
 * Clear all Clerk mock calls and reset to default state.
 * Returns the list of userIds that were configured via mockClerk() since
 * the last clear, so callers can scope DB cleanup (e.g. user_cache).
 */
export function clearClerkMock(): string[] {
  const userIds = [...mockUserIds];
  mockAuth.mockClear();
  mockClerkClient.mockClear();
  createdOrgs = [];
  orgSlugOverrides = new Map();
  mockUserIds = [];
  return userIds;
}
