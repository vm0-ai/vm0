import { vi } from "vitest";

export interface MockedInvitation {
  id: string;
  accept?: () => Promise<unknown>;
  publicOrganizationData?: {
    id: string;
    name: string;
    imageUrl: string;
  };
}

interface MockedUser {
  id: string;
  fullName: string;
  firstName?: string;
  primaryEmailAddress: { emailAddress: string } | null;
  organizationMemberships: { id: string }[];
  getOrganizationInvitations: (params?: {
    status?: string;
  }) => Promise<{ data: MockedInvitation[]; total_count: number }>;
}

let internalMockedUser: MockedUser | null = null;
let internalMockedSession: { token: string } | null = null;
let internalMockedOrganization: {
  id: string;
  name: string;
  reload: () => Promise<void>;
} | null = null;
let internalMockedInvitations: MockedInvitation[] = [];
let internalMockedMemberships: { id: string }[] = [{ id: "org_default" }];

export function mockUser(
  user: {
    id: string;
    fullName: string;
    email?: string;
    firstName?: string;
  } | null,
  session: { token: string } | null,
) {
  if (user) {
    internalMockedUser = {
      ...user,
      primaryEmailAddress: user.email ? { emailAddress: user.email } : null,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationInvitations: () => {
        return Promise.resolve({
          data: internalMockedInvitations,
          total_count: internalMockedInvitations.length,
        });
      },
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
  pendingInvitations?: MockedInvitation[];
}) {
  internalMockedOrganization = options.activeOrg
    ? {
        ...options.activeOrg,
        reload: () => {
          return Promise.resolve();
        },
      }
    : null;
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
      id: "test-session-id",
      getToken: () => {
        return Promise.resolve(internalMockedSession?.token ?? "");
      },
    };
  },
  signOut: vi.fn(() => {
    return Promise.resolve();
  }),
  openUserProfile: vi.fn(() => {
    return Promise.resolve();
  }),
  load: () => {
    return Promise.resolve();
  },
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
