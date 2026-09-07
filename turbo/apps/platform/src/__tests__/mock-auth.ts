import type {
  BrowserClerk,
  CreateOrganizationParams,
} from "@clerk/react/types";
import { vi } from "vitest";
import { replaceState } from "../signals/location.ts";

type GetTokenImpl = (options?: {
  skipCache?: boolean;
}) => Promise<string | null>;

type SessionTouchImpl = (options?: { intent?: "focus" }) => Promise<void>;

interface MockedClerkSession {
  readonly id: string;
  readonly lastActiveOrganizationId: string | null;
  readonly getToken: GetTokenImpl;
  readonly touch: SessionTouchImpl;
}

interface MockedClerkResources {
  readonly session: MockedClerkSession | null | undefined;
}

type MockedClerkListener = (resources: MockedClerkResources) => void;

interface MockedClerkListenerOptions {
  readonly skipInitialEmit?: boolean;
}

interface MockedInvitation {
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

interface MockedClientSession {
  currentTask?: { readonly key: string };
  id: string;
  status?: string;
  user?: {
    fullName?: string | null;
    imageUrl?: string;
    organizationMemberships?: MockedMembership[];
    primaryEmailAddress?: { emailAddress: string } | null;
  };
}

type MockedSignInFactor =
  | { readonly strategy: "password" }
  | {
      readonly emailAddressId: string;
      readonly safeIdentifier: string;
      readonly strategy: "email_code" | "reset_password_email_code";
    }
  | { readonly strategy: "oauth_apple" | "oauth_google" | "passkey" }
  | {
      readonly phoneNumberId: string;
      readonly safeIdentifier: string;
      readonly strategy: "phone_code";
    }
  | { readonly strategy: string };

interface MockedSignInResourceState {
  readonly createdSessionId?: string | null;
  readonly identifier?: string | null;
  readonly secondFactorVerificationStatus?: string | null;
  readonly secondFactorVerificationStrategy?: string | null;
  readonly status: string | null;
  readonly supportedFirstFactors?: readonly MockedSignInFactor[] | null;
  readonly supportedSecondFactors?: readonly MockedSignInFactor[] | null;
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
  createOrganizationsLimit: number | null;
  organizationMemberships: MockedMembership[];
  getOrganizationMemberships: (params: {
    initialPage: number;
    pageSize: number;
  }) => Promise<{ data: MockedMembership[]; total_count: number }>;
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
let internalMockedClerkSessionSignedOut = false;
let internalMockedSignInResourceState: Required<MockedSignInResourceState> = {
  createdSessionId: null,
  identifier: null,
  secondFactorVerificationStatus: null,
  secondFactorVerificationStrategy: null,
  status: "needs_identifier",
  supportedFirstFactors: null,
  supportedSecondFactors: null,
};
function mockSignInResource(state: MockedSignInResourceState): void {
  internalMockedSignInResourceState = {
    createdSessionId: state.createdSessionId ?? null,
    identifier: state.identifier ?? null,
    secondFactorVerificationStatus:
      state.secondFactorVerificationStatus ?? null,
    secondFactorVerificationStrategy:
      state.secondFactorVerificationStrategy ?? null,
    status: state.status,
    supportedFirstFactors: state.supportedFirstFactors ?? null,
    supportedSecondFactors: state.supportedSecondFactors ?? null,
  };
}

export function mockClerkLoaded(loaded: boolean): void {
  internalMockedClerkLoaded = loaded;
}

export function mockClerkSessionTransitioning(transitioning: boolean): void {
  internalMockedClerkSessionTransitioning = transitioning;
  emitMockedClerkEvent();
}

export function mockClerkSessionSignedOut(signedOut: boolean): void {
  internalMockedClerkSessionSignedOut = signedOut;
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
    createOrganizationsLimit?: number | null;
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
      createOrganizationsLimit: user.createOrganizationsLimit ?? null,
      get organizationMemberships() {
        return internalMockedMemberships;
      },
      getOrganizationMemberships: ({ initialPage, pageSize }) => {
        return Promise.resolve({
          data: internalMockedMemberships.slice(
            (initialPage - 1) * pageSize,
            initialPage * pageSize,
          ),
          total_count: internalMockedMemberships.length,
        });
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
          get organizationMemberships() {
            return internalMockedMemberships;
          },
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

function clearMockedAuth() {
  internalMockedUser = null;
  internalMockedSession = null;
  internalMockedOrganization = null;
  internalMockedInvitations = [];
  internalMockedMemberships = [{ id: "org_default" }];
  internalMockedClientSessions = [];
  internalMockedClerkLoadOptions = {};
  internalMockedClerkLoaded = true;
  internalMockedClerkSessionTransitioning = false;
  internalMockedClerkSessionSignedOut = false;
  mockSignInResource({ status: "needs_identifier" });
  clerkListeners.length = 0;
  mockedClerk.on = defaultClerkStatusOn;
  mockedClerk.signOut.mockReset();
  mockedClerk.openSignIn.mockReset();
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
  mockedClerk.clientSignInCreate.mockImplementation(
    defaultClientSignInCreateImpl,
  );
  mockedClerk.signInPrepareFirstFactor.mockReset();
  mockedClerk.signInPrepareFirstFactor.mockImplementation(
    defaultSignInResourceOperationImpl,
  );
  mockedClerk.signInAttemptFirstFactor.mockReset();
  mockedClerk.signInAttemptFirstFactor.mockImplementation(
    defaultSignInResourceOperationImpl,
  );
  mockedClerk.buildUrlWithAuth.mockReset();
  mockedClerk.buildUrlWithAuth.mockImplementation(defaultBuildUrlWithAuthImpl);
  mockedClerk.buildUserProfileUrl.mockReset();
  mockedClerk.buildUserProfileUrl.mockImplementation(
    defaultBuildUserProfileUrlImpl,
  );
  mockedClerk.buildSignInUrl.mockReset();
  mockedClerk.buildSignInUrl.mockImplementation(defaultBuildSignInUrlImpl);
  mockedClerk.buildSignUpUrl.mockReset();
  mockedClerk.buildSignUpUrl.mockImplementation(defaultBuildSignUpUrlImpl);
  mockedClerk.navigate.mockReset();
  mockedClerk.navigate.mockImplementation(defaultNavigateImpl);
  mockedClerk.redirectToSignIn.mockReset();
  mockedClerk.redirectToSignIn.mockImplementation(defaultRedirectToSignInImpl);
  mockedClerk.redirectToSignUp.mockReset();
  mockedClerk.redirectToSignUp.mockImplementation(defaultRedirectToSignUpImpl);
  mockedClerk.initialize.mockReset();
}

export function clearMockedAuthOnAbort(signal: AbortSignal): void {
  signal.addEventListener("abort", clearMockedAuth, { once: true });
}

const clerkListeners: MockedClerkListener[] = [];
const defaultClerkStatusOn: BrowserClerk["on"] = (
  event,
  handler,
  options,
): void => {
  if (event === "status" && options?.notify) {
    handler(internalMockedClerkLoaded ? "ready" : "loading");
  }
};

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
interface MockedSignInCreateParams {
  readonly identifier?: string;
  readonly signUpIfMissing?: boolean;
  readonly strategy?: string;
  readonly ticket?: string;
  readonly token?: string;
  readonly transfer?: boolean;
}

function defaultClientSignInCreateImpl(params: MockedSignInCreateParams) {
  if (params.strategy === "ticket") {
    return Promise.resolve({
      status: "complete",
      createdSessionId: "test-created-session-id",
    });
  }
  return Promise.resolve(mockedClientSignIn);
}

const clientSignInCreate = vi.fn<typeof defaultClientSignInCreateImpl>(
  defaultClientSignInCreateImpl,
);

function defaultSignInResourceOperationImpl(_params?: unknown) {
  return Promise.resolve(mockedClientSignIn);
}

const signInPrepareFirstFactor = vi.fn<
  typeof defaultSignInResourceOperationImpl
>(defaultSignInResourceOperationImpl);
const signInAttemptFirstFactor = vi.fn<
  typeof defaultSignInResourceOperationImpl
>(defaultSignInResourceOperationImpl);
const mockedClientSignIn = {
  get identifier() {
    return internalMockedSignInResourceState.identifier;
  },
  get status() {
    return internalMockedSignInResourceState.status;
  },
  get supportedFirstFactors() {
    return internalMockedSignInResourceState.supportedFirstFactors;
  },
  get supportedSecondFactors() {
    return internalMockedSignInResourceState.supportedSecondFactors;
  },
  get secondFactorVerification() {
    const status =
      internalMockedSignInResourceState.secondFactorVerificationStatus;
    const strategy =
      internalMockedSignInResourceState.secondFactorVerificationStrategy;
    return status || strategy ? { status, strategy } : undefined;
  },
  get createdSessionId() {
    return internalMockedSignInResourceState.createdSessionId;
  },
  create: clientSignInCreate,
  prepareFirstFactor: signInPrepareFirstFactor,
  attemptFirstFactor: signInAttemptFirstFactor,
};

const defaultBuildUrlWithAuthImpl = (to: string) => {
  return to;
};

const defaultBuildUserProfileUrlImpl = () => {
  return "https://accounts.example.test/user";
};

export interface MockedClerkLoadOptions {
  afterSignOutUrl?: string;
  isSatellite?: boolean;
  satelliteAutoSync?: boolean;
  signInUrl?: string;
  signUpUrl?: string;
  touchSession?: boolean;
  /** Hosted UI handle; the resource mock records the UI script request. */
  ui?: unknown;
}

interface MockedSignInRedirectOptions {
  redirectUrl?: string | null;
}

function defaultBuildAuthUrl(
  configuredUrl: string | undefined,
  fallbackPath: "/sign-in" | "/sign-up",
  options?: MockedSignInRedirectOptions,
): string {
  if (!internalMockedClerkLoaded) {
    return "";
  }

  const authUrl = new URL(
    configuredUrl ?? fallbackPath,
    window.location.origin,
  );
  const redirectUrl = new URL(
    options?.redirectUrl ?? window.location.href,
    window.location.origin,
  );
  if (internalMockedClerkLoadOptions.isSatellite) {
    redirectUrl.searchParams.set("__clerk_synced", "false");
  }
  // Clerk serializes redirect options into the auth route's fragment.
  const authHashParams = new URLSearchParams();
  authHashParams.set("redirect_url", redirectUrl.toString());
  authUrl.hash = `/?${authHashParams.toString()}`;
  return authUrl.toString();
}

const defaultBuildSignInUrlImpl = (
  options?: MockedSignInRedirectOptions,
): string => {
  return defaultBuildAuthUrl(
    internalMockedClerkLoadOptions.signInUrl,
    "/sign-in",
    options,
  );
};

const defaultBuildSignUpUrlImpl = (
  options?: MockedSignInRedirectOptions,
): string => {
  return defaultBuildAuthUrl(
    internalMockedClerkLoadOptions.signUpUrl,
    "/sign-up",
    options,
  );
};

const defaultNavigateImpl: BrowserClerk["navigate"] = (to) => {
  replaceState(null, "", to);
  return Promise.resolve();
};

const defaultRedirectToSignInImpl: BrowserClerk["redirectToSignIn"] = async (
  options,
): Promise<void> => {
  await defaultNavigateImpl(defaultBuildSignInUrlImpl(options));
};

const defaultRedirectToSignUpImpl: BrowserClerk["redirectToSignUp"] = async (
  options,
): Promise<void> => {
  await defaultNavigateImpl(defaultBuildSignUpUrlImpl(options));
};

const defaultLoadImpl = (options?: MockedClerkLoadOptions) => {
  internalMockedClerkLoadOptions = options ?? {};
  return Promise.resolve();
};
export const mockedClerkLoad = vi.fn<typeof defaultLoadImpl>(defaultLoadImpl);

interface MockedSetActiveParams {
  organization?: string | null;
  redirectUrl?: string;
  session?: string | null;
  navigate?: (params: {
    session: {
      readonly id: string;
      readonly status: string;
      currentTask?: {
        key: string;
      };
      readonly user: {
        readonly organizationMemberships: MockedMembership[];
      } | null;
    };
    decorateUrl: (url: string) => string;
  }) => void | Promise<unknown>;
}

async function defaultSetActiveImpl(
  params: MockedSetActiveParams,
): Promise<void> {
  let navigatedTo: string | null = params.redirectUrl ?? null;
  const selectedSession = internalMockedClientSessions.find((session) => {
    return session.id === params.session;
  });
  const activeSession = internalMockedClientSessions.find((session) => {
    return session.status === "pending" || session.status === "active";
  });
  const sourceSession = selectedSession ?? activeSession;
  const session = {
    id: sourceSession?.id ?? params.session ?? "test-session-id",
    ...(!params.organization && sourceSession?.currentTask
      ? { currentTask: sourceSession.currentTask }
      : {}),
    status: params.organization
      ? "active"
      : (sourceSession?.status ?? "active"),
    user: {
      organizationMemberships:
        sourceSession?.user?.organizationMemberships ??
        internalMockedUser?.organizationMemberships ??
        [],
    },
  };
  await params.navigate?.({
    session,
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

type MockedCreateOrganization = (
  params: CreateOrganizationParams,
) => Promise<{ readonly id: string }>;

export const mockedClerk = {
  initialize,
  get loaded() {
    return internalMockedClerkLoaded;
  },
  get status() {
    return internalMockedClerkLoaded ? "ready" : "loading";
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
    if (internalMockedClerkSessionSignedOut) {
      return null;
    }
    if (!internalMockedSession) {
      return null;
    }
    const recoverableSession = internalMockedClientSessions.find((session) => {
      return session.status === "pending";
    });
    if (recoverableSession) {
      return {
        ...recoverableSession,
        get lastActiveOrganizationId() {
          return internalMockedOrganization?.id ?? null;
        },
        getToken: sessionGetToken,
        touch: sessionTouch,
      };
    }
    return {
      id: "test-session-id",
      get lastActiveOrganizationId() {
        return internalMockedOrganization?.id ?? null;
      },
      getToken: sessionGetToken,
      touch: sessionTouch,
    };
  },
  sessionGetToken,
  sessionTouch,
  clientSignInCreate,
  signInPrepareFirstFactor,
  signInAttemptFirstFactor,
  client: {
    get sessions() {
      return internalMockedClientSessions;
    },
    get signedInSessions() {
      return internalMockedClientSessions.filter((session) => {
        return (
          (session.status === "active" || session.status === "pending") &&
          session.user !== undefined
        );
      });
    },
    signIn: mockedClientSignIn,
  },
  signOut: vi.fn<BrowserClerk["signOut"]>(() => {
    return Promise.resolve();
  }),
  openSignIn: vi.fn<BrowserClerk["openSignIn"]>(),
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
  navigate: vi.fn<BrowserClerk["navigate"]>(defaultNavigateImpl),
  redirectToSignIn: vi.fn<BrowserClerk["redirectToSignIn"]>(
    defaultRedirectToSignInImpl,
  ),
  redirectToSignUp: vi.fn<BrowserClerk["redirectToSignUp"]>(
    defaultRedirectToSignUpImpl,
  ),
  buildSignInUrl: vi.fn<typeof defaultBuildSignInUrlImpl>(
    defaultBuildSignInUrlImpl,
  ),
  buildSignUpUrl: vi.fn<typeof defaultBuildSignUpUrlImpl>(
    defaultBuildSignUpUrlImpl,
  ),
  // Production-instance behavior: the URL passes through unchanged. Dev
  // instances append the __clerk_db_jwt session handoff parameter.
  buildUrlWithAuth: vi.fn<typeof defaultBuildUrlWithAuthImpl>(
    defaultBuildUrlWithAuthImpl,
  ),
  buildUserProfileUrl: vi.fn<typeof defaultBuildUserProfileUrlImpl>(
    defaultBuildUserProfileUrlImpl,
  ),
  setActive: vi.fn<typeof defaultSetActiveImpl>(defaultSetActiveImpl),
  createOrganization: vi.fn<MockedCreateOrganization>(() => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};
