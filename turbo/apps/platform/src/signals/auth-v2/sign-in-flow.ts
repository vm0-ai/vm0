import type {
  PrepareFirstFactorParams,
  PrepareSecondFactorParams,
  SignInFirstFactor,
  SignInResource,
  SignInSecondFactor,
} from "@clerk/react/types";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { now } from "../../lib/time.ts";
import { clerk$ } from "../auth.ts";
import { onRef, setLoop, settle, withCleanup } from "../utils.ts";
import {
  discoverAuthV2ExistingAccounts,
  discoverAuthV2ExternalCapabilities,
  discoverAuthV2PasskeyCapability,
  type AuthV2ExistingAccount,
  type AuthV2ExternalCapabilities,
  type AuthV2PasskeyCapability,
  recoverAuthV2OAuth,
  requestGoogleOneTapCredential,
  startAuthV2OAuth,
} from "./sign-in-external-strategies.ts";
import type { AuthV2ContinuationFlowHandoff } from "./continuation.ts";
import type { AuthV2Navigation } from "./navigation.ts";
import {
  isAuthV2OAuthStrategy,
  type AuthV2OAuthStrategy,
} from "./oauth-strategies.ts";
import {
  AUTH_V2_SIGN_IN_RESEND_COOLDOWN_STORAGE_KEY,
  createAuthV2ResendCooldownStorage,
} from "./resend-cooldown.ts";

export const AUTH_V2_SIGN_IN_RESEND_COOLDOWN_SECONDS = 30;
const AUTH_V2_SIGN_IN_RESEND_COOLDOWN_MS =
  AUTH_V2_SIGN_IN_RESEND_COOLDOWN_SECONDS * 1000;
const signInResendCooldownStorage = createAuthV2ResendCooldownStorage(
  AUTH_V2_SIGN_IN_RESEND_COOLDOWN_STORAGE_KEY,
);

export type AuthV2SignInFactor =
  | {
      readonly id: "password";
      readonly kind: "password";
    }
  | {
      readonly emailAddressId: string;
      readonly id: string;
      readonly kind: "email-code";
      readonly safeIdentifier: string;
    }
  | {
      readonly emailAddressId: string;
      readonly id: string;
      readonly kind: "password-reset";
      readonly safeIdentifier: string;
    }
  | {
      readonly emailAddressId: string;
      readonly id: string;
      readonly kind: "client-trust-email-code";
      readonly safeIdentifier: string;
    }
  | {
      readonly id: `oauth:${AuthV2OAuthStrategy}`;
      readonly kind: "oauth";
      readonly lastUsed: boolean;
      readonly strategy: AuthV2OAuthStrategy;
    }
  | {
      readonly id: "passkey";
      readonly kind: "passkey";
    };

export type AuthV2SignInStep =
  | "choose-session"
  | "identifier"
  | "choose-factor"
  | "password"
  | "password-recovery"
  | "help"
  | "email-code"
  | "client-trust-code"
  | "password-reset-code"
  | "new-password";

export type AuthV2SignInUnknownReason =
  | "missing-session"
  | "unsupported-factor"
  | "unsupported-status";

export type AuthV2SignInState =
  | { readonly status: "loading" }
  | {
      readonly accounts: readonly AuthV2ExistingAccount[];
      readonly factors: readonly AuthV2SignInFactor[];
      readonly identifierMode: AuthV2ExternalCapabilities["identifierMode"];
      readonly selectedFactor: AuthV2SignInFactor | null;
      readonly status: "incomplete";
      readonly step: AuthV2SignInStep;
    }
  | { readonly status: "complete" }
  | { readonly status: "transfer" }
  | {
      readonly clerkStatus: string | null;
      readonly reason: AuthV2SignInUnknownReason;
      readonly status: "unknown";
    };

export type AuthV2SignInErrorField =
  | "code"
  | "general"
  | "identifier"
  | "new-password"
  | "password";

export interface AuthV2SignInError {
  readonly clerkCode?: string;
  readonly code:
    | "access-not-allowed"
    | "clerk"
    | "code-expired"
    | "passkey-cancelled"
    | "passkey-unavailable"
    | "password-mismatch"
    | "user-banned"
    | "unknown";
  readonly field: AuthV2SignInErrorField;
}

export type AuthV2SignInResendState =
  | { readonly remainingSeconds: 0; readonly status: "ready" }
  | { readonly remainingSeconds: number; readonly status: "cooling-down" };

interface SignInResourceSnapshot {
  readonly clerkStatus: string | null;
  readonly createdSessionId: string | null;
  readonly factors: readonly AuthV2SignInFactor[];
  readonly firstFactorVerificationStatus: string | null;
  readonly firstFactorVerificationStrategy: string | null;
  readonly identifier: string | null;
  readonly secondFactorVerificationStatus: string | null;
  readonly secondFactorVerificationStrategy: string | null;
  readonly identifierMode: AuthV2ExternalCapabilities["identifierMode"];
  readonly transferable: boolean;
  readonly unknownFactorStrategies: readonly string[];
}

export interface AuthV2SignInFlowDependencies {
  readonly continuation: AuthV2ContinuationFlowHandoff;
  readonly isBaseRoute: boolean;
  readonly isOAuthCallbackRoute: boolean;
  readonly navigation: AuthV2Navigation;
}

export interface AuthV2SignInSignals {
  readonly backFromHelp$: Command<void, []>;
  readonly backFromMethods$: Command<void, []>;
  readonly backFromPasswordRecovery$: Command<void, []>;
  readonly backFromNewPassword$: Command<void, []>;
  readonly backToIdentifier$: Command<void, []>;
  readonly backToMethods$: Command<void, []>;
  readonly code$: Computed<string>;
  readonly confirmPassword$: Computed<string>;
  readonly error$: Computed<AuthV2SignInError | null>;
  readonly identifier$: Computed<string>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly newPassword$: Computed<string>;
  readonly pendingFactorId$: Computed<string | null>;
  readonly password$: Computed<string>;
  readonly resendCode$: Command<Promise<void>, [AbortSignal]>;
  readonly resendCooldownLifecycleRef$: ReturnType<
    typeof onRef<HTMLSpanElement>
  >;
  readonly resendState$: Computed<AuthV2SignInResendState>;
  readonly restart$: Command<void, []>;
  readonly selectFactor$: Command<Promise<void>, [string, AbortSignal]>;
  readonly selectSession$: Command<Promise<void>, [string, AbortSignal]>;
  readonly setCode$: Command<void, [string]>;
  readonly setConfirmPassword$: Command<void, [string]>;
  readonly setIdentifier$: Command<void, [string]>;
  readonly setNewPassword$: Command<void, [string]>;
  readonly setPassword$: Command<void, [string]>;
  readonly setSignOutOfOtherSessions$: Command<void, [boolean]>;
  readonly showPasswordRecovery$: Command<void, []>;
  readonly showHelp$: Command<void, []>;
  readonly signOutOfOtherSessions$: Computed<boolean>;
  readonly state$: Computed<AuthV2SignInState>;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
  readonly useAnotherAccount$: Command<void, []>;
}

type CoalescedOperation = "one-tap" | "resource";
type AuthV2SignInUnknownState = Extract<
  AuthV2SignInState,
  { status: "unknown" }
