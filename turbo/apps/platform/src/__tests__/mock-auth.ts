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

export interface MockedMembership {
  id: string;
  role?: string;
  organization?: {
    id: string;
    name: string;
    imageUrl?: string | null;
  };
}

interface MockedUser {
  id: string;
  fullName: string;
  firstName?: string;
  primaryEmailAddress: { emailAddress: string } | null;
  unsafeMetadata: Record<string, unknown>;
  createOrganizationEnabled: boolean;
  organizationMemberships: MockedMembership[];
  getOrganizationInvitations: (params?: {
    status?: string;
  }) => Promise<{ data: MockedInvitation[]; total_count: number }>;
  update: (params: {
    unsafeMetadata: Record<string, unknown>;
  }) => Promise<void>;
}

let internalMockedUser: MockedUser | null = null;
let internalMockedSession: { token: string } | null = null;
let internalMockedOrganization: {
  id: string;
  name: string;
  slug?: string;
  imageUrl?: string;
  hasImage?: boolean;
  reload: () => Promise<void>;
} | null = null;
let internalMockedInvitations: MockedInvitation[] = [];
let internalMockedMemberships: MockedMembership[] = [{ id: "org_default" }];

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
      unsafeMetadata: {},
      createOrganizationEnabled: false,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationInvitations: () => {
        return Promise.resolve({
          data: internalMockedInvitations,
          total_count: internalMockedInvitations.length,
        });
      },
      update: (params: { unsafeMetadata: Record<string, unknown> }) => {
        if (internalMockedUser) {
          internalMockedUser.unsafeMetadata = params.unsafeMetadata;
        }
        return Promise.resolve();
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
  activeOrg?: {
    id: string;
    name: string;
    slug?: string;
    imageUrl?: string;
    hasImage?: boolean;
  } | null;
  memberships?: MockedMembership[];
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
  mockedClerk.setActive.mockReset();
  mockedClerk.createOrganization.mockReset();
  mockedClerk.sessionGetToken.mockReset();
  mockedClerk.sessionGetToken.mockImplementation(defaultGetTokenImpl);
}

const clerkListeners: (() => void)[] = [];

type GetTokenImpl = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

const defaultGetTokenImpl: GetTokenImpl = () => {
  return Promise.resolve(internalMockedSession?.token ?? "");
};

const sessionGetToken = vi.fn<GetTokenImpl>(defaultGetTokenImpl);

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
      getToken: sessionGetToken,
    };
  },
  sessionGetToken,
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
  setActive: vi.fn((_params: { organization: string }) => {
    return Promise.resolve();
  }),
  createOrganization: vi.fn((_params: { name: string; slug: string }) => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};

/** Fire all registered Clerk listeners (simulates token refresh / auth change). */
export function fireClerkListeners() {
  for (const cb of clerkListeners) {
    cb();
  }
}
