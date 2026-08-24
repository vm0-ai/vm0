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

export interface MockedAuthV2Capabilities {
  readonly googleOAuth?: boolean;
  readonly googleOneTapClientId?: string | null;
  readonly passkey?: boolean;
}

export type MockedSignInFactor =
  | { readonly strategy: "password" }
  | {
      readonly emailAddressId: string;
      readonly safeIdentifier: string;
      readonly strategy: "email_code" | "reset_password_email_code";
    }
  | { readonly strategy: "oauth_google" | "passkey" }
  | { readonly strategy: string };

export interface MockedSignInResourceState {
  readonly createdSessionId?: string | null;
  readonly isTransferable?: boolean;
  readonly status: string | null;
  readonly supportedFirstFactors?: readonly MockedSignInFactor[] | null;
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
let internalMockedAuthV2Capabilities: Required<MockedAuthV2Capabilities> = {
  googleOAuth: false,
  googleOneTapClientId: null,
  passkey: false,
};
let internalMockedClerkLoadOptions: MockedClerkLoadOptions = {};
let internalMockedClerkLoaded = true;
let internalMockedClerkSessionTransitioning = false;
let internalMockedClerkSessionSignedOut = false;
let internalMockedSignInResourceState: Required<MockedSignInResourceState> = {
  createdSessionId: null,
  isTransferable: false,
  status: "needs_identifier",
  supportedFirstFactors: null,
};

export function mockSignInResource(state: MockedSignInResourceState): void {
  internalMockedSignInResourceState = {
    createdSessionId: state.createdSessionId ?? null,
    isTransferable: state.isTransferable ?? false,
    status: state.status,
    supportedFirstFactors: state.supportedFirstFactors ?? null,
  };
}

export function mockAuthV2Capabilities(
  capabilities: MockedAuthV2Capabilities,
): void {
  internalMockedAuthV2Capabilities = {
    googleOAuth: capabilities.googleOAuth ?? false,
    googleOneTapClientId: capabilities.googleOneTapClientId ?? null,
    passkey: capabilities.passkey ?? false,
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

interface MockedGoogleOneTapInitializeOptions {
  readonly callback: (response: { readonly credential?: string }) => void;
  readonly client_id: string;
}

type MockedGoogleOneTapMomentCallback = (notification: {
  isDismissedMoment(): boolean;
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
}) => void;

let internalMockedGoogleOneTapCredential: string | null = null;
let internalMockedGoogleOneTapCallback:
  | MockedGoogleOneTapInitializeOptions["callback"]
  | null = null;

function defaultGoogleOneTapInitializeImpl(
  options: MockedGoogleOneTapInitializeOptions,
): void {
  internalMockedGoogleOneTapCallback = options.callback;
}

function defaultGoogleOneTapPromptImpl(
  callback: MockedGoogleOneTapMomentCallback,
): void {
  if (internalMockedGoogleOneTapCredential) {
    internalMockedGoogleOneTapCallback?.({
      credential: internalMockedGoogleOneTapCredential,
    });
    return;
  }
  callback({
    isDismissedMoment: () => false,
    isNotDisplayed: () => true,
    isSkippedMoment: () => false,
  });
}

export const mockedGoogleOneTap = {
  cancel: vi.fn<() => void>(),
  initialize: vi.fn<typeof defaultGoogleOneTapInitializeImpl>(
    defaultGoogleOneTapInitializeImpl,
  ),
  prompt: vi.fn<typeof defaultGoogleOneTapPromptImpl>(
    defaultGoogleOneTapPromptImpl,
  ),
};

export function mockGoogleOneTapCredential(credential: string | null): void {
  internalMockedGoogleOneTapCredential = credential;
  Object.defineProperty(globalThis, "google", {
    configurable: true,
    value: { accounts: { id: mockedGoogleOneTap } },
  });
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
  internalMockedAuthV2Capabilities = {
    googleOAuth: false,
    googleOneTapClientId: null,
    passkey: false,
  };
  internalMockedGoogleOneTapCredential = null;
  internalMockedGoogleOneTapCallback = null;
  Reflect.deleteProperty(globalThis, "google");
  mockedGoogleOneTap.cancel.mockReset();
  mockedGoogleOneTap.initialize.mockReset();
  mockedGoogleOneTap.initialize.mockImplementation(
    defaultGoogleOneTapInitializeImpl,
  );
  mockedGoogleOneTap.prompt.mockReset();
  mockedGoogleOneTap.prompt.mockImplementation(defaultGoogleOneTapPromptImpl);
  internalMockedClerkLoadOptions = {};
  internalMockedClerkLoaded = true;
  internalMockedClerkSessionTransitioning = false;
  internalMockedClerkSessionSignedOut = false;
  mockSignInResource({ status: "needs_identifier" });
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
  mockedClerk.signInResetPassword.mockReset();
  mockedClerk.signInResetPassword.mockImplementation(
    defaultSignInResourceOperationImpl,
  );
  mockedClerk.signInFutureReset.mockReset();
  mockedClerk.signInFutureReset.mockImplementation(
    defaultSignInFutureResetImpl,
  );
  mockedClerk.signInAuthenticateWithPasskey.mockReset();
  mockedClerk.signInAuthenticateWithPasskey.mockImplementation(
    defaultSignInResourceOperationImpl,
  );
  mockedClerk.signInAuthenticateWithRedirect.mockReset();
  mockedClerk.signInAuthenticateWithRedirect.mockImplementation(
    defaultSignInAuthenticateWithRedirectImpl,
  );
  mockedClerk.handleRedirectCallback.mockReset();
  mockedClerk.handleRedirectCallback.mockImplementation(
    defaultHandleRedirectCallbackImpl,
  );
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

export function clearMockedAuthOnAbort(signal: AbortSignal): void {
  signal.addEventListener("abort", clearMockedAuth, { once: true });
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
interface MockedSignInCreateParams {
  readonly identifier?: string;
  readonly signUpIfMissing?: boolean;
  readonly strategy?: string;
  readonly ticket?: string;
  readonly token?: string;
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
const signInAuthenticateWithPasskey = vi.fn<
  typeof defaultSignInResourceOperationImpl
>(defaultSignInResourceOperationImpl);

interface MockedSignInAuthenticateWithRedirectParams {
  readonly continueSignIn?: boolean;
  readonly continueSignUp?: boolean;
  readonly redirectUrl: string;
  readonly redirectUrlComplete: string;
  readonly strategy: string;
}

function defaultSignInAuthenticateWithRedirectImpl(
  _params: MockedSignInAuthenticateWithRedirectParams,
) {
  return Promise.resolve();
}

const signInAuthenticateWithRedirect = vi.fn<
  typeof defaultSignInAuthenticateWithRedirectImpl
>(defaultSignInAuthenticateWithRedirectImpl);

interface MockedHandleRedirectCallbackParams {
  readonly continueSignUpUrl?: string | null;
  readonly firstFactorUrl?: string;
  readonly reloadResource?: "signIn" | "signUp";
  readonly resetPasswordUrl?: string;
  readonly secondFactorUrl?: string;
  readonly signInFallbackRedirectUrl?: string | null;
  readonly signInForceRedirectUrl?: string | null;
  readonly signInUrl?: string;
  readonly signUpUrl?: string;
  readonly transferable?: boolean;
  readonly verifyEmailAddressUrl?: string | null;
  readonly verifyPhoneNumberUrl?: string | null;
}

function defaultHandleRedirectCallbackImpl(
  _params?: MockedHandleRedirectCallbackParams,
) {
  return Promise.resolve();
}

const handleRedirectCallback = vi.fn<typeof defaultHandleRedirectCallbackImpl>(
  defaultHandleRedirectCallbackImpl,
);
const signInResetPassword = vi.fn<typeof defaultSignInResourceOperationImpl>(
  defaultSignInResourceOperationImpl,
);

function defaultSignInFutureResetImpl(): void {
  mockSignInResource({ status: "needs_identifier" });
}

const signInFutureReset = vi.fn<typeof defaultSignInFutureResetImpl>(
  defaultSignInFutureResetImpl,
);

const mockedClientSignIn = {
  get status() {
    return internalMockedSignInResourceState.status;
  },
  get supportedFirstFactors() {
    return internalMockedSignInResourceState.supportedFirstFactors;
  },
  get createdSessionId() {
    return internalMockedSignInResourceState.createdSessionId;
  },
  create: clientSignInCreate,
  prepareFirstFactor: signInPrepareFirstFactor,
  attemptFirstFactor: signInAttemptFirstFactor,
  authenticateWithPasskey: signInAuthenticateWithPasskey,
  authenticateWithRedirect: signInAuthenticateWithRedirect,
  resetPassword: signInResetPassword,
  __internal_future: {
    get isTransferable() {
      return internalMockedSignInResourceState.isTransferable;
    },
    reset: signInFutureReset,
  },
};
const defaultBuildUrlWithAuthImpl = (to: string) => {
  return to;
};

const defaultBuildUserProfileUrlImpl = () => {
  return "https://accounts.example.test/user";
};

interface MockedClerkLoadOptions {
  isSatellite?: boolean;
  signInUrl?: string;
  touchSession?: boolean;
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
  redirectUrl?: string;
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
  let navigatedTo: string | null = params.redirectUrl ?? null;
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
    if (internalMockedClerkSessionSignedOut) {
      return null;
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
  signInAuthenticateWithPasskey,
  signInAuthenticateWithRedirect,
  signInResetPassword,
  signInFutureReset,
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
  get __internal_environment() {
    return {
      displayConfig: {
        googleOneTapClientId:
          internalMockedAuthV2Capabilities.googleOneTapClientId ?? undefined,
      },
      userSettings: {
        attributes: {
          passkey: {
            enabled: internalMockedAuthV2Capabilities.passkey,
            used_for_first_factor: internalMockedAuthV2Capabilities.passkey,
          },
        },
        authenticatableSocialStrategies:
          internalMockedAuthV2Capabilities.googleOAuth ? ["oauth_google"] : [],
        passkeySettings: {
          show_sign_in_button: internalMockedAuthV2Capabilities.passkey,
        },
      },
    };
  },
  handleRedirectCallback,
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
  setActive: vi.fn<typeof defaultSetActiveImpl>(defaultSetActiveImpl),
  createOrganization: vi.fn((_params: { name: string; slug: string }) => {
    return Promise.resolve({ id: "new-org-id" });
  }),
};