>;
type AuthV2IncompleteSignInState = Extract<
  AuthV2SignInState,
  { status: "incomplete" }
>;

interface SignInSubmitValues {
  readonly code: string;
  readonly confirmPassword: string;
  readonly identifier: string;
  readonly newPassword: string;
  readonly password: string;
  readonly signOutOfOtherSessions: boolean;
}

type SignInSubmitPreparation =
  | {
      readonly error: AuthV2SignInError;
      readonly fallbackField: "new-password";
      readonly request: null;
    }
  | {
      readonly error: null;
      readonly fallbackField: AuthV2SignInErrorField;
      readonly request: Promise<SignInResource>;
    };

interface SignInFlowAtoms {
  readonly accounts$: State<readonly AuthV2ExistingAccount[]>;
  readonly capabilities$: State<AuthV2ExternalCapabilities>;
  readonly code$: State<string>;
  readonly confirmPassword$: State<string>;
  readonly editIdentifier$: State<boolean>;
  readonly error$: State<AuthV2SignInError | null>;
  readonly fatalState$: State<AuthV2SignInUnknownState | null>;
  readonly helpOrigin$: State<"methods" | "password-recovery" | null>;
  readonly identifier$: State<string>;
  readonly identifierLocallyModified$: State<boolean>;
  readonly newPassword$: State<string>;
  readonly methodChooser$: State<boolean>;
  readonly pendingFactorId$: State<string | null>;
  readonly password$: State<string>;
  readonly passwordRecovery$: State<boolean>;
  readonly passkeyCapability$: State<AuthV2PasskeyCapability>;
  readonly resendRemainingSeconds$: State<number>;
  readonly selectedFactor$: State<AuthV2SignInFactor | null>;
  readonly signOutOfOtherSessions$: State<boolean>;
  readonly snapshot$: State<SignInResourceSnapshot | null>;
  readonly state$: Computed<AuthV2SignInState>;
  readonly useAnotherAccount$: State<boolean>;
}

interface SignInFlowRuntime {
  readonly cooldownDeadlineMs$: State<number | null>;
  readonly handledSessionId$: State<string | null>;
  readonly inFlight$: State<ReadonlyMap<CoalescedOperation, Promise<void>>>;
  readonly preparedFactorId$: State<string | null>;
}

type ApplySignInResourceCommand = Command<
  Promise<void>,
  [SignInResource, AbortSignal]
>;

function emptyExternalCapabilities(): AuthV2ExternalCapabilities {
  return {
    googleOneTapClientId: null,
    identifierMode: "email",
    lastUsedOAuthStrategy: null,
    oauthStrategies: [],
    passkey: false,
  };
}

interface FactorDiscovery {
  readonly factors: readonly AuthV2SignInFactor[];
  readonly unknownStrategies: readonly string[];
}

function oauthFactor(
  strategy: AuthV2OAuthStrategy,
  lastUsedOAuthStrategy: AuthV2OAuthStrategy | null,
): Extract<AuthV2SignInFactor, { kind: "oauth" }> {
  return {
    id: `oauth:${strategy}`,
    kind: "oauth",
    lastUsed: strategy === lastUsedOAuthStrategy,
    strategy,
  };
}

function discoverFactors(
  factors: readonly SignInFirstFactor[] | null,
  lastUsedOAuthStrategy: AuthV2OAuthStrategy | null,
  passkeyCapability: AuthV2PasskeyCapability,
): FactorDiscovery {
  if (!factors) {
    return { factors: [], unknownStrategies: [] };
  }

  const discovered: AuthV2SignInFactor[] = [];
  const unknownStrategies: string[] = [];
  for (const factor of factors) {
    if (factor.strategy === "password") {
      discovered.push({ id: "password", kind: "password" });
    } else if (factor.strategy === "email_code") {
      discovered.push({
        emailAddressId: factor.emailAddressId,
        id: `email-code:${factor.emailAddressId}`,
        kind: "email-code",
        safeIdentifier: factor.safeIdentifier,
      });
    } else if (factor.strategy === "reset_password_email_code") {
      discovered.push({
        emailAddressId: factor.emailAddressId,
        id: `password-reset:${factor.emailAddressId}`,
        kind: "password-reset",
        safeIdentifier: factor.safeIdentifier,
      });
    } else if (isAuthV2OAuthStrategy(factor.strategy)) {
      discovered.push(oauthFactor(factor.strategy, lastUsedOAuthStrategy));
    } else if (factor.strategy === "passkey") {
      if (passkeyCapability !== "unavailable") {
        discovered.push({ id: "passkey", kind: "passkey" });
      }
    } else {
      unknownStrategies.push(factor.strategy);
    }
  }
  return { factors: discovered, unknownStrategies };
}

function discoverClientTrustFactors(
  factors: readonly SignInSecondFactor[] | null,
): FactorDiscovery {
  if (!factors) {
    return { factors: [], unknownStrategies: [] };
  }

  const discovered: AuthV2SignInFactor[] = [];
  const unknownStrategies: string[] = [];
  for (const factor of factors) {
    if (factor.strategy === "email_code") {
      discovered.push({
        emailAddressId: factor.emailAddressId,
        id: `client-trust-email-code:${factor.emailAddressId}`,
        kind: "client-trust-email-code",
        safeIdentifier: factor.safeIdentifier,
      });
    } else {
      unknownStrategies.push(factor.strategy);
    }
  }
  return { factors: discovered, unknownStrategies };
}

function entryFactors(
  capabilities: AuthV2ExternalCapabilities,
  passkeyCapability: AuthV2PasskeyCapability,
): readonly AuthV2SignInFactor[] {
  const factors: AuthV2SignInFactor[] = [];
  for (const strategy of capabilities.oauthStrategies) {
    factors.push(oauthFactor(strategy, capabilities.lastUsedOAuthStrategy));
  }
  if (capabilities.passkey && passkeyCapability !== "unavailable") {
    factors.push({ id: "passkey", kind: "passkey" });
  }
  return factors;
}

function snapshotSignInResource(
  resource: SignInResource,
  capabilities: AuthV2ExternalCapabilities,
  passkeyCapability: AuthV2PasskeyCapability,
): SignInResourceSnapshot {
  // The legacy resource is the stable low-level API used by this app. Clerk
  // exposes transferability on its future view, so keep that SDK detail
  // isolated in this adapter rather than leaking it into the flow or view.
  const discovered =
    resource.status === "needs_client_trust"
      ? discoverClientTrustFactors(resource.supportedSecondFactors)
      : discoverFactors(
          resource.supportedFirstFactors,
          capabilities.lastUsedOAuthStrategy,
          passkeyCapability,
        );
  const factorsWithExternalOAuth =
    resource.status === "needs_client_trust"
      ? discovered.factors
      : [
          ...discovered.factors,
          ...capabilities.oauthStrategies
            .map((strategy) => {
              return oauthFactor(strategy, capabilities.lastUsedOAuthStrategy);
            })
            .filter((factor) => {
              return !discovered.factors.some((candidate) => {
                return candidate.id === factor.id;
              });
            }),
        ];
  const factors =
    resource.status === "needs_identifier" || resource.status === null
      ? entryFactors(capabilities, passkeyCapability)
      : factorsWithExternalOAuth;
  return {
    clerkStatus: resource.status,
    createdSessionId: resource.createdSessionId,
    factors,
    firstFactorVerificationStatus:
      resource.firstFactorVerification?.status ?? null,
    firstFactorVerificationStrategy:
      resource.firstFactorVerification?.strategy ?? null,
    identifier: resource.identifier,
    secondFactorVerificationStatus:
      resource.secondFactorVerification?.status ?? null,
    secondFactorVerificationStrategy:
      resource.secondFactorVerification?.strategy ?? null,
    identifierMode: capabilities.identifierMode,
    transferable: resource.__internal_future.isTransferable,
    unknownFactorStrategies: discovered.unknownStrategies,
  };
}

