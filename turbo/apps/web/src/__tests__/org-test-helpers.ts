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
  email?: string;
  memberships?: Array<{
    userId: string;
    role: string;
    createdAt?: number;
  }>;
}): void {
  const orgId = options.orgId ?? `org_${options.userId}`;
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
    getOrganizationMembershipList: vi.fn().mockResolvedValue({
      data: memberships.map((m) => ({
        publicUserData: { userId: m.userId },
        role: m.role,
        createdAt: m.createdAt ?? Date.now(),
      })),
    }),
    createOrganizationInvitation: vi.fn().mockResolvedValue({
      id: "inv_test",
    }),
    deleteOrganizationMembership: vi.fn().mockResolvedValue({}),
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
    getOrganizationMembershipList: vi.fn().mockResolvedValue({
      data: memberships.map((m) => ({
        organization: { id: orgId },
        role: m.role,
        publicUserData: { userId: m.userId },
      })),
    }),
  };

  mockClerkClient.mockResolvedValue({
    organizations: mockOrganizations,
    users: mockUsers,
  } as unknown as Awaited<ReturnType<typeof clerkClient>>);
}
