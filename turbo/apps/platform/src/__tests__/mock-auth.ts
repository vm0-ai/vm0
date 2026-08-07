import { vi } from "vitest";
import { replaceState } from "../signals/location.ts";

type GetTokenImpl = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

type SessionTouchImpl = (options?: { intent?: "focus" }) => Promise<void>;

interface MockedClerkSession {
  readonly id: string;
  readonly getToken: GetTokenImpl;
  readonly touch: SessionTouchImpl;
}

interface MockedClerkResources {
  readonly session: MockedClerkSession | undefined;
}

type MockedClerkListener = (resources: MockedClerkResources) => void;

interface MockedClerkListenerOptions {
  readonly skipInitialEmit?: boolean;
}

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
let internalMockedClerkLoadOptions: MockedClerkLoadOptions = {};
let internalMockedClerkLoaded = true;
let internalMockedClerkSessionTransitioning = false;

export function mockClerkLoaded(loaded: boolean): void {
  internalMockedClerkLoaded = loaded;
}

export function mockClerkSessionTransitioning(transitioning: boolean): void {
  internalMockedClerkSessionTransitioning = transitioning;
  emitMockedClerkEvent();
}

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
  internalMockedClerkLoadOptions = {};
  internalMockedClerkLoaded = true;
  internalMockedClerkSessionTransitioning = false;
  clerkListeners.length = 0;
  mockedClerk.on = defaultClerkStatusOn;
  mockedClerk.signOut.mockReset();
  mockedClerk.openSignIn.mockReset();
  mockedClerk.openUserProfile.mockReset();
  mockedClerk.closeUserProfile.mockReset();
  mockedClerk.setActive.mockReset();
  mockedClerk.setActive.mockImplementation(defaultSetActiveImpl);
  mockedClerk.createOrganization.mockReset();
  mockedClerk.sessionGetToken.mockReset();
  mockedClerk.sessionGetToken.mockImplementation(defaultGetTokenImpl);
  mockedClerk.sessionTouch.mockReset();
  mockedClerk.sessionTouch.mockImplementation(defaultSessionTouchImpl);
  mockedClerk.load = mockedClerkLoad;
  mockedClerkLoad.mockReset();
  mockedClerkLoad.mockImplementation(defaultLoadImpl);
  mockedClerk.clientSignInCreate.mockReset();
  mockedClerk.clientSignInCreate.mockResolvedValue({
    status: "complete",
    createdSessionId: "test-created-session-id",
  });
  mockedClerk.buildUrlWithAuth.mockReset();
  mockedClerk.buildUrlWithAuth.mockImplementation(defaultBuildUrlWithAuthImpl);
  mockedClerk.buildUserProfileUrl.mockReset();
  mockedClerk.buildUserProfileUrl.mockImplementation(
    defaultBuildUserProfileUrlImpl,
  );
  mockedClerk.buildSignInUrl.mockReset();
  mockedClerk.buildSignInUrl.mockImplementation(defaultBuildSignInUrlImpl);
  mockedClerk.initialize.mockReset();
}

const clerkListeners: MockedClerkListener[] = [];
function defaultClerkStatusOn(): void {}

export function emitMockedClerkEvent(): void {
  const resources = { session: mockedClerk.session };
  for (const listener of clerkListeners.slice()) {
    listener(resources);
  }
}

const defaultGetTokenImpl: GetTokenImpl = () => {
  return Promise.resolve(internalMockedSession?.token ?? "");
};

const sessionGetToken = vi.fn<GetTokenImpl>(defaultGetTokenImpl);
const defaultSessionTouchImpl: SessionTouchImpl = () => {
  return Promise.resolve();
};
const sessionTouch = vi.fn<SessionTouchImpl>(defaultSessionTouchImpl);
const clientSignInCreate = vi.fn(
  (_params: { strategy: "ticket"; ticket: string }) => {
    return Promise.resolve({
      status: "complete",
      createdSessionId: "test-created-session-id",
    });
  },
);
const defaultBuildUrlWithAuthImpl = (to: string) => {
  return to;
};

const defaultBuildUserProfileUrlImpl = () => {
  return "https://accounts.example.test/user";
};