function preparedFactorForSnapshot(
  snapshot: SignInResourceSnapshot,
): AuthV2SignInFactor | null {
  if (snapshot.secondFactorVerificationStrategy === "email_code") {
    return (
      snapshot.factors.find((factor) => {
        return factor.kind === "client-trust-email-code";
      }) ?? null
    );
  }
  const strategy = snapshot.firstFactorVerificationStrategy;
  return (
    snapshot.factors.find((factor) => {
      return (
        (strategy === "email_code" && factor.kind === "email-code") ||
        (strategy === "reset_password_email_code" &&
          factor.kind === "password-reset")
      );
    }) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(
  value: Record<string, unknown>,
  property: string,
): string | undefined {
  const candidate = value[property];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function clerkErrorField(
  error: Record<string, unknown>,
  fallbackField: AuthV2SignInErrorField,
): AuthV2SignInErrorField {
  const meta = error.meta;
  const parameter = isRecord(meta) ? stringProperty(meta, "paramName") : null;
  if (parameter === "identifier") {
    return "identifier";
  }
  if (parameter === "code") {
    return "code";
  }
  if (parameter === "password") {
    return fallbackField === "new-password" ? "new-password" : "password";
  }
  return fallbackField;
}

function passkeyErrorCode(
  clerkCode: string | undefined,
  errorName: string | undefined,
  errorMessage: string | undefined,
): "passkey-cancelled" | "passkey-unavailable" | null {
  if (
    errorName === "AbortError" ||
    clerkCode === "passkey_retrieval_cancelled" ||
    clerkCode === "passkey_operation_aborted"
  ) {
    return "passkey-cancelled";
  }
  if (
    errorName === "NotSupportedError" ||
    errorMessage ===
      "Resident credentials or empty 'allowCredentials' lists are not supported at this time." ||
    errorMessage === "Error connecting to Web Authentication service." ||
    clerkCode === "passkey_not_supported" ||
    clerkCode === "passkey_pa_not_supported" ||
    clerkCode === "passkeys_pa_not_supported"
  ) {
    return "passkey-unavailable";
  }
  return null;
}

function isGoogleOneTapUnavailableError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const apiError = Array.isArray(error.errors)
    ? error.errors.find(isRecord)
    : null;
  const normalizedError = apiError ?? error;
  return (
    stringProperty(normalizedError, "name") === "NotSupportedError" ||
    stringProperty(normalizedError, "message") ===
      "Error connecting to Web Authentication service."
  );
}

function normalizeClerkError(
  error: unknown,
  fallbackField: AuthV2SignInErrorField,
): AuthV2SignInError {
  if (!isRecord(error)) {
    return { code: "unknown", field: fallbackField };
  }
  const apiError = Array.isArray(error.errors)
    ? error.errors.find(isRecord)
    : null;
  const normalizedError = apiError ?? error;
  const clerkCode = stringProperty(normalizedError, "code");
  const errorName = stringProperty(normalizedError, "name");
  const errorMessage = stringProperty(normalizedError, "message");
  const normalizedPasskeyCode = passkeyErrorCode(
    clerkCode,
    errorName,
    errorMessage,
  );
  if (!apiError && !clerkCode && !normalizedPasskeyCode) {
    return { code: "unknown", field: fallbackField };
  }
  const code =
    fallbackField === "code" &&
    (clerkCode?.toLowerCase().includes("expired") === true ||
      clerkCode?.toLowerCase().includes("timeout") === true)
      ? "code-expired"
      : (normalizedPasskeyCode ??
        (clerkCode === "not_allowed_access"
          ? "access-not-allowed"
          : clerkCode === "user_banned"
            ? "user-banned"
            : "clerk"));
  return {
    ...(clerkCode ? { clerkCode } : {}),
    code,
    field: clerkErrorField(normalizedError, fallbackField),
  };
}

function selectedFactorForSnapshot(
  snapshot: SignInResourceSnapshot,
  selectedFactor: AuthV2SignInFactor | null,
): AuthV2SignInFactor | null {
  if (!selectedFactor) {
    return null;
  }
  return (
    snapshot.factors.find((factor) => {
      return factor.id === selectedFactor.id;
    }) ?? null
  );
}

export const clerkSignInResource$ = computed(async (get) => {
  const clerk = await get(clerk$);
  if (!clerk.client) {
    throw new Error("Loaded Clerk instance did not provide a client resource");
  }
  return clerk.client.signIn;
});

function incompleteState(
  snapshot: SignInResourceSnapshot,
  accounts: readonly AuthV2ExistingAccount[],
  step: AuthV2SignInStep,
  selectedFactor: AuthV2SignInFactor | null = null,
): AuthV2SignInState {
  return {
    accounts,
    factors: snapshot.factors,
    identifierMode: snapshot.identifierMode,
    selectedFactor,
    status: "incomplete",
    step,
  };
}

interface DeriveSignInFlowOptions {
  readonly accounts: readonly AuthV2ExistingAccount[];
  readonly editIdentifier: boolean;
  readonly fatalState: AuthV2SignInUnknownState | null;
  readonly helpOrigin: "methods" | "password-recovery" | null;
  readonly methodChooser: boolean;
  readonly passwordRecovery: boolean;
  readonly selectedFactor: AuthV2SignInFactor | null;
  readonly useAnotherAccount: boolean;
}

function stepForSelectedFactor(
  factor: AuthV2SignInFactor | null,
): AuthV2SignInStep {
  if (factor?.kind === "password") {
    return "password";
  }
  if (factor?.kind === "email-code") {
    return "email-code";
  }
  if (factor?.kind === "client-trust-email-code") {
    return "client-trust-code";
  }
  if (factor?.kind === "password-reset") {
    return "password-reset-code";
  }
  return "choose-factor";
}

function deriveClientTrustState(
  snapshot: SignInResourceSnapshot,
  options: DeriveSignInFlowOptions,
): AuthV2SignInState {
  if (
    snapshot.factors.length === 0 ||
    snapshot.unknownFactorStrategies.length > 0
  ) {
    return {
      clerkStatus: snapshot.clerkStatus,
      reason: "unsupported-factor",
      status: "unknown",
    };
  }
  const currentFactor =
    selectedFactorForSnapshot(snapshot, options.selectedFactor) ??
    snapshot.factors.find((factor) => {
      return factor.kind === "client-trust-email-code";
    }) ??
    null;
  return incompleteState(
    snapshot,
    options.accounts,
    stepForSelectedFactor(currentFactor),
    currentFactor,
  );
}

function unsupportedFactorState(
  snapshot: SignInResourceSnapshot,
): AuthV2SignInUnknownState {
  return {
    clerkStatus: snapshot.clerkStatus,
    reason: "unsupported-factor",
    status: "unknown",
  };
}

function deriveFirstFactorState(
  snapshot: SignInResourceSnapshot,
  options: DeriveSignInFlowOptions,
): AuthV2SignInState {
  if (
    snapshot.factors.length === 0 ||
    snapshot.unknownFactorStrategies.length > 0
  ) {
    return unsupportedFactorState(snapshot);
  }
  const currentFactor = selectedFactorForSnapshot(
    snapshot,
    options.selectedFactor,
  );
  if (options.helpOrigin) {
    return incompleteState(snapshot, options.accounts, "help", currentFactor);
  }
  if (
    options.passwordRecovery &&
    snapshot.factors.some((factor) => {
      return factor.kind === "password-reset";
    })
  ) {
    return incompleteState(
      snapshot,
      options.accounts,
      "password-recovery",
      currentFactor,
    );
  }
  if (options.methodChooser) {
    return incompleteState(
      snapshot,
      options.accounts,
      "choose-factor",
      currentFactor,
    );
  }
  return incompleteState(
    snapshot,
    options.accounts,
    stepForSelectedFactor(currentFactor),
    currentFactor,
  );
}

function deriveNewPasswordState(
  snapshot: SignInResourceSnapshot,
  options: DeriveSignInFlowOptions,
): AuthV2SignInState {
  const currentFactor = selectedFactorForSnapshot(
    snapshot,
    options.selectedFactor,
  );
  if (options.helpOrigin) {
    return incompleteState(snapshot, options.accounts, "help", currentFactor);
  }
  if (
    options.passwordRecovery &&
    snapshot.factors.some((factor) => {
      return factor.kind === "password-reset";
    })
  ) {
    return incompleteState(
      snapshot,
      options.accounts,
      "password-recovery",
      currentFactor,
    );
  }
  return incompleteState(
    snapshot,
    options.accounts,
    "new-password",
    options.selectedFactor,
  );
}

function deriveSignInFlowState(
  snapshot: SignInResourceSnapshot | null,
  options: DeriveSignInFlowOptions,
): AuthV2SignInState {
  if (options.fatalState) {
    return options.fatalState;
  }
  if (!snapshot) {
    return { status: "loading" };
  }
  if (snapshot.transferable) {
    return { status: "transfer" };
  }
  if (
    options.editIdentifier ||
    snapshot.clerkStatus === "needs_identifier" ||
    snapshot.clerkStatus === null
  ) {
    return incompleteState(
      snapshot,
      options.accounts,
      !options.editIdentifier &&
        !options.useAnotherAccount &&
        options.accounts.length > 0
        ? "choose-session"
        : "identifier",
    );
  }
  if (snapshot.clerkStatus === "needs_first_factor") {
    return deriveFirstFactorState(snapshot, options);
  }
  if (snapshot.clerkStatus === "needs_client_trust") {
    return deriveClientTrustState(snapshot, options);
  }
  if (snapshot.clerkStatus === "needs_new_password") {
    return deriveNewPasswordState(snapshot, options);
  }
  if (snapshot.clerkStatus === "complete") {
    return snapshot.createdSessionId
      ? { status: "complete" }
      : {
          clerkStatus: snapshot.clerkStatus,
          reason: "missing-session",
          status: "unknown",
        };
  }
  return {
    clerkStatus: snapshot.clerkStatus,
    reason: "unsupported-status",
    status: "unknown",
  };
}

function createSignInFlowAtoms(): SignInFlowAtoms {
  const accounts$ = state<readonly AuthV2ExistingAccount[]>([]);
  const capabilities$ = state<AuthV2ExternalCapabilities>(
    emptyExternalCapabilities(),
  );
  const snapshot$ = state<SignInResourceSnapshot | null>(null);
  const selectedFactor$ = state<AuthV2SignInFactor | null>(null);
  const signOutOfOtherSessions$ = state(true);
  const editIdentifier$ = state(false);
  const fatalState$ = state<AuthV2SignInUnknownState | null>(null);
  const helpOrigin$ = state<"methods" | "password-recovery" | null>(null);
  const error$ = state<AuthV2SignInError | null>(null);
  const identifier$ = state("");
  const identifierLocallyModified$ = state(false);
  const password$ = state("");
  const methodChooser$ = state(false);
  const pendingFactorId$ = state<string | null>(null);
  const passwordRecovery$ = state(false);
  const passkeyCapability$ = state<AuthV2PasskeyCapability>("unknown");
  const resendRemainingSeconds$ = state(0);
  const code$ = state("");
  const newPassword$ = state("");
  const confirmPassword$ = state("");
  const useAnotherAccount$ = state(false);
  const state$ = computed((get) => {
    return deriveSignInFlowState(get(snapshot$), {
      accounts: get(accounts$),
      editIdentifier: get(editIdentifier$),
      fatalState: get(fatalState$),
      helpOrigin: get(helpOrigin$),
      methodChooser: get(methodChooser$),
      passwordRecovery: get(passwordRecovery$),
      selectedFactor: get(selectedFactor$),
      useAnotherAccount: get(useAnotherAccount$),
    });
  });
  return {
    accounts$,
    capabilities$,
    code$,
    confirmPassword$,
    editIdentifier$,
    error$,
    fatalState$,
    helpOrigin$,
    identifier$,
    identifierLocallyModified$,
    newPassword$,
    methodChooser$,
    pendingFactorId$,
    password$,
    passwordRecovery$,
    passkeyCapability$,
    resendRemainingSeconds$,
    selectedFactor$,
    signOutOfOtherSessions$,
    snapshot$,
    state$,
    useAnotherAccount$,
  };
}

function createSignInFlowRuntime(): SignInFlowRuntime {
  return {
    cooldownDeadlineMs$: state<number | null>(null),
    handledSessionId$: state<string | null>(null),
    inFlight$: state<ReadonlyMap<CoalescedOperation, Promise<void>>>(new Map()),
    preparedFactorId$: state<string | null>(null),
  };
}

function createStartCooldownCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
): Command<void, [string, AbortSignal]> {
  return command(({ set }, identity: string, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const deadlineMs = now() + AUTH_V2_SIGN_IN_RESEND_COOLDOWN_MS;
    set(signInResendCooldownStorage.save$, identity, deadlineMs);
    set(runtime.cooldownDeadlineMs$, deadlineMs);
    set(atoms.resendRemainingSeconds$, AUTH_V2_SIGN_IN_RESEND_COOLDOWN_SECONDS);
  });
}

function createResendCooldownLifecycleRef(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
) {
  return onRef(
    command(
      async (
        { get, set },
        _element: HTMLSpanElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await setLoop(
          () => {
            const deadlineMs = get(runtime.cooldownDeadlineMs$);
            if (deadlineMs === null) {
              return true;
            }
            const remainingSeconds = Math.max(
              0,
              Math.ceil((deadlineMs - now()) / 1000),
            );
            set(atoms.resendRemainingSeconds$, remainingSeconds);
            if (remainingSeconds > 0) {
              return false;
            }
            set(signInResendCooldownStorage.clear$);
            set(runtime.cooldownDeadlineMs$, null);
            return true;
          },
          1000,
          signal,
          { retryTransientErrors: false },
        );
      },
    ),
  );
}

function createCommitResourceCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  dependencies: AuthV2SignInFlowDependencies,
): ApplySignInResourceCommand {
  return command(
    async (
      { get, set },
      resource: SignInResource,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = snapshotSignInResource(
        resource,
        get(atoms.capabilities$),
        get(atoms.passkeyCapability$),
      );
      set(atoms.snapshot$, snapshot);
      set(atoms.fatalState$, null);
      if (
        snapshot.clerkStatus === "needs_first_factor" &&
        snapshot.identifier !== null &&
        !get(atoms.identifierLocallyModified$)
      ) {
        // Restore only Clerk's public identifier. Factor safeIdentifier values
        // are masked display labels and must never become an editable draft.
        set(atoms.identifier$, snapshot.identifier);
      }
      const preparedFactor = preparedFactorForSnapshot(snapshot);
      if (preparedFactor) {
        set(runtime.preparedFactorId$, preparedFactor.id);
        set(atoms.selectedFactor$, preparedFactor);
        const verificationStatus =
          preparedFactor.kind === "client-trust-email-code"
            ? snapshot.secondFactorVerificationStatus
            : snapshot.firstFactorVerificationStatus;
        if (verificationStatus === "expired") {
          set(signInResendCooldownStorage.clear$);
          set(runtime.cooldownDeadlineMs$, null);
          set(atoms.resendRemainingSeconds$, 0);
          set(atoms.error$, { code: "code-expired", field: "code" });
        } else {
          const deadlineMs = set(
            signInResendCooldownStorage.restore$,
            preparedFactor.id,
          );
          set(runtime.cooldownDeadlineMs$, deadlineMs);
          set(
            atoms.resendRemainingSeconds$,
            deadlineMs === null ? 0 : Math.ceil((deadlineMs - now()) / 1000),
          );
        }
      }
      if (snapshot.clerkStatus === "complete") {
        set(signInResendCooldownStorage.clear$);
        set(runtime.cooldownDeadlineMs$, null);
        set(atoms.resendRemainingSeconds$, 0);
      }
      if (snapshot.clerkStatus === "needs_second_factor") {
        set(dependencies.continuation.failClosed$, "second-factor");
        return;
      }
      if (
        snapshot.transferable ||
        snapshot.clerkStatus !== "complete" ||
        !snapshot.createdSessionId
      ) {
        return;
      }
      if (get(runtime.handledSessionId$) === snapshot.createdSessionId) {
        return;
      }
      await set(
        dependencies.continuation.completeSession$,
        snapshot.createdSessionId,
        signal,
      );
      signal.throwIfAborted();
      set(runtime.handledSessionId$, snapshot.createdSessionId);
    },
  );
}

