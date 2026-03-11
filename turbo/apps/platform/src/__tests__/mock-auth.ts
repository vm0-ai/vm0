import { vi } from "vitest";

interface MockedUser {
  id: string;
  fullName: string;
  organizationMemberships: { id: string }[];
  getOrganizationInvitations: (params?: {
    status?: string;
  }) => Promise<{ data: { id: string }[]; total_count: number }>;
}

let internalMockedUser: MockedUser | null = null;
let internalMockedSession: { token: string } | null = null;
let internalMockedOrganization: { id: string; name: string } | null = null;
let internalMockedInvitations: { id: string }[] = [];
let internalMockedMemberships: { id: string }[] = [{ id: "org_default" }];

export function mockUser(
  user: { id: string; fullName: string } | null,
  session: { token: string } | null,
) {
  if (user) {
    internalMockedUser = {
      ...user,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationInvitations: () =>
        Promise.resolve({
          data: internalMockedInvitations,
          total_count: internalMockedInvitations.length,
        }),
    };
  } else {
    internalMockedUser = null;
  }
  internalMockedSession = session;
}

/**
 * Configure organization-related mock state for testing org selection.
 */
export function mockOrganization(options: {
  activeOrg?: { id: string; name: string } | null;
  memberships?: { id: string }[];
  pendingInvitations?: { id: string }[];
}) {
  internalMockedOrganization = options.activeOrg ?? null;
  if (options.memberships) {
    internalMockedMemberships = options.memberships;
  }
  internalMockedInvitations = options.pendingInvitations ?? [];
}

export function clearMockedAuth() {
  internalMockedUser = null;
  internalMockedSession = null;
  internalMockedOrganization = null;
  internalMockedInvitations = [];
  internalMockedMemberships = [{ id: "org_default" }];
  clerkListeners.length = 0;
}

const clerkListeners: (() => void)[] = [];

export const mockedClerk = {
  get user() {
    return internalMockedUser;
  },
  get organization() {
    return internalMockedOrganization;
  },
  get session() {
    return {
      getToken: () => Promise.resolve(internalMockedSession?.token ?? ""),
    };
  },
  load: () => Promise.resolve(),
  addListener: (cb: () => void) => {
    clerkListeners.push(cb);
    return () => {
      const idx = clerkListeners.indexOf(cb);
      if (idx !== -1) {
        clerkListeners.splice(idx, 1);
      }
    };
  },
  redirectToSignIn: vi.fn(),
};

/** Fire all registered Clerk listeners (simulates token refresh / auth change). */
export function fireClerkListeners() {
  for (const cb of clerkListeners) {
    cb();
  }
}
