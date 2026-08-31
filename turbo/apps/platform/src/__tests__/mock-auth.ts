import type {
  Attribute,
  AttributeData,
  BrowserClerk,
  ClerkAPIError,
  CreateOrganizationParams,
  PasswordValidation,
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

export interface MockedAuthV2Capabilities {
  readonly appleOAuth?: boolean;
  readonly googleOAuth?: boolean;
  readonly googleOneTapClientId?: string | null;
  readonly lastAuthenticationStrategy?: "oauth_apple" | "oauth_google" | null;
  readonly passkey?: boolean;
}

export type MockedSignInFactor =
  | { readonly strategy: "password" }
  | {
      readonly emailAddressId: string;
      readonly safeIdentifier: string;
      readonly strategy: "email_code" | "reset_password_email_code";
    }
  | { readonly strategy: "oauth_apple" | "oauth_google" | "passkey" }
  | { readonly strategy: string };

export interface MockedSignInResourceState {
  readonly createdSessionId?: string | null;
  readonly identifier?: string | null;
  readonly isTransferable?: boolean;
  readonly secondFactorVerificationStatus?: string | null;
  readonly secondFactorVerificationStrategy?: string | null;
  readonly status: string | null;
  readonly supportedFirstFactors?: readonly MockedSignInFactor[] | null;
  readonly supportedSecondFactors?: readonly MockedSignInFactor[] | null;
}

export interface MockedSignUpResourceState {
  readonly createdSessionId?: string | null;
  readonly emailAddress?: string | null;
  readonly externalAccountError?: ClerkAPIError | null;
  readonly externalAccountStatus?: string | null;
  readonly emailVerificationExpireAt?: Date | null;
  readonly emailVerificationStatus?: string | null;
  readonly emailVerificationStrategy?: string | null;
  readonly firstName?: string | null;
  readonly hasPassword?: boolean;
  readonly isTransferable?: boolean;
  readonly lastName?: string | null;
  readonly legalAcceptedAt?: number | null;
  readonly missingFields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly requiredFields?: readonly string[];
  readonly status: string | null;
  readonly unverifiedFields?: readonly string[];
}

interface MockedSignUpConfiguration {
  readonly attributes?: Partial<
    Record<
      Attribute,
      Pick<AttributeData, "enabled" | "required" | "used_for_first_factor">
    >
  >;
  readonly captchaEnabled?: boolean;
  readonly captchaWidgetType?: "invisible" | "smart" | null;
  readonly legalConsentEnabled?: boolean;
  readonly privacyPolicyUrl?: string;
  readonly progressive?: boolean;
  readonly termsUrl?: string;
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
  appleOAuth: false,
  googleOAuth: false,
  googleOneTapClientId: null,
  lastAuthenticationStrategy: null,
  passkey: false,
};
let internalMockedClerkLoadOptions: MockedClerkLoadOptions = {};
let internalMockedClerkLoaded = true;
let internalMockedClerkSessionTransitioning = false;
let internalMockedClerkSessionSignedOut = false;
let internalMockedSignInResourceState: Required<MockedSignInResourceState> = {
  createdSessionId: null,
  identifier: null,
  isTransferable: false,
  secondFactorVerificationStatus: null,
  secondFactorVerificationStrategy: null,
  status: "needs_identifier",
  supportedFirstFactors: null,
  supportedSecondFactors: null,
};
let internalMockedSignUpResourceState: Required<MockedSignUpResourceState> = {
  createdSessionId: null,
  emailAddress: null,
  externalAccountError: null,
  externalAccountStatus: null,
  emailVerificationExpireAt: null,
  emailVerificationStatus: null,
  emailVerificationStrategy: null,
  firstName: null,
  hasPassword: false,
  isTransferable: false,
  lastName: null,
  legalAcceptedAt: null,
  missingFields: [],
  optionalFields: [],
  requiredFields: [],
  status: null,
  unverifiedFields: [],
};
let internalMockedSignUpConfiguration: Required<MockedSignUpConfiguration> = {
  attributes: {
    email_address: {
      enabled: true,
      required: true,
      used_for_first_factor: true,
    },
    first_name: {
      enabled: true,
      required: false,
      used_for_first_factor: false,
    },
    last_name: {
      enabled: true,
      required: false,
      used_for_first_factor: false,
    },
    password: {
      enabled: true,
      required: true,
      used_for_first_factor: true,
    },
    phone_number: {
      enabled: false,
      required: false,
      used_for_first_factor: false,
    },
    username: {
      enabled: false,
      required: false,
      used_for_first_factor: false,
    },
  },
  captchaEnabled: false,
  captchaWidgetType: null,
  legalConsentEnabled: false,
  privacyPolicyUrl: "https://vm0.ai/privacy",
  progressive: true,
  termsUrl: "https://vm0.ai/terms",
};
let internalMockedPasswordValidation: PasswordValidation = {
  complexity: {},
  strength: undefined,
};

export function mockSignInResource(state: MockedSignInResourceState): void {
  internalMockedSignInResourceState = {
    createdSessionId: state.createdSessionId ?? null,
    identifier: state.identifier ?? null,
    isTransferable: state.isTransferable ?? false,
    secondFactorVerificationStatus:
      state.secondFactorVerificationStatus ?? null,
    secondFactorVerificationStrategy:
      state.secondFactorVerificationStrategy ?? null,
    status: state.status,
    supportedFirstFactors: state.supportedFirstFactors ?? null,
    supportedSecondFactors: state.supportedSecondFactors ?? null,
  };
}

export function mockSignUpResource(state: MockedSignUpResourceState): void {
  internalMockedSignUpResourceState = {
    createdSessionId: state.createdSessionId ?? null,
    emailAddress: state.emailAddress ?? null,
    externalAccountError: state.externalAccountError ?? null,
    externalAccountStatus: state.externalAccountStatus ?? null,
    emailVerificationExpireAt: state.emailVerificationExpireAt ?? null,
    emailVerificationStatus: state.emailVerificationStatus ?? null,
    emailVerificationStrategy: state.emailVerificationStrategy ?? null,
    firstName: state.firstName ?? null,
    hasPassword: state.hasPassword ?? false,
    isTransferable: state.isTransferable ?? false,
    lastName: state.lastName ?? null,
    legalAcceptedAt: state.legalAcceptedAt ?? null,
    missingFields: state.missingFields ?? [],
    optionalFields:
      state.optionalFields ??
      (state.status === null ? [] : ["first_name", "last_name"]),
    requiredFields:
      state.requiredFields ??
      (state.status === null ? [] : ["email_address", "password"]),
    status: state.status,
    unverifiedFields: state.unverifiedFields ?? [],
  };
}

export function mockSignUpConfiguration(
  configuration: MockedSignUpConfiguration,
): void {
  const attributes = configuration.attributes;
  internalMockedSignUpConfiguration = {
    attributes: {
      ...attributes,
      email_address: {
        enabled: true,
        required: true,
        used_for_first_factor: true,
        ...attributes?.email_address,
      },
      first_name: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
        ...attributes?.first_name,
      },
      last_name: {
        enabled: true,
        required: false,
        used_for_first_factor: false,
        ...attributes?.last_name,
      },
      password: {
        enabled: true,
        required: true,
        used_for_first_factor: true,
        ...attributes?.password,
      },
      phone_number: {
        enabled: false,
        required: false,
        used_for_first_factor: false,
        ...attributes?.phone_number,
      },
      username: {
        enabled: false,
        required: false,
        used_for_first_factor: false,
        ...attributes?.username,
      },
    },
    captchaEnabled: configuration.captchaEnabled ?? false,
    captchaWidgetType:
      configuration.captchaWidgetType ??
      (configuration.captchaEnabled ? "smart" : null),
    legalConsentEnabled: configuration.legalConsentEnabled ?? false,
    privacyPolicyUrl:
      configuration.privacyPolicyUrl ?? "https://vm0.ai/privacy",
    progressive: configuration.progressive ?? true,
    termsUrl: configuration.termsUrl ?? "https://vm0.ai/terms",
  };
}