function createResourceCommands(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  startCooldown$: Command<void, [string, AbortSignal]>,
  dependencies: AuthV2SignInFlowDependencies,
): {
  readonly applyResource$: ApplySignInResourceCommand;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
} {
  const commitResource$ = createCommitResourceCommand(
    atoms,
    runtime,
    dependencies,
  );

  const applyResource$ = command(
    async (
      { get, set },
      resource: SignInResource,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = snapshotSignInResource(
        resource,
        get(atoms.capabilities$),
        get(atoms.passkeyCapability$),
      );
      const clientTrustFactor = snapshot.factors.find((factor) => {
        return factor.kind === "client-trust-email-code";
      });
      if (
        snapshot.clerkStatus !== "needs_client_trust" ||
        !clientTrustFactor ||
        snapshot.unknownFactorStrategies.length > 0 ||
        snapshot.secondFactorVerificationStrategy === "email_code"
      ) {
        await set(commitResource$, resource, signal);
        signal.throwIfAborted();
        return;
      }

      set(atoms.selectedFactor$, clientTrustFactor);
      set(atoms.code$, "");
      const prepared = await settle(
        resource.prepareSecondFactor(clientTrustPreparation(clientTrustFactor)),
        signal,
      );
      if (!prepared.ok) {
        await set(commitResource$, resource, signal);
        signal.throwIfAborted();
        set(atoms.error$, normalizeClerkError(prepared.error, "code"));
        return;
      }
      set(runtime.preparedFactorId$, clientTrustFactor.id);
      await set(commitResource$, prepared.value, signal);
      signal.throwIfAborted();
      set(startCooldown$, clientTrustFactor.id, signal);
    },
  );

  const initialize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (!clerk.client) {
        throw new Error(
          "Loaded Clerk instance did not provide a client resource",
        );
      }
      const capabilities = discoverAuthV2ExternalCapabilities(clerk);
      set(atoms.capabilities$, capabilities);
      const passkeyOffered =
        capabilities.passkey ||
        clerk.client.signIn.supportedFirstFactors?.some((factor) => {
          return factor.strategy === "passkey";
        }) === true;
      const detectedPasskeyCapability = passkeyOffered
        ? await discoverAuthV2PasskeyCapability()
        : "unknown";
      signal.throwIfAborted();
      const passkeyCapability =
        get(atoms.passkeyCapability$) === "unavailable"
          ? "unavailable"
          : detectedPasskeyCapability;
      set(atoms.passkeyCapability$, passkeyCapability);
      if (passkeyOffered && passkeyCapability === "unavailable") {
        set(atoms.error$, { code: "passkey-unavailable", field: "general" });
      }

      if (dependencies.isOAuthCallbackRoute) {
        const recovery = await settle(
          recoverAuthV2OAuth(clerk, dependencies.navigation),
          signal,
        );
        if (!recovery.ok) {
          set(atoms.error$, normalizeClerkError(recovery.error, "general"));
        } else if (recovery.value) {
          // handleRedirectCallback activates completed OAuth sessions itself.
          // Remember that ownership boundary so applyResource$ cannot hand the
          // same session to the continuation controller a second time.
          set(runtime.handledSessionId$, recovery.value);
          await set(dependencies.continuation.recover$, signal);
          signal.throwIfAborted();
        }
      }

      signal.throwIfAborted();
      set(atoms.accounts$, discoverAuthV2ExistingAccounts(clerk));
      await set(applyResource$, clerk.client.signIn, signal);
      signal.throwIfAborted();
    },
  );
  return { applyResource$, initialize$ };
}