interface MockedClerkLoadOptions {
  isSatellite?: boolean;
  signInUrl?: string;
}

interface MockedSignInRedirectOptions {
  redirectUrl?: string | null;
}

const defaultBuildSignInUrlImpl = (
  options?: MockedSignInRedirectOptions,
): string => {
  if (!internalMockedClerkLoaded) {
    return "";
  }

  const signInUrl = new URL(
    internalMockedClerkLoadOptions.signInUrl ?? "/sign-in",
    window.location.origin,
  );
  const redirectUrl = new URL(
    options?.redirectUrl ?? window.location.href,
    window.location.origin,
  );
  if (internalMockedClerkLoadOptions.isSatellite) {
    redirectUrl.searchParams.set("__clerk_synced", "false");
  }
  signInUrl.searchParams.set("redirect_url", redirectUrl.toString());
  return signInUrl.toString();
};

const defaultLoadImpl = (options?: MockedClerkLoadOptions) => {
  internalMockedClerkLoadOptions = options ?? {};
  return Promise.resolve();
};
export const mockedClerkLoad = vi.fn<typeof defaultLoadImpl>(defaultLoadImpl);

interface MockedSetActiveParams {
  organization?: string | null;
  session?: string | null;
  navigate?: (params: {
    session: {
      currentTask?: {
        key: "choose-organization" | "reset-password" | "setup-mfa";
      };
    };
    decorateUrl: (url: string) => string;
  }) => void | Promise<unknown>;
}

async function defaultSetActiveImpl(
  params: MockedSetActiveParams,
): Promise<void> {
  let navigatedTo: string | null = null;
  await params.navigate?.({
    session: {},
    decorateUrl: (url) => {
      navigatedTo = defaultBuildUrlWithAuthImpl(url);
      return navigatedTo;
    },
  });
  if (navigatedTo) {
    replaceState(null, "", navigatedTo);
  }
}

const initialize =
  vi.fn<
    (publishableKey: string, options?: { readonly domain?: string }) => void
  >();

interface MockedUserProfileOptions {
  apiKeysProps?: { hide?: boolean };
  getContainer?: () => HTMLElement | null;
}

export const mockedClerk = {
  initialize,
  get loaded() {
    return internalMockedClerkLoaded;
  },
  get user() {
    return internalMockedUser;
  },
  get organization() {
    return internalMockedOrganization;
  },
  get session() {
    if (internalMockedClerkSessionTransitioning) {
      return undefined;
    }
    return {
      id: "test-session-id",
      getToken: sessionGetToken,
      touch: sessionTouch,
    };
  },
  sessionGetToken,
  sessionTouch,
  clientSignInCreate,
  client: {
    get sessions() {
      return internalMockedClientSessions;
    },
    signIn: {
      create: clientSignInCreate,
    },
  },
  signOut: vi.fn(() => {
    return Promise.resolve();
  }),
  openSignIn: vi.fn(() => {
    return Promise.resolve();
  }),
  openUserProfile: vi.fn<(options?: MockedUserProfileOptions) => void>(),
  closeUserProfile: vi.fn<() => void>(),
  load: mockedClerkLoad,
  on: defaultClerkStatusOn,
  addListener: (
    cb: MockedClerkListener,
    _options?: MockedClerkListenerOptions,
  ) => {
    clerkListeners.push(cb);
    return () => {
      const idx = clerkListeners.indexOf(cb);
      if (idx !== -1) {
        clerkListeners.splice(idx, 1);
      }
    };
  },
  redirectToSignIn: vi.fn(),
  buildSignInUrl: vi.fn<typeof defaultBuildSignInUrlImpl>(
    defaultBuildSignInUrlImpl,
  ),
  // Production-instance behavior: the URL passes through unchanged. Dev
  // instances append the __clerk_db_jwt session handoff parameter.
  buildUrlWithAuth: vi.fn(defaultBuildUrlWithAuthImpl),
  buildUserProfileUrl: vi.fn<typeof defaultBuildUserProfileUrlImpl>(
    defaultBuildUserProfileUrlImpl,
  ),
  setActive: vi.fn(defaultSetActiveImpl),
  createOrganization: vi.fn((_params: { name: string; slug: string }) => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};
