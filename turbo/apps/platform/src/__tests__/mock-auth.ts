import { vi } from "vitest";

import { now } from "../lib/time.ts";

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

export interface MockedClientSession {
  id: string;
  status?: string;
  user?: {
    fullName?: string | null;
    imageUrl?: string;
    primaryEmailAddress?: { emailAddress: string } | null;
  };
}

export interface MockedEmailCodeVerification {
  expireAt: Date | null;
  nonce: string | null;
  status: "expired" | "unverified" | "verified" | null;
  strategy: string | null;
}

interface MockedUser {
  id: string;
  fullName: string;
  firstName?: string;
  imageUrl?: string;
  createdAt?: Date;
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
let internalMockedClientSessions: MockedClientSession[] = [];

export function mockUser(
  user: {
    id: string;
    fullName: string;
    email?: string;
    firstName?: string;
    imageUrl?: string;
    createdAt?: Date;
    createOrganizationEnabled?: boolean;
    clientSessions?: MockedClientSession[];
  } | null,
  session: { token: string } | null,
) {
  if (user) {
    internalMockedUser = {
      ...user,
      imageUrl: user.imageUrl,
      primaryEmailAddress: user.email ? { emailAddress: user.email } : null,
      unsafeMetadata: {},
      createOrganizationEnabled: user.createOrganizationEnabled ?? false,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationInvitations: () => {
        return Promise.resolve({
          data: [...internalMockedInvitations],
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
    internalMockedClientSessions = user.clientSessions ?? [
      {
        id: "test-session-id",
        status: "active",
        user: {
          fullName: user.fullName,
          imageUrl: user.imageUrl,
          primaryEmailAddress: user.email ? { emailAddress: user.email } : null,
        },
      },
    ];
  } else {
    internalMockedUser = null;
    internalMockedClientSessions = [];
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
  internalMockedClientSessions = [];
  verificationSequence = 0;
  internalMockedFactorPreparations = [];
  resetMockedClerkAuthResources();
  clerkListeners.length = 0;
  mockedClerk.signOut.mockReset();
  mockedClerk.openSignIn.mockReset();
  mockedClerk.openUserProfile.mockReset();
  mockedClerk.setActive.mockReset();
  mockedClerk.createOrganization.mockReset();
  mockedClerk.sessionGetToken.mockReset();
  mockedClerk.sessionGetToken.mockImplementation(defaultGetTokenImpl);
  mockedClerk.load.mockReset();
  mockedClerk.load.mockImplementation(defaultLoadImpl);
  mockedClerk.clientSignInCreate.mockReset();
  mockedClerk.clientSignInCreate.mockResolvedValue({
    status: "complete",
    createdSessionId: "test-created-session-id",
  });
  mockedClerk.buildUrlWithAuth.mockReset();
  mockedClerk.buildUrlWithAuth.mockImplementation(defaultBuildUrlWithAuthImpl);
}

const clerkListeners: (() => void)[] = [];

type GetTokenImpl = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

const defaultGetTokenImpl: GetTokenImpl = () => {
  return Promise.resolve(internalMockedSession?.token ?? "");
};

const sessionGetToken = vi.fn<GetTokenImpl>(defaultGetTokenImpl);
const clientSignInCreate = vi.fn(
  (_params: { strategy: "ticket"; ticket: string }) => {
    return Promise.resolve({
      status: "complete",
      createdSessionId: "test-created-session-id",
    });
  },
);

interface MockedSignUpPrepareParams {
  redirectUrl?: string;
  strategy: "email_code" | "email_link";
}

interface MockedSignInPrepareParams {
  emailAddressId?: string;
  phoneNumberId?: string;
  strategy: string;
}

type MockedSignUpPrepare = (
  params?: MockedSignUpPrepareParams,
) => Promise<MockedSignUpResource>;

type MockedSignInPrepare = (
  params: MockedSignInPrepareParams,
) => Promise<MockedSignInResource>;

interface MockedFactorPreparation {
  flow: "sign-in" | "sign-up";
  strategy: string;
}

interface MockedSignUpResource {
  prepareEmailAddressVerification: MockedSignUpPrepare;
  verifications: {
    emailAddress: MockedEmailCodeVerification;
  };
}

interface MockedSignInResource {
  create: typeof clientSignInCreate;
  firstFactorVerification: MockedEmailCodeVerification;
  prepareFirstFactor: MockedSignInPrepare;
}

let verificationSequence = 0;
let internalMockedFactorPreparations: MockedFactorPreparation[] = [];

function emptyEmailCodeVerification(): MockedEmailCodeVerification {
  return {
    expireAt: null,
    nonce: null,
    status: null,
    strategy: null,
  };
}

function preparedEmailCodeVerification(
  prefix: string,
): MockedEmailCodeVerification {
  verificationSequence += 1;
  return {
    expireAt: new Date(now() + 10 * 60 * 1000),
    nonce: `${prefix}-${verificationSequence}`,
    status: "unverified",
    strategy: "email_code",
  };
}

function createMockedSignUpResource(): MockedSignUpResource {
  const resource: MockedSignUpResource = {
    prepareEmailAddressVerification: (params) => {
      internalMockedFactorPreparations.push({
        flow: "sign-up",
        strategy: params?.strategy ?? "email_code",
      });
      resource.verifications.emailAddress =
        preparedEmailCodeVerification("sign-up");
      return Promise.resolve(resource);
    },
    verifications: {
      emailAddress: emptyEmailCodeVerification(),
    },
  };
  return resource;
}

function createMockedSignInResource(): MockedSignInResource {
  const resource: MockedSignInResource = {
    create: clientSignInCreate,
    firstFactorVerification: emptyEmailCodeVerification(),
    prepareFirstFactor: (params) => {
      internalMockedFactorPreparations.push({
        flow: "sign-in",
        strategy: params.strategy,
      });
      if (params.strategy === "email_code") {
        resource.firstFactorVerification =
          preparedEmailCodeVerification("sign-in");
      }
      return Promise.resolve(resource);
    },
  };
  return resource;
}

let internalMockedSignUpResource = createMockedSignUpResource();
let internalMockedSignInResource = createMockedSignInResource();

function resetMockedClerkAuthResources(): void {
  internalMockedSignUpResource = createMockedSignUpResource();
  internalMockedSignInResource = createMockedSignInResource();
}

export function mockSignUpEmailVerification(
  verification: MockedEmailCodeVerification,
): void {
  internalMockedSignUpResource.verifications.emailAddress = {
    ...verification,
  };
}

export function mockSignInFirstFactorVerification(
  verification: MockedEmailCodeVerification,
): void {
  internalMockedSignInResource.firstFactorVerification = {
    ...verification,
  };
}

export function replaceMockedClerkAuthResources(): void {
  resetMockedClerkAuthResources();
  for (const listener of clerkListeners) {
    listener();
  }
}
const defaultBuildUrlWithAuthImpl = (to: string) => {
  return to;
};
const defaultLoadImpl = () => {
  return Promise.resolve();
};

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
  clientSignInCreate,
  get factorPreparations() {
    return internalMockedFactorPreparations;
  },
  client: {
    get sessions() {
      return internalMockedClientSessions;
    },
    get signIn() {
      return internalMockedSignInResource;
    },
    get signUp() {
      return internalMockedSignUpResource;
    },
  },
  signOut: vi.fn(() => {
    return Promise.resolve();
  }),
  openSignIn: vi.fn(() => {
    return Promise.resolve();
  }),
  openUserProfile: vi.fn(() => {
    return Promise.resolve();
  }),
  load: vi.fn(defaultLoadImpl),
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
  // Production-instance behavior: the URL passes through unchanged. Dev
  // instances append the __clerk_db_jwt session handoff parameter.
  buildUrlWithAuth: vi.fn(defaultBuildUrlWithAuthImpl),
  setActive: vi.fn(
    (params: {
      organization?: string;
      session?: string;
      beforeEmit?: () => void;
    }) => {
      params.beforeEmit?.();
      return Promise.resolve();
    },
  ),
  createOrganization: vi.fn((_params: { name: string; slug: string }) => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};