function createCoalescedOperation$<Key extends CoalescedOperation>(
  runtime: SignInFlowRuntime,
  key: Key,
  operation$: Command<Promise<void>, [AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = get(runtime.inFlight$).get(key);
    if (current) {
      await current;
      signal.throwIfAborted();
      return;
    }
    const operation = set(operation$, signal);
    set(runtime.inFlight$, (operations) => {
      return new Map(operations).set(key, operation);
    });
    await withCleanup(operation, () => {
      set(runtime.inFlight$, (operations) => {
        if (operations.get(key) !== operation) {
          return operations;
        }
        const remaining = new Map(operations);
        remaining.delete(key);
        return remaining;
      });
    });
    signal.throwIfAborted();
  });
}

function prepareSignInSubmission(
  flowState: AuthV2IncompleteSignInState,
  resource: SignInResource,
  values: SignInSubmitValues,
): SignInSubmitPreparation | null {
  switch (flowState.step) {
    case "identifier": {
      if (!values.identifier) {
        return null;
      }
      return {
        error: null,
        fallbackField: "identifier",
        request: resource.create({ identifier: values.identifier }),
      };
    }
    case "password": {
      if (!values.password) {
        return null;
      }
      return {
        error: null,
        fallbackField: "password",
        request: resource.attemptFirstFactor({
          password: values.password,
          strategy: "password",
        }),
      };
    }
    case "email-code": {
      if (!values.code) {
        return null;
      }
      return {
        error: null,
        fallbackField: "code",
        request: resource.attemptFirstFactor({
          code: values.code,
          strategy: "email_code",
        }),
      };
    }
    case "client-trust-code": {
      if (!values.code) {
        return null;
      }
      return {
        error: null,
        fallbackField: "code",
        request: resource.attemptSecondFactor({
          code: values.code,
          strategy: "email_code",
        }),
      };
    }
    case "password-reset-code": {
      if (!values.code) {
        return null;
      }
      return {
        error: null,
        fallbackField: "code",
        request: resource.attemptFirstFactor({
          code: values.code,
          strategy: "reset_password_email_code",
        }),
      };
    }
    case "new-password": {
      if (!values.newPassword) {
        return null;
      }
      if (values.newPassword !== values.confirmPassword) {
        return {
          error: { code: "password-mismatch", field: "new-password" },
          fallbackField: "new-password",
          request: null,
        };
      }
      return {
        error: null,
        fallbackField: "new-password",
        request: resource.resetPassword({
          password: values.newPassword,
          signOutOfOtherSessions: values.signOutOfOtherSessions,
        }),
      };
    }
    default: {
      return null;
    }
  }
}