export function mockSignUpPasswordValidation(
  validation: PasswordValidation,
): void {
  internalMockedPasswordValidation = validation;
}

export function mockAuthV2Capabilities(
  capabilities: MockedAuthV2Capabilities,
): void {
  internalMockedAuthV2Capabilities = {
    appleOAuth: capabilities.appleOAuth ?? false,
    googleOAuth: capabilities.googleOAuth ?? false,
    googleOneTapClientId: capabilities.googleOneTapClientId ?? null,
    lastAuthenticationStrategy: capabilities.lastAuthenticationStrategy ?? null,
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

interface MockedGoogleOneTapInitializeOptions {
  readonly auto_select: boolean;
  readonly callback: (response: { readonly credential?: string }) => void;
  readonly cancel_on_tap_outside: boolean;
  readonly client_id: string;
  readonly itp_support: boolean;
  readonly use_fedcm_for_prompt: boolean;
}

type MockedGoogleOneTapMomentCallback = (notification: {
  getMomentType(): "dismissed" | "display" | "skipped";
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
    callback({ getMomentType: () => "dismissed" });
    return;
  }
  callback({ getMomentType: () => "skipped" });
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
    appleOAuth: false,
    googleOAuth: false,
    googleOneTapClientId: null,
    lastAuthenticationStrategy: null,
    passkey: false,
  };
  internalMockedGoogleOneTapCredential = null;
  internalMockedGoogleOneTapCallback = null;
  Reflect.deleteProperty(globalThis, "google");
  for (const script of document.querySelectorAll(
    "script[data-auth-v2-google-one-tap]",
  )) {
    script.remove();
  }
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
  mockSignUpResource({ status: null });
  mockSignUpConfiguration({});
  mockSignUpPasswordValidation({ complexity: {}, strength: undefined });
  clerkListeners.length = 0;
  mockedClerk.on = defaultClerkStatusOn;
  mockedClerk.signOut.mockReset();
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
  mockedClerk.signInPrepareSecondFactor.mockReset();
  mockedClerk.signInPrepareSecondFactor.mockImplementation(
    defaultSignInResourceOperationImpl,
  );
  mockedClerk.signInAttemptSecondFactor.mockReset();
  mockedClerk.signInAttemptSecondFactor.mockImplementation(
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
  mockedClerk.clientSignUpCreate.mockReset();
  mockedClerk.clientSignUpCreate.mockImplementation(
    defaultSignUpResourceOperationImpl,
  );
  mockedClerk.signUpUpdate.mockReset();
  mockedClerk.signUpUpdate.mockImplementation(
    defaultSignUpResourceOperationImpl,
  );
  mockedClerk.signUpPrepareEmailAddressVerification.mockReset();
  mockedClerk.signUpPrepareEmailAddressVerification.mockImplementation(
    defaultSignUpResourceOperationImpl,
  );
  mockedClerk.signUpAttemptEmailAddressVerification.mockReset();
  mockedClerk.signUpAttemptEmailAddressVerification.mockImplementation(
    defaultSignUpResourceOperationImpl,
  );
  mockedClerk.signUpValidatePassword.mockReset();
  mockedClerk.signUpValidatePassword.mockImplementation(
    defaultSignUpValidatePasswordImpl,
  );
  mockedClerk.signUpFutureReset.mockReset();
  mockedClerk.signUpFutureReset.mockImplementation(
    defaultSignUpFutureResetImpl,
  );
  mockedClerk.signUpReload.mockReset();
  mockedClerk.signUpReload.mockImplementation(
    defaultSignUpResourceOperationImpl,
  );
  mockedClerk.signUpAuthenticateWithRedirect.mockReset();
  mockedClerk.signUpAuthenticateWithRedirect.mockImplementation(
    defaultSignUpAuthenticateWithRedirectImpl,
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
const signInPrepareSecondFactor = vi.fn<
  typeof defaultSignInResourceOperationImpl
>(defaultSignInResourceOperationImpl);
const signInAttemptSecondFactor = vi.fn<
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
  readonly signUpFallbackRedirectUrl?: string | null;
  readonly signUpForceRedirectUrl?: string | null;
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
  prepareSecondFactor: signInPrepareSecondFactor,
  attemptSecondFactor: signInAttemptSecondFactor,
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

function defaultSignUpResourceOperationImpl(_params?: unknown) {
  return Promise.resolve(mockedClientSignUp);
}

const clientSignUpCreate = vi.fn<typeof defaultSignUpResourceOperationImpl>(
  defaultSignUpResourceOperationImpl,
);
const signUpUpdate = vi.fn<typeof defaultSignUpResourceOperationImpl>(
  defaultSignUpResourceOperationImpl,
);
const signUpPrepareEmailAddressVerification = vi.fn<
  typeof defaultSignUpResourceOperationImpl
>(defaultSignUpResourceOperationImpl);
const signUpAttemptEmailAddressVerification = vi.fn<
  typeof defaultSignUpResourceOperationImpl
>(defaultSignUpResourceOperationImpl);
const signUpReload = vi.fn<typeof defaultSignUpResourceOperationImpl>(
  defaultSignUpResourceOperationImpl,
);

interface MockedPasswordValidationCallbacks {
  readonly onValidation?: (validation: PasswordValidation) => void;
}

function defaultSignUpValidatePasswordImpl(
  _password: string,
  callbacks?: MockedPasswordValidationCallbacks,
): void {
  callbacks?.onValidation?.(internalMockedPasswordValidation);
}

const signUpValidatePassword = vi.fn<typeof defaultSignUpValidatePasswordImpl>(
  defaultSignUpValidatePasswordImpl,
);

function defaultSignUpFutureResetImpl() {
  mockSignUpResource({ status: null });
  return Promise.resolve({ error: null });
}

const signUpFutureReset = vi.fn<typeof defaultSignUpFutureResetImpl>(
  defaultSignUpFutureResetImpl,
);

interface MockedSignUpAuthenticateWithRedirectParams {
  readonly continueSignIn?: boolean;
  readonly continueSignUp?: boolean;
  readonly legalAccepted?: boolean;
  readonly redirectUrl: string;
  readonly redirectUrlComplete: string;
  readonly strategy: string;
}

function defaultSignUpAuthenticateWithRedirectImpl(
  _params: MockedSignUpAuthenticateWithRedirectParams,
) {
  return Promise.resolve();
}

const signUpAuthenticateWithRedirect = vi.fn<
  typeof defaultSignUpAuthenticateWithRedirectImpl
>(defaultSignUpAuthenticateWithRedirectImpl);

const mockedClientSignUp = {
  reload: signUpReload,
  get status() {
    return internalMockedSignUpResourceState.status;
  },
  get requiredFields() {
    return internalMockedSignUpResourceState.requiredFields;
  },
  get optionalFields() {
    return internalMockedSignUpResourceState.optionalFields;
  },
  get missingFields() {
    return internalMockedSignUpResourceState.missingFields;
  },
  get unverifiedFields() {
    return internalMockedSignUpResourceState.unverifiedFields;
  },
  get emailAddress() {
    return internalMockedSignUpResourceState.emailAddress;
  },
  get firstName() {
    return internalMockedSignUpResourceState.firstName;
  },
  get lastName() {
    return internalMockedSignUpResourceState.lastName;
  },
  get hasPassword() {
    return internalMockedSignUpResourceState.hasPassword;
  },
  get legalAcceptedAt() {
    return internalMockedSignUpResourceState.legalAcceptedAt;
  },
  get createdSessionId() {
    return internalMockedSignUpResourceState.createdSessionId;
  },
  create: clientSignUpCreate,
  update: signUpUpdate,
  prepareEmailAddressVerification: signUpPrepareEmailAddressVerification,
  attemptEmailAddressVerification: signUpAttemptEmailAddressVerification,
  authenticateWithRedirect: signUpAuthenticateWithRedirect,
  validatePassword: signUpValidatePassword,
  verifications: {
    emailAddress: {
      get status() {
        return internalMockedSignUpResourceState.emailVerificationStatus;
      },
      get strategy() {
        return internalMockedSignUpResourceState.emailVerificationStrategy;
      },
      get expireAt() {
        return internalMockedSignUpResourceState.emailVerificationExpireAt;
      },
    },
    externalAccount: {
      get error() {
        return internalMockedSignUpResourceState.externalAccountError;
      },
      get status() {
        return internalMockedSignUpResourceState.externalAccountStatus;
      },
    },
  },
  __internal_future: {
    get isTransferable() {
      return internalMockedSignUpResourceState.isTransferable;
    },
    reset: signUpFutureReset,
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
  signInPrepareSecondFactor,
  signInAttemptSecondFactor,
  signInAuthenticateWithPasskey,
  signInAuthenticateWithRedirect,
  signInResetPassword,
  signInFutureReset,
  clientSignUpCreate,
  signUpUpdate,
  signUpPrepareEmailAddressVerification,
  signUpAttemptEmailAddressVerification,
  signUpValidatePassword,
  signUpFutureReset,
  signUpReload,
  signUpAuthenticateWithRedirect,
  client: {
    get lastAuthenticationStrategy() {
      return internalMockedAuthV2Capabilities.lastAuthenticationStrategy;
    },
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
    signUp: mockedClientSignUp,
  },
  get __internal_environment() {
    return {
      displayConfig: {
        get captchaWidgetType() {
          return internalMockedSignUpConfiguration.captchaWidgetType;
        },
        get captchaPublicKey() {
          return internalMockedSignUpConfiguration.captchaEnabled
            ? "test-captcha-key"
            : null;
        },
        get captchaPublicKeyInvisible() {
          return null;
        },
        get googleOneTapClientId() {
          return (
            internalMockedAuthV2Capabilities.googleOneTapClientId ?? undefined
          );
        },
        get privacyPolicyUrl() {
          return internalMockedSignUpConfiguration.privacyPolicyUrl;
        },
        get termsUrl() {
          return internalMockedSignUpConfiguration.termsUrl;
        },
      },
      userSettings: {
        attributes: {
          ...internalMockedSignUpConfiguration.attributes,
          passkey: {
            enabled: internalMockedAuthV2Capabilities.passkey,
            required: false,
            used_for_first_factor: internalMockedAuthV2Capabilities.passkey,
          },
        },
        authenticatableSocialStrategies: [
          ...(internalMockedAuthV2Capabilities.appleOAuth
            ? (["oauth_apple"] as const)
            : []),
          ...(internalMockedAuthV2Capabilities.googleOAuth
            ? (["oauth_google"] as const)
            : []),
        ],
        passkeySettings: {
          show_sign_in_button: internalMockedAuthV2Capabilities.passkey,
        },
        signUp: {
          legal_consent_enabled:
            internalMockedSignUpConfiguration.legalConsentEnabled,
          progressive: internalMockedSignUpConfiguration.progressive,
        },
      },
    };
  },
  handleRedirectCallback,
  signOut: vi.fn<BrowserClerk["signOut"]>(() => {
    return Promise.resolve();
  }),
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
  redirectToSignIn: vi.fn<BrowserClerk["redirectToSignIn"]>(),
  buildSignInUrl: vi.fn<typeof defaultBuildSignInUrlImpl>(
    defaultBuildSignInUrlImpl,
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
