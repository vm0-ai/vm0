import { vi } from "vitest";
import { clerkClient } from "@clerk/nextjs/server";
import { mockClerk } from "./clerk-mock";

const mockClerkClient = vi.mocked(clerkClient);

/**
 * Set up an extended Clerk mock that supports organization operations.
 *
 * Configures the Clerk mock to support createOrganization,
 * getOrganizationMembershipList, createOrganizationInvitation,
 * deleteOrganizationMembership, getUser, and getUserList.
 */
export function setupClerkOrgMock(options: {
  userId: string;
  orgId?: string;
  orgSlug?: string;
  email?: string;
  memberships?: Array<{
    userId: string;
    role: string;
    createdAt?: number;
  }>;
}): void {
  const orgId = options.orgId ?? `org_${options.userId}`;
  const orgSlug = options.orgSlug ?? `org-${options.userId}`;
  const email = options.email;
  const memberships = options.memberships ?? [
    { userId: options.userId, role: "org:admin", createdAt: Date.now() },
  ];

  mockClerk({ userId: options.userId, email });

  const mockOrganizations = {
    createOrganization: vi.fn().mockResolvedValue({
      id: orgId,
      name: "test-org",
    }),
    getOrganization: vi
      .fn()
      .mockImplementation(
        (params: { organizationId?: string; slug?: string }) => {
          if (params.organizationId === orgId || params.slug === orgSlug) {
            return Promise.resolve({
              id: orgId,
              slug: orgSlug,
              name: orgSlug,
              createdAt: Date.now(),
              publicMetadata: {},
            });
          }
          return Promise.reject(
            new Error(
              `Organization ${params.organizationId ?? params.slug} not found`,
            ),
          );
        },
      ),
    getOrganizationMembershipList: vi.fn().mockResolvedValue({
      data: memberships.map((m) => ({
        publicUserData: { userId: m.userId },
        role: m.role,
        createdAt: m.createdAt ?? Date.now(),
      })),
    }),
    getOrganizationInvitationList: vi.fn().mockResolvedValue({
      data: [],
    }),
    createOrganizationInvitation: vi.fn().mockResolvedValue({
      id: "inv_test",
    }),
    deleteOrganizationMembership: vi.fn().mockResolvedValue({}),
    updateOrganizationMetadata: vi.fn().mockResolvedValue({}),
    updateOrganizationMembershipMetadata: vi.fn().mockResolvedValue({}),
  };

  const mockUsers = {
    getUser: vi.fn().mockImplementation((userId: string) =>
      Promise.resolve({
        id: userId,
        emailAddresses: [
          {
            id: "email_1",
            emailAddress: email ?? `${userId}@example.com`,
          },
        ],
        primaryEmailAddressId: "email_1",
      }),
    ),
    getUserList: vi
      .fn()
      .mockImplementation(
        (params: { emailAddress?: string[]; userId?: string[] }) =>
          Promise.resolve({
            data: params.emailAddress
              ? params.emailAddress.map((email) => ({
                  id: `user_${email.split("@")[0]}`,
                  emailAddresses: [{ id: "email_1", emailAddress: email }],
                  primaryEmailAddressId: "email_1",
                }))
              : (params.userId ?? []).map((uid) => ({
                  id: uid,
                  emailAddresses: [
                    { id: "email_1", emailAddress: `${uid}@example.com` },
                  ],
                  primaryEmailAddressId: "email_1",
                })),
          }),
      ),
    getOrganizationMembershipList: vi
      .fn()
      .mockImplementation((params: { userId: string }) => {
        const userMemberships = memberships.filter(
          (m) => m.userId === params.userId,
        );
        return Promise.resolve({
          data: userMemberships.map((m) => ({
            organization: { id: orgId, slug: orgSlug, name: orgSlug },
            role: m.role,
            publicUserData: { userId: m.userId },
          })),
        });
      }),
  };

  mockClerkClient.mockResolvedValue({
    organizations: mockOrganizations,
    users: mockUsers,
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);
}