function createSubmitOperation$(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const flowState = get(atoms.state$);
    if (flowState.status !== "incomplete") {
      return;
    }

    const resource = await get(clerkSignInResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);
    const preparation = prepareSignInSubmission(flowState, resource, {
      code: get(atoms.code$).trim(),
      confirmPassword: get(atoms.confirmPassword$),
      identifier: get(atoms.identifier$).trim(),
      newPassword: get(atoms.newPassword$),
      password: get(atoms.password$),
      signOutOfOtherSessions: get(atoms.signOutOfOtherSessions$),
    });
    if (!preparation) {
      return;
    }
    if (preparation.error) {
      set(atoms.error$, preparation.error);
      return;
    }
    if (flowState.step === "identifier") {
      set(runtime.preparedFactorId$, null);
    }

    const result = await settle(preparation.request, signal);
    if (!result.ok) {
      set(
        atoms.error$,
        normalizeClerkError(result.error, preparation.fallbackField),
      );
      return;
    }
    if (flowState.step === "identifier") {
      set(atoms.editIdentifier$, false);
      set(atoms.helpOrigin$, null);
      set(atoms.methodChooser$, false);
      set(atoms.selectedFactor$, null);
      set(atoms.passwordRecovery$, false);
    }
    await set(applyResource$, result.value, signal);
    signal.throwIfAborted();
    if (flowState.step === "identifier") {
      const snapshot = get(atoms.snapshot$);
      const passwordFactor = snapshot?.factors.find((factor) => {
        return factor.kind === "password";
      });
      if (
        snapshot?.clerkStatus === "needs_first_factor" &&
        passwordFactor &&
        get(atoms.selectedFactor$) === null
      ) {
        set(atoms.selectedFactor$, passwordFactor);
      }
    }
  });
}

function factorPreparation(
  factor: Extract<
    AuthV2SignInFactor,
    { kind: "email-code" | "password-reset" }
  >,
): PrepareFirstFactorParams {
  return {
    emailAddressId: factor.emailAddressId,
    strategy:
      factor.kind === "email-code" ? "email_code" : "reset_password_email_code",
  };
}

function clientTrustPreparation(
  factor: Extract<AuthV2SignInFactor, { kind: "client-trust-email-code" }>,
): PrepareSecondFactorParams {
  return {
    emailAddressId: factor.emailAddressId,
    strategy: "email_code",
  };
}

function createFactorSelectionCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
  startCooldown$: Command<void, [string, AbortSignal]>,
  dependencies: AuthV2SignInFlowDependencies,
): Command<Promise<void>, [string, AbortSignal]> {
  const prepareFactorOperation$ = command(
    async (
      { get, set },
      factorId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = get(atoms.snapshot$);
      const factor = snapshot?.factors.find((candidate) => {
        return candidate.id === factorId;
      });
      if (!snapshot || !factor) {
        set(atoms.fatalState$, {
          clerkStatus: snapshot?.clerkStatus ?? null,
          reason: "unsupported-factor",
          status: "unknown",
        });
        return;
      }

      set(atoms.error$, null);
      set(atoms.code$, "");
      if (factor.kind === "password") {
        set(atoms.methodChooser$, false);
        set(atoms.passwordRecovery$, false);
        set(atoms.selectedFactor$, factor);
        return;
      }

      const resource = await get(clerkSignInResource$);
      signal.throwIfAborted();
      if (factor.kind === "oauth") {
        const redirect = await settle(
          startAuthV2OAuth(resource, dependencies.navigation, factor.strategy),
          signal,
        );
        if (!redirect.ok) {
          set(atoms.error$, normalizeClerkError(redirect.error, "general"));
        }
        return;
      }
      if (factor.kind === "passkey") {
        const [authentication] = await Promise.allSettled([
          resource.authenticateWithPasskey({ flow: "discoverable" }),
        ]);
        signal.throwIfAborted();
        if (authentication.status === "rejected") {
          const normalizedError = normalizeClerkError(
            authentication.reason,
            "general",
          );
          set(atoms.error$, normalizedError);
          if (normalizedError.code === "passkey-unavailable") {
            set(atoms.passkeyCapability$, "unavailable");
            await set(applyResource$, resource, signal);
            signal.throwIfAborted();
          }
          return;
        }
        await set(applyResource$, authentication.value, signal);
        signal.throwIfAborted();
        set(atoms.methodChooser$, false);
        set(atoms.passwordRecovery$, false);
        return;
      }
      if (get(runtime.preparedFactorId$) === factor.id) {
        set(atoms.methodChooser$, false);
        set(atoms.passwordRecovery$, false);
        set(atoms.selectedFactor$, factor);
        return;
      }
      const preparation =
        factor.kind === "client-trust-email-code"
          ? resource.prepareSecondFactor(clientTrustPreparation(factor))
          : resource.prepareFirstFactor(factorPreparation(factor));
      const prepared = await settle(preparation, signal);
      if (!prepared.ok) {
        set(atoms.error$, normalizeClerkError(prepared.error, "general"));
        return;
      }
      set(runtime.preparedFactorId$, factor.id);
      await set(applyResource$, prepared.value, signal);
      signal.throwIfAborted();
      set(atoms.methodChooser$, false);
      set(atoms.passwordRecovery$, false);
      set(atoms.selectedFactor$, factor);
      set(startCooldown$, factor.id, signal);
    },
  );

  return command(
    async (
      { get, set },
      factorId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(runtime.inFlight$).get("resource");
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      set(atoms.pendingFactorId$, factorId);
      const operation = set(prepareFactorOperation$, factorId, signal);
      set(runtime.inFlight$, (operations) => {
        return new Map(operations).set("resource", operation);
      });
      await withCleanup(operation, () => {
        set(runtime.inFlight$, (operations) => {
          if (operations.get("resource") !== operation) {
            return operations;
          }
          const remaining = new Map(operations);
          remaining.delete("resource");
          return remaining;
        });
        set(atoms.pendingFactorId$, (pendingFactorId) => {
          return pendingFactorId === factorId ? null : pendingFactorId;
        });
      });
      signal.throwIfAborted();
    },
  );
}

function createSessionSelectionCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  completeSession$: Command<Promise<void>, [string, AbortSignal]>,
): Command<Promise<void>, [string, AbortSignal]> {
  const selectSessionOperation$ = command(
    async (
      { get, set },
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const account = get(atoms.accounts$).find((candidate) => {
        return candidate.sessionId === sessionId;
      });
      if (!account) {
        set(atoms.fatalState$, {
          clerkStatus: get(atoms.snapshot$)?.clerkStatus ?? null,
          reason: "missing-session",
          status: "unknown",
        });
        return;
      }

      set(atoms.error$, null);
      const activation = await settle(
        set(completeSession$, account.sessionId, signal),
        signal,
      );
      if (!activation.ok) {
        set(atoms.error$, normalizeClerkError(activation.error, "general"));
      }
    },
  );

  return command(
    async (
      { get, set },
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(runtime.inFlight$).get("resource");
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      const operation = set(selectSessionOperation$, sessionId, signal);
      set(runtime.inFlight$, (operations) => {
        return new Map(operations).set("resource", operation);
      });
      await withCleanup(operation, () => {
        set(runtime.inFlight$, (operations) => {
          if (operations.get("resource") !== operation) {
            return operations;
          }
          const remaining = new Map(operations);
          remaining.delete("resource");
          return remaining;
        });
      });
      signal.throwIfAborted();
    },
  );
}

function createGoogleOneTapCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
  dependencies: AuthV2SignInFlowDependencies,
): Command<Promise<void>, [AbortSignal]> {
  const exchangeCredentialOperation$ = command(
    async (
      { get, set },
      credential: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const resource = await get(clerkSignInResource$);
      signal.throwIfAborted();
      set(atoms.error$, null);
      const exchange = await settle(
        resource.create({
          signUpIfMissing: false,
          strategy: "google_one_tap",
          token: credential,
        }),
        signal,
      );
      if (!exchange.ok) {
        set(atoms.error$, normalizeClerkError(exchange.error, "general"));
        return;
      }
      await set(applyResource$, exchange.value, signal);
      signal.throwIfAborted();
    },
  );
  const exchangeCredential$ = command(
    async (
      { get, set },
      credential: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(runtime.inFlight$).get("resource");
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      const operation = set(exchangeCredentialOperation$, credential, signal);
      set(runtime.inFlight$, (operations) => {
        return new Map(operations).set("resource", operation);
      });
      await withCleanup(operation, () => {
        set(runtime.inFlight$, (operations) => {
          if (operations.get("resource") !== operation) {
            return operations;
          }
          const remaining = new Map(operations);
          remaining.delete("resource");
          return remaining;
        });
      });
      signal.throwIfAborted();
    },
  );
  const promptOperation$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (!dependencies.isBaseRoute) {
        return;
      }
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const clientId =
        discoverAuthV2ExternalCapabilities(clerk).googleOneTapClientId;
      if (!clientId) {
        return;
      }
      const credential = await settle(
        requestGoogleOneTapCredential(clientId, signal),
        signal,
      );
      if (!credential.ok) {
        if (isGoogleOneTapUnavailableError(credential.error)) {
          return;
        }
        set(atoms.error$, normalizeClerkError(credential.error, "general"));
        return;
      }
      if (!credential.value) {
        return;
      }
      await set(exchangeCredential$, credential.value, signal);
      signal.throwIfAborted();
    },
  );
  return createCoalescedOperation$(runtime, "one-tap", promptOperation$);
}

function createResendCodeOperation$(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
  startCooldown$: Command<void, [string, AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const factor = get(atoms.selectedFactor$);
    if (
      !factor ||
      (factor.kind !== "email-code" &&
        factor.kind !== "password-reset" &&
        factor.kind !== "client-trust-email-code")
    ) {
      return;
    }
    if (
      get(atoms.resendRemainingSeconds$) > 0 &&
      get(atoms.error$)?.code !== "code-expired"
    ) {
      return;
    }

    const resource = await get(clerkSignInResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);
    const preparation =
      factor.kind === "client-trust-email-code"
        ? resource.prepareSecondFactor(clientTrustPreparation(factor))
        : resource.prepareFirstFactor(factorPreparation(factor));
    const prepared = await settle(preparation, signal);
    if (!prepared.ok) {
      set(atoms.error$, normalizeClerkError(prepared.error, "code"));
      return;
    }
    set(runtime.preparedFactorId$, factor.id);
    set(atoms.code$, "");
    await set(applyResource$, prepared.value, signal);
    signal.throwIfAborted();
    set(startCooldown$, factor.id, signal);
  });
}

function createEntryNavigationCommands(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
) {
  const clearCooldown$ = command(({ set }): void => {
    set(signInResendCooldownStorage.clear$);
    set(runtime.cooldownDeadlineMs$, null);
    set(atoms.resendRemainingSeconds$, 0);
  });
  const backToMethods$ = command(({ set }) => {
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, true);
    set(atoms.passwordRecovery$, false);
    set(atoms.error$, null);
  });
  const backFromMethods$ = command(({ get, set }) => {
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, false);
    set(atoms.error$, null);
    if (get(atoms.selectedFactor$) === null) {
      set(atoms.editIdentifier$, true);
      set(atoms.useAnotherAccount$, true);
    }
  });
  const backToIdentifier$ = command(({ set }) => {
    set(clearCooldown$);
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, false);
    set(atoms.passwordRecovery$, false);
    set(atoms.editIdentifier$, true);
    set(atoms.useAnotherAccount$, true);
    set(atoms.selectedFactor$, null);
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, false);
    set(atoms.code$, "");
    set(atoms.password$, "");
    set(atoms.error$, null);
  });
  const restart$ = command(({ get, set }) => {
    set(clearCooldown$);
    set(runtime.preparedFactorId$, null);
    set(atoms.snapshot$, {
      clerkStatus: "needs_identifier",
      createdSessionId: null,
      factors: entryFactors(
        get(atoms.capabilities$),
        get(atoms.passkeyCapability$),
      ),
      firstFactorVerificationStatus: null,
      firstFactorVerificationStrategy: null,
      identifier: null,
      secondFactorVerificationStatus: null,
      secondFactorVerificationStrategy: null,
      identifierMode: get(atoms.capabilities$).identifierMode,
      transferable: false,
      unknownFactorStrategies: [],
    });
    set(atoms.selectedFactor$, null);
    set(atoms.passwordRecovery$, false);
    set(atoms.editIdentifier$, false);
    set(atoms.fatalState$, null);
    set(atoms.error$, null);
    set(atoms.identifierLocallyModified$, true);
    set(atoms.identifier$, "");
    set(atoms.password$, "");
    set(atoms.code$, "");
    set(atoms.newPassword$, "");
    set(atoms.confirmPassword$, "");
    set(atoms.signOutOfOtherSessions$, true);
    set(atoms.useAnotherAccount$, true);
  });
  const useAnotherAccount$ = command(({ set }) => {
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, false);
    set(atoms.passwordRecovery$, false);
    set(atoms.useAnotherAccount$, true);
    set(atoms.error$, null);
    set(atoms.identifierLocallyModified$, true);
    set(atoms.identifier$, "");
  });
  return {
    backFromMethods$,
    backToIdentifier$,
    backToMethods$,
    restart$,
    useAnotherAccount$,
  };
}

function createValueCommands(atoms: SignInFlowAtoms) {
  const setIdentifier$ = command(({ get, set }, value: string) => {
    if (get(atoms.identifier$) === value) {
      return;
    }
    set(atoms.identifierLocallyModified$, true);
    set(atoms.identifier$, value);
    set(atoms.error$, null);
  });
  const setPassword$ = command(({ get, set }, value: string) => {
    if (get(atoms.password$) === value) {
      return;
    }
    set(atoms.password$, value);
    set(atoms.error$, null);
  });
  const setCode$ = command(({ get, set }, value: string) => {
    if (get(atoms.code$) === value) {
      return;
    }
    set(atoms.code$, value);
    set(atoms.error$, null);
  });
  const setNewPassword$ = command(({ get, set }, value: string) => {
    if (get(atoms.newPassword$) === value) {
      return;
    }
    set(atoms.newPassword$, value);
    set(atoms.error$, null);
  });
  const setConfirmPassword$ = command(({ get, set }, value: string) => {
    if (get(atoms.confirmPassword$) === value) {
      return;
    }
    set(atoms.confirmPassword$, value);
    set(atoms.error$, null);
  });
  const setSignOutOfOtherSessions$ = command(({ get, set }, value: boolean) => {
    if (get(atoms.signOutOfOtherSessions$) === value) {
      return;
    }
    set(atoms.signOutOfOtherSessions$, value);
  });
  return {
    setCode$,
    setConfirmPassword$,
    setIdentifier$,
    setNewPassword$,
    setPassword$,
    setSignOutOfOtherSessions$,
  };
}

function createRecoveryPresentationCommands(
  atoms: SignInFlowAtoms,
  backToIdentifier$: Command<void, []>,
) {
  const showPasswordRecovery$ = command(({ get, set }) => {
    const snapshot = get(atoms.snapshot$);
    if (
      snapshot?.clerkStatus !== "needs_first_factor" ||
      !snapshot.factors.some((factor) => {
        return factor.kind === "password-reset";
      })
    ) {
      return;
    }
    set(atoms.helpOrigin$, null);
    set(atoms.methodChooser$, false);
    set(atoms.passwordRecovery$, true);
    set(atoms.error$, null);
  });
  const backFromPasswordRecovery$ = command(({ set }) => {
    set(atoms.helpOrigin$, null);
    set(atoms.passwordRecovery$, false);
    set(atoms.error$, null);
  });
  const backFromNewPassword$ = command(({ get, set }) => {
    const snapshot = get(atoms.snapshot$);
    if (snapshot?.clerkStatus !== "needs_new_password") {
      return;
    }
    set(backToIdentifier$);
    set(atoms.newPassword$, "");
    set(atoms.confirmPassword$, "");
    set(atoms.signOutOfOtherSessions$, true);
  });
  const showHelp$ = command(({ get, set }) => {
    const flowState = get(atoms.state$);
    if (flowState.status !== "incomplete") {
      return;
    }
    if (flowState.step === "password-recovery") {
      set(atoms.helpOrigin$, "password-recovery");
      set(atoms.error$, null);
      return;
    }
    if (flowState.step === "choose-factor") {
      set(atoms.helpOrigin$, "methods");
      set(atoms.error$, null);
    }
  });
  const backFromHelp$ = command(({ set }) => {
    set(atoms.helpOrigin$, null);
    set(atoms.error$, null);
  });
  return {
    backFromHelp$,
    backFromNewPassword$,
    backFromPasswordRecovery$,
    showHelp$,
    showPasswordRecovery$,
  };
}

function createFormCommands(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
) {
  const navigation = createEntryNavigationCommands(atoms, runtime);
  return {
    ...navigation,
    ...createRecoveryPresentationCommands(atoms, navigation.backToIdentifier$),
    ...createValueCommands(atoms),
  };
}

export function createAuthV2SignInSignals(
  dependencies: AuthV2SignInFlowDependencies,
): AuthV2SignInSignals {
  const atoms = createSignInFlowAtoms();
  const runtime = createSignInFlowRuntime();
  const startCooldown$ = createStartCooldownCommand(atoms, runtime);
  const { applyResource$, initialize$ } = createResourceCommands(
    atoms,
    runtime,
    startCooldown$,
    dependencies,
  );
  const submitOperation$ = createSubmitOperation$(
    atoms,
    runtime,
    applyResource$,
  );
  const resendCooldownLifecycleRef$ = createResendCooldownLifecycleRef(
    atoms,
    runtime,
  );
  const resendCodeOperation$ = createResendCodeOperation$(
    atoms,
    runtime,
    applyResource$,
    startCooldown$,
  );
  const formCommands = createFormCommands(atoms, runtime);
  const runGoogleOneTap$ = createGoogleOneTapCommand(
    atoms,
    runtime,
    applyResource$,
    dependencies,
  );
  const initializeWithExternalStrategies$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(initialize$, signal);
      signal.throwIfAborted();
      await set(runGoogleOneTap$, signal);
      signal.throwIfAborted();
    },
  );
  return {
    ...formCommands,
    code$: computed((get) => {
      return get(atoms.code$);
    }),
    confirmPassword$: computed((get) => {
      return get(atoms.confirmPassword$);
    }),
    error$: computed((get) => {
      return get(atoms.error$);
    }),
    identifier$: computed((get) => {
      return get(atoms.identifier$);
    }),
    initialize$: initializeWithExternalStrategies$,
    newPassword$: computed((get) => {
      return get(atoms.newPassword$);
    }),
    pendingFactorId$: computed((get) => {
      return get(atoms.pendingFactorId$);
    }),
    password$: computed((get) => {
      return get(atoms.password$);
    }),
    resendCode$: createCoalescedOperation$(
      runtime,
      "resource",
      resendCodeOperation$,
    ),
    resendCooldownLifecycleRef$,
    resendState$: computed((get) => {
      const remainingSeconds = get(atoms.resendRemainingSeconds$);
      return remainingSeconds > 0
        ? { remainingSeconds, status: "cooling-down" }
        : { remainingSeconds: 0, status: "ready" };
    }),
    selectFactor$: createFactorSelectionCommand(
      atoms,
      runtime,
      applyResource$,
      startCooldown$,
      dependencies,
    ),
    selectSession$: createSessionSelectionCommand(
      atoms,
      runtime,
      dependencies.continuation.completeSession$,
    ),
    signOutOfOtherSessions$: computed((get) => {
      return get(atoms.signOutOfOtherSessions$);
    }),
    state$: atoms.state$,
    submit$: createCoalescedOperation$(runtime, "resource", submitOperation$),
  };
}
