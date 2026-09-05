import type {
  Attribute,
  AttributeData,
  Attributes,
  PasswordValidation,
  SignUpCreateParams,
  SignUpField,
  SignUpResource,
} from "@clerk/react/types";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { timeout } from "signal-timers";

import { now } from "../../lib/time.ts";
import { clerk$ } from "../auth.ts";
import { locale$ } from "../locale.ts";
import { logger } from "../log.ts";
import {
  createChildAbortController,
  createDeferredPromise,
  isRecord,
  onRef,
  settle,
  stringProperty,
  withCleanup,
} from "../utils.ts";
import type { AuthV2ContinuationFlowHandoff } from "./continuation.ts";
import type { AuthV2Navigation } from "./navigation.ts";
import type { AuthV2OAuthStrategy } from "./oauth-strategies.ts";
import {
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_STORAGE_KEY,
  createAuthV2ResendCooldownStorage,
  createResendCooldownLifecycleRef,
  createStartCooldownCommand,
  type AuthV2ResendCooldown,
} from "./resend-cooldown.ts";
import {
  discoverAuthV2SignUpExternalCapabilities,
  recoverAuthV2OAuthSignUp,
  startAuthV2OAuthSignUp,
} from "./sign-up-external-strategies.ts";

const L = logger("AuthV2SignUp");

const signUpResendCooldownStorage = createAuthV2ResendCooldownStorage(
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_STORAGE_KEY,
);
const signUpResendCooldown: Readonly<AuthV2ResendCooldown> = {
  storage: signUpResendCooldownStorage,
  seconds: 30,
};

const SUPPORTED_SIGN_UP_ATTRIBUTES = [
  "email_address",
  "first_name",
  "last_name",
  "password",
] as const satisfies readonly Attribute[];

const SUPPORTED_SIGN_UP_FIELDS = [
  ...SUPPORTED_SIGN_UP_ATTRIBUTES,
  "legal_accepted",
] as const satisfies readonly SignUpField[];

type SupportedSignUpField = (typeof SUPPORTED_SIGN_UP_FIELDS)[number];
type FieldRequirement = "hidden" | "optional" | "required";

export interface AuthV2SignUpFields {
  readonly emailAddress: FieldRequirement;
  readonly firstName: FieldRequirement;
  readonly lastName: FieldRequirement;
  readonly password: FieldRequirement;
}

export interface AuthV2SignUpLegalConfig {
  readonly privacyPolicyUrl: string | null;
  readonly required: boolean;
  readonly termsUrl: string | null;
}

export type AuthV2SignUpVerificationState =
  | "expired"
  | "prepare-failed"
  | "preparing"
  | "ready";

export type AuthV2SignUpResendState =
  | { readonly remainingSeconds: 0; readonly status: "ready" }
  | { readonly remainingSeconds: number; readonly status: "cooling-down" };

export type AuthV2SignUpCaptchaState =
  | "blocked"
  | "error"
  | "expired"
  | "idle"
  | "loading";

export type AuthV2SignUpUnknownReason =
  | "missing-legal-configuration"
  | "missing-session"
  | "unsupported-field"
  | "unsupported-status";

export type AuthV2SignUpState =
  | { readonly status: "loading" }
  | {
      readonly captchaEnabled: boolean;
      readonly fields: AuthV2SignUpFields;
      readonly legal: AuthV2SignUpLegalConfig;
      readonly status: "incomplete";
      readonly step: "details";
    }
  | {
      readonly emailAddress: string;
      readonly status: "incomplete";
      readonly step: "email-code";
      readonly verification: AuthV2SignUpVerificationState;
    }
  | { readonly status: "complete" }
  | { readonly status: "transfer" }
  | {
      readonly clerkStatus: string | null;
      readonly reason: AuthV2SignUpUnknownReason;
      readonly status: "unknown";
    };

export type AuthV2SignUpErrorField =
  | "captcha"
  | "code"
  | "email-address"
  | "first-name"
  | "general"
  | "last-name"
  | "legal"
  | "password";

export interface AuthV2SignUpError {
  readonly clerkCode?: string;
  readonly code: "clerk" | "legal-required" | "password-invalid" | "unknown";
  readonly field: AuthV2SignUpErrorField;
  readonly message?: string;
}

interface AuthV2SignUpFlowDependencies {
  readonly continuation: Pick<
    AuthV2ContinuationFlowHandoff,
    "completeSession$"
  >;
  readonly isOAuthCallbackRoute: boolean;
  readonly navigation: AuthV2Navigation;
}

export interface AuthV2SignUpSignals {
  readonly backToDetails$: Command<void, []>;
  readonly captchaRef$: ReturnType<typeof onRef<HTMLDivElement>>;
  readonly captchaState$: Computed<AuthV2SignUpCaptchaState>;
  readonly code$: Computed<string>;
  readonly emailAddress$: Computed<string>;
  readonly error$: Computed<AuthV2SignUpError | null>;
  readonly firstName$: Computed<string>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly lastName$: Computed<string>;
  readonly legalAccepted$: Computed<boolean>;
  readonly oauthStrategies$: Computed<readonly AuthV2OAuthStrategy[]>;
  readonly pendingOAuthStrategy$: Computed<AuthV2OAuthStrategy | null>;
  readonly password$: Computed<string>;
  readonly resendCode$: Command<Promise<void>, [AbortSignal]>;
  readonly resendCooldownLifecycleRef$: ReturnType<
    typeof onRef<HTMLSpanElement>
  >;
  readonly resendState$: Computed<AuthV2SignUpResendState>;
  readonly restart$: Command<Promise<void>, [AbortSignal]>;
  readonly setCode$: Command<void, [string]>;
  readonly setEmailAddress$: Command<void, [string]>;
  readonly setFirstName$: Command<void, [string]>;
  readonly setLastName$: Command<void, [string]>;
  readonly setLegalAccepted$: Command<void, [boolean]>;
  readonly setPassword$: Command<void, [string]>;
  readonly state$: Computed<AuthV2SignUpState>;
  readonly startOAuth$: Command<
    Promise<void>,
    [AuthV2OAuthStrategy, AbortSignal]
  >;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
}

interface SignUpConfiguration {
  readonly attributes: Attributes;
  readonly captchaEnabled: boolean;
  readonly legalConsentEnabled: boolean;
  readonly privacyPolicyUrl: string | null;
  readonly progressive: boolean;
  readonly termsUrl: string | null;
}

interface SignUpVerificationSnapshot {
  readonly expireAtMs: number | null;
  readonly status: string | null;
  readonly strategy: string | null;
}

interface SignUpResourceSnapshot {
  readonly captchaEnabled: boolean;
  readonly clerkStatus: string | null;
  readonly createdSessionId: string | null;
  readonly emailAddress: string | null;
  readonly fields: AuthV2SignUpFields;
  readonly legal: AuthV2SignUpLegalConfig;
  readonly missingFields: readonly SignUpField[];
  readonly transferable: boolean;
  readonly unsupportedFields: readonly string[];
  readonly unverifiedEmailAddress: boolean;
  readonly verification: SignUpVerificationSnapshot;
}

type AuthV2SignUpUnknownState = Extract<
  AuthV2SignUpState,
  { status: "unknown" }
>;

interface SignUpFlowAtoms {
  readonly captchaPending$: State<boolean>;
  readonly captchaState$: State<AuthV2SignUpCaptchaState>;
  readonly code$: State<string>;
  readonly editDetails$: State<boolean>;
  readonly emailAddress$: State<string>;
  readonly error$: State<AuthV2SignUpError | null>;
  readonly fatalState$: State<AuthV2SignUpUnknownState | null>;
  readonly firstName$: State<string>;
  readonly lastName$: State<string>;
  readonly legalAccepted$: State<boolean>;
  readonly oauthStrategies$: State<readonly AuthV2OAuthStrategy[]>;
  readonly pendingOAuthStrategy$: State<AuthV2OAuthStrategy | null>;
  readonly password$: State<string>;
  readonly preparationState$: State<"failed" | "idle" | "preparing">;
  readonly resendRemainingSeconds$: State<number>;
  readonly snapshot$: State<SignUpResourceSnapshot | null>;
  readonly state$: Computed<AuthV2SignUpState>;
  readonly verificationExpired$: State<boolean>;
}

interface SignUpFlowRuntime {
  readonly automaticPreparationAttempted$: State<boolean>;
  readonly cooldownDeadlineMs$: State<number | null>;
  readonly expiryController$: State<AbortController | null>;
  readonly inFlight$: State<Promise<void> | null>;
}

type ApplySignUpResourceCommand = Command<
  Promise<void>,
  [SignUpResource, AbortSignal]
>;
type PrepareEmailVerificationCommand = Command<
  Promise<void>,
  [SignUpResource, boolean, AbortSignal]
>;

interface SignUpResourceCommands {
  readonly applyResource$: ApplySignUpResourceCommand;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly prepareEmailVerification$: PrepareEmailVerificationCommand;
}

function fieldRequirement(
  field: SupportedSignUpField,
  requiredFields: ReadonlySet<SignUpField>,
  optionalFields: ReadonlySet<SignUpField>,
): FieldRequirement {
  if (requiredFields.has(field)) {
    return "required";
  }
  return optionalFields.has(field) ? "optional" : "hidden";
}

interface ConfiguredIdentifierRequirements {
  readonly emailAddress: boolean;
  readonly phoneNumber: boolean;
  readonly username: boolean;
}

interface ConfiguredIdentifierAttribute {
  readonly enabled: boolean;
  readonly firstFactor: boolean;
  readonly required: boolean;
}

function configuredEmailIdentifierRequired(
  email: ConfiguredIdentifierAttribute,
  phone: ConfiguredIdentifierAttribute,
  username: ConfiguredIdentifierAttribute,
): boolean {
  return (
    (email.enabled && !phone.enabled && !username.enabled) ||
    (email.enabled && !email.required && phone.enabled && !phone.required) ||
    (username.firstFactor &&
      !username.required &&
      email.enabled &&
      !email.required) ||
    (username.required &&
      !username.firstFactor &&
      email.enabled &&
      phone.enabled)
  );
}

function configuredPhoneIdentifierRequired(
  email: ConfiguredIdentifierAttribute,
  phone: ConfiguredIdentifierAttribute,
  username: ConfiguredIdentifierAttribute,
): boolean {
  return (
    (phone.enabled && !email.required && !phone.required) ||
    (username.firstFactor &&
      !username.required &&
      phone.enabled &&
      !phone.required) ||
    (phone.firstFactor && !email.firstFactor && !username.firstFactor) ||
    (username.required &&
      !username.firstFactor &&
      phone.enabled &&
      email.enabled) ||
    (!email.enabled && phone.enabled && username.enabled)
  );
}

function configuredUsernameIdentifierRequired(
  email: ConfiguredIdentifierAttribute,
  phone: ConfiguredIdentifierAttribute,
  username: ConfiguredIdentifierAttribute,
): boolean {
  return (
    (username.enabled &&
      username.firstFactor &&
      !email.enabled &&
      !phone.enabled) ||
    (username.required &&
      !username.firstFactor &&
      email.enabled &&
      phone.enabled)
  );
}

function configuredIdentifierRequirements(
  attributes: Attributes,
): ConfiguredIdentifierRequirements {
  const email = {
    enabled: attributes.email_address.enabled,
    firstFactor: attributes.email_address.used_for_first_factor,
    required: attributes.email_address.required,
  };
  const phone = {
    enabled: attributes.phone_number.enabled,
    firstFactor: attributes.phone_number.used_for_first_factor,
    required: attributes.phone_number.required,
  };
  const username = {
    enabled: attributes.username.enabled,
    firstFactor: attributes.username.used_for_first_factor,
    required: attributes.username.required,
  };
  const passwordRequired =
    attributes.password.enabled && attributes.password.required;

  if (
    !passwordRequired ||
    email.required ||
    phone.required ||
    (username.required && username.firstFactor)
  ) {
    return {
      emailAddress: email.required,
      phoneNumber: phone.required,
      username: username.required,
    };
  }
  if (!email.enabled && !phone.enabled && !username.enabled) {
    return { emailAddress: false, phoneNumber: false, username: false };
  }

  const emailAddress = configuredEmailIdentifierRequired(
    email,
    phone,
    username,
  );
  const phoneNumber = configuredPhoneIdentifierRequired(email, phone, username);
  const usernameRequired = configuredUsernameIdentifierRequired(
    email,
    phone,
    username,
  );

  if (!emailAddress && !phoneNumber && !usernameRequired) {
    return { emailAddress: true, phoneNumber: false, username: false };
  }
  return {
    emailAddress,
    phoneNumber,
    username: usernameRequired,
  };
}

function requiredAttributeRequirement(
  attribute: AttributeData,
): FieldRequirement {
  return attribute.enabled && attribute.required ? "required" : "hidden";
}

function configuredSignUpFields(
  configuration: SignUpConfiguration,
): AuthV2SignUpFields {
  const { attributes } = configuration;
  const identifierRequirements = configuredIdentifierRequirements(attributes);
  const emailEnabled =
    attributes.email_address.enabled &&
    (configuration.progressive ||
      attributes.email_address.used_for_first_factor);
  return {
    emailAddress: emailEnabled
      ? configuration.progressive
        ? identifierRequirements.emailAddress
          ? "required"
          : "optional"
        : "required"
      : "hidden",
    firstName: requiredAttributeRequirement(attributes.first_name),
    lastName: requiredAttributeRequirement(attributes.last_name),
    password:
      attributes.password.enabled && attributes.password.required
        ? "required"
        : "hidden",
  };
}

function resourceSignUpFields(resource: SignUpResource): AuthV2SignUpFields {
  const requiredFields = new Set(resource.requiredFields);
  const optionalFields = new Set(resource.optionalFields);
  return {
    emailAddress: fieldRequirement(
      "email_address",
      requiredFields,
      optionalFields,
    ),
    firstName: requiredFields.has("first_name") ? "required" : "hidden",
    lastName: requiredFields.has("last_name") ? "required" : "hidden",
    password: resource.hasPassword
      ? "hidden"
      : fieldRequirement("password", requiredFields, optionalFields),
  };
}

function usesConfiguredInitialRequirements(resource: SignUpResource): boolean {
  return (
    resource.status === null &&
    resource.requiredFields.length === 0 &&
    resource.optionalFields.length === 0 &&
    resource.missingFields.length === 0
  );
}

function signUpFields(
  resource: SignUpResource,
  configuration: SignUpConfiguration,
): AuthV2SignUpFields {
  return usesConfiguredInitialRequirements(resource)
    ? configuredSignUpFields(configuration)
    : resourceSignUpFields(resource);
}

function unsupportedConfiguredSignUpFields(
  configuration: SignUpConfiguration,
): readonly string[] {
  const supportedAttributes = new Set<string>(SUPPORTED_SIGN_UP_ATTRIBUTES);
  return Object.entries(configuration.attributes)
    .filter(([attributeName, attribute]) => {
      return (
        attribute.enabled &&
        attribute.required &&
        !supportedAttributes.has(attributeName)
      );
    })
    .map(([attributeName]) => {
      return attributeName;
    });
}

function unsupportedSignUpFields(
  resource: SignUpResource,
  configuration: SignUpConfiguration,
): readonly string[] {
  if (usesConfiguredInitialRequirements(resource)) {
    return unsupportedConfiguredSignUpFields(configuration);
  }
  const supportedFields = new Set<SignUpField>(SUPPORTED_SIGN_UP_FIELDS);
  return [...resource.requiredFields, ...resource.missingFields].filter(
    (field, index, fields) => {
      return !supportedFields.has(field) && fields.indexOf(field) === index;
    },
  );
}

function snapshotSignUpResource(
  resource: SignUpResource,
  configuration: SignUpConfiguration,
): SignUpResourceSnapshot {
  const verification = resource.verifications.emailAddress;
  const configuredInitialRequirements =
    usesConfiguredInitialRequirements(resource);
  const legalRequired = configuredInitialRequirements
    ? configuration.legalConsentEnabled
    : resource.requiredFields.includes("legal_accepted") &&
      resource.missingFields.includes("legal_accepted");
  return {
    captchaEnabled: configuration.captchaEnabled,
    clerkStatus: resource.status,
    createdSessionId: resource.createdSessionId,
    emailAddress: resource.emailAddress,
    fields: signUpFields(resource, configuration),
    legal: {
      privacyPolicyUrl: configuration.privacyPolicyUrl,
      required: legalRequired,
      termsUrl: configuration.termsUrl,
    },
    missingFields: [...resource.missingFields],
    transferable: resource.__internal_future.isTransferable,
    unsupportedFields: unsupportedSignUpFields(resource, configuration),
    unverifiedEmailAddress: resource.unverifiedFields.includes("email_address"),
    verification: {
      expireAtMs: verification.expireAt?.getTime() ?? null,
      status: verification.status,
      strategy: verification.strategy,
    },
  };
}

function clerkErrorField(
  error: Record<string, unknown>,
  fallbackField: AuthV2SignUpErrorField,
): AuthV2SignUpErrorField {
  const meta = error.meta;
  const parameter = isRecord(meta) ? stringProperty(meta, "paramName") : null;
  if (parameter === "email_address" || parameter === "emailAddress") {
    return "email-address";
  }
  if (parameter === "first_name" || parameter === "firstName") {
    return "first-name";
  }
  if (parameter === "last_name" || parameter === "lastName") {
    return "last-name";
  }
  if (parameter === "legal_accepted" || parameter === "legalAccepted") {
    return "legal";
  }
  if (parameter === "password") {
    return "password";
  }
  if (parameter === "code") {
    return "code";
  }
  if (parameter === "captcha") {
    return "captcha";
  }
  return fallbackField;
}

function normalizeClerkError(
  error: unknown,
  fallbackField: AuthV2SignUpErrorField,
): AuthV2SignUpError {
  if (isRecord(error) && Array.isArray(error.errors)) {
    const firstError = error.errors.find(isRecord);
    if (firstError) {
      const message =
        stringProperty(firstError, "longMessage") ??
        stringProperty(firstError, "message");
      const clerkCode = stringProperty(firstError, "code");
      return {
        ...(clerkCode ? { clerkCode } : {}),
        code: "clerk",
        field: clerkErrorField(firstError, fallbackField),
        ...(message ? { message } : {}),
      };
    }
  }
  return { code: "unknown", field: fallbackField };
}

function isExpiredError(error: AuthV2SignUpError): boolean {
  const code = error.clerkCode?.toLowerCase();
  return (
    code?.includes("expired") === true || code?.includes("timeout") === true
  );
}

function captchaFailureState(
  error: AuthV2SignUpError,
): AuthV2SignUpCaptchaState | null {
  const code = error.clerkCode?.toLowerCase();
  if (!code?.includes("captcha")) {
    return error.field === "captcha" ? "error" : null;
  }
  return code.includes("expired") ||
    code.includes("timeout") ||
    code === "captcha_invalid"
    ? "expired"
    : "error";
}

function passwordValidationFailed(validation: PasswordValidation): boolean {
  return (
    Object.values(validation.complexity ?? {}).some(Boolean) ||
    validation.strength?.state === "fail"
  );
}

function validatePassword(
  resource: SignUpResource,
  password: string,
  signal: AbortSignal,
): Promise<boolean> {
  const validation = createDeferredPromise<boolean>(signal);
  resource.validatePassword(password, {
    onValidation: (result) => {
      if (!validation.settled()) {
        validation.resolve(passwordValidationFailed(result));
      }
    },
  });
  return validation.promise;
}

function hasDetailsToCollect(snapshot: SignUpResourceSnapshot): boolean {
  return snapshot.clerkStatus === null || snapshot.missingFields.length > 0;
}

function unknownSignUpState(
  snapshot: SignUpResourceSnapshot,
  reason: AuthV2SignUpUnknownReason,
): AuthV2SignUpUnknownState {
  return { clerkStatus: snapshot.clerkStatus, reason, status: "unknown" };
}

function hasMissingLegalConfiguration(
  snapshot: SignUpResourceSnapshot,
): boolean {
  return (
    snapshot.legal.required &&
    !snapshot.legal.termsUrl &&
    !snapshot.legal.privacyPolicyUrl
  );
}

function verificationState(
  snapshot: SignUpResourceSnapshot,
  preparationState: "failed" | "idle" | "preparing",
  verificationExpired: boolean,
): AuthV2SignUpVerificationState {
  if (verificationExpired || snapshot.verification.status === "expired") {
    return "expired";
  }
  if (preparationState === "preparing") {
    return "preparing";
  }
  return preparationState === "failed" ? "prepare-failed" : "ready";
}

function incompleteSignUpState(
  snapshot: SignUpResourceSnapshot,
  editDetails: boolean,
  preparationState: "failed" | "idle" | "preparing",
  verificationExpired: boolean,
): AuthV2SignUpState {
  if (
    (editDetails || !snapshot.unverifiedEmailAddress) &&
    (editDetails || hasDetailsToCollect(snapshot))
  ) {
    return {
      captchaEnabled: snapshot.captchaEnabled,
      fields: snapshot.fields,
      legal: snapshot.legal,
      status: "incomplete",
      step: "details",
    };
  }
  if (snapshot.unverifiedEmailAddress && snapshot.emailAddress) {
    return {
      emailAddress: snapshot.emailAddress,
      status: "incomplete",
      step: "email-code",
      verification: verificationState(
        snapshot,
        preparationState,
        verificationExpired,
      ),
    };
  }
  return unknownSignUpState(snapshot, "unsupported-status");
}

function deriveSignUpFlowState(
  snapshot: SignUpResourceSnapshot | null,
  editDetails: boolean,
  preparationState: "failed" | "idle" | "preparing",
  verificationExpired: boolean,
  fatalState: AuthV2SignUpUnknownState | null,
): AuthV2SignUpState {
  if (fatalState) {
    return fatalState;
  }
  if (!snapshot) {
    return { status: "loading" };
  }
  if (snapshot.transferable) {
    return { status: "transfer" };
  }
  if (snapshot.unsupportedFields.length > 0) {
    return unknownSignUpState(snapshot, "unsupported-field");
  }
  if (hasMissingLegalConfiguration(snapshot)) {
    return unknownSignUpState(snapshot, "missing-legal-configuration");
  }
  if (snapshot.clerkStatus === "complete") {
    return snapshot.createdSessionId
      ? { status: "complete" }
      : unknownSignUpState(snapshot, "missing-session");
  }
  if (
    snapshot.clerkStatus !== null &&
    snapshot.clerkStatus !== "missing_requirements"
  ) {
    return unknownSignUpState(snapshot, "unsupported-status");
  }
  return incompleteSignUpState(
    snapshot,
    editDetails,
    preparationState,
    verificationExpired,
  );
}

function createSignUpFlowAtoms(): SignUpFlowAtoms {
  const snapshot$ = state<SignUpResourceSnapshot | null>(null);
  const editDetails$ = state(false);
  const preparationState$ = state<"failed" | "idle" | "preparing">("idle");
  const verificationExpired$ = state(false);
  const fatalState$ = state<AuthV2SignUpUnknownState | null>(null);
  const error$ = state<AuthV2SignUpError | null>(null);
  const emailAddress$ = state("");
  const password$ = state("");
  const firstName$ = state("");
  const oauthStrategies$ = state<readonly AuthV2OAuthStrategy[]>([]);
  const pendingOAuthStrategy$ = state<AuthV2OAuthStrategy | null>(null);
  const lastName$ = state("");
  const legalAccepted$ = state(false);
  const code$ = state("");
  const captchaState$ = state<AuthV2SignUpCaptchaState>("idle");
  const captchaPending$ = state(false);
  const resendRemainingSeconds$ = state(0);
  const state$ = computed((get) => {
    return deriveSignUpFlowState(
      get(snapshot$),
      get(editDetails$),
      get(preparationState$),
      get(verificationExpired$),
      get(fatalState$),
    );
  });
  return {
    captchaPending$,
    captchaState$,
    code$,
    editDetails$,
    emailAddress$,
    error$,
    fatalState$,
    firstName$,
    lastName$,
    legalAccepted$,
    oauthStrategies$,
    pendingOAuthStrategy$,
    password$,
    preparationState$,
    resendRemainingSeconds$,
    snapshot$,
    state$,
    verificationExpired$,
  };
}

function createSignUpFlowRuntime(): SignUpFlowRuntime {
  return {
    automaticPreparationAttempted$: state(false),
    cooldownDeadlineMs$: state<number | null>(null),
    expiryController$: state<AbortController | null>(null),
    inFlight$: state<Promise<void> | null>(null),
  };
}

const clerkSignUpResource$ = computed(async (get) => {
  const clerk = await get(clerk$);
  if (!clerk.client) {
    throw new Error("Loaded Clerk instance did not provide a client resource");
  }
  return clerk.client.signUp;
});

const clerkSignUpConfiguration$ = computed(async (get) => {
  const clerk = await get(clerk$);
  const environment = clerk.__internal_environment;
  if (!environment) {
    throw new Error(
      "Loaded Clerk instance did not provide environment configuration",
    );
  }
  const { displayConfig, userSettings } = environment;
  return {
    attributes: userSettings.attributes,
    captchaEnabled:
      displayConfig.captchaWidgetType !== null &&
      (displayConfig.captchaPublicKey !== null ||
        displayConfig.captchaPublicKeyInvisible !== null),
    legalConsentEnabled: userSettings.signUp.legal_consent_enabled,
    privacyPolicyUrl: displayConfig.privacyPolicyUrl || null,
    progressive: userSettings.signUp.progressive,
    termsUrl: displayConfig.termsUrl || null,
  } satisfies SignUpConfiguration;
});

function createScheduleExpiryCommand(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
): Command<void, [number | null, AbortSignal]> {
  return command(
    ({ get, set }, expireAtMs: number | null, signal: AbortSignal): void => {
      signal.throwIfAborted();
      get(runtime.expiryController$)?.abort();
      set(runtime.expiryController$, null);
      set(atoms.verificationExpired$, false);
      if (expireAtMs === null) {
        return;
      }
      const delay = Math.max(0, expireAtMs - now());
      if (delay === 0) {
        set(atoms.verificationExpired$, true);
        return;
      }
      const controller = createChildAbortController(signal);
      set(runtime.expiryController$, controller);
      controller.signal.addEventListener(
        "abort",
        () => {
          if (get(runtime.expiryController$) === controller) {
            set(runtime.expiryController$, null);
          }
        },
        { once: true },
      );
      timeout(
        () => {
          if (get(runtime.expiryController$) !== controller) {
            return;
          }
          set(atoms.verificationExpired$, true);
          controller.abort();
        },
        delay,
        { signal: controller.signal },
      );
    },
  );
}

function createInitializeCommand(
  atoms: SignUpFlowAtoms,
  dependencies: AuthV2SignUpFlowDependencies,
  applyResource$: ApplySignUpResourceCommand,
  prepareEmailVerification$: PrepareEmailVerificationCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.client) {
      throw new Error(
        "Loaded Clerk instance did not provide a client resource",
      );
    }
    let resource = clerk.client.signUp;
    let recoveredSessionId: string | null = null;
    if (dependencies.isOAuthCallbackRoute) {
      set(atoms.error$, null);
      const recovery = await settle(recoverAuthV2OAuthSignUp(clerk), signal);
      if (recovery.ok) {
        if (recovery.value.status === "sign-in") {
          window.location.assign(
            dependencies.navigation.href(
              "sign-in",
              recovery.value.stepPath ?? undefined,
            ),
          );
          return;
        }
        resource = recovery.value.resource;
        if (recovery.value.status === "complete") {
          recoveredSessionId = recovery.value.sessionId;
        } else if (recovery.value.status === "error") {
          const error = normalizeClerkError(
            { errors: [recovery.value.error] },
            "general",
          );
          L.warn(
            "Auth v2 OAuth sign-up callback returned an error",
            error.clerkCode ?? error.code,
          );
          set(atoms.error$, error);
        }
      } else {
        const error = normalizeClerkError(recovery.error, "general");
        L.warn(
          "Auth v2 OAuth sign-up callback recovery failed",
          error.clerkCode ?? error.code,
        );
        set(atoms.error$, error);
        resource = clerk.client.signUp;
      }
    }
    set(
      atoms.oauthStrategies$,
      discoverAuthV2SignUpExternalCapabilities(clerk, resource).oauthStrategies,
    );
    set(atoms.emailAddress$, resource.emailAddress ?? "");
    set(atoms.firstName$, resource.firstName ?? "");
    set(atoms.lastName$, resource.lastName ?? "");
    set(atoms.legalAccepted$, resource.legalAcceptedAt !== null);
    if (recoveredSessionId) {
      await set(
        dependencies.continuation.completeSession$,
        recoveredSessionId,
        signal,
      );
      signal.throwIfAborted();
      return;
    }
    await set(applyResource$, resource, signal);
    signal.throwIfAborted();
    await set(prepareEmailVerification$, resource, true, signal);
    signal.throwIfAborted();
  });
}

function createResourceCommands(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  dependencies: AuthV2SignUpFlowDependencies,
): SignUpResourceCommands {
  const scheduleExpiry$ = createScheduleExpiryCommand(atoms, runtime);
  const startCooldown$ = createStartCooldownCommand(
    signUpResendCooldown,
    atoms,
    runtime,
  );

  const applyResource$ = command(
    async (
      { get, set },
      resource: SignUpResource,
      signal: AbortSignal,
    ): Promise<void> => {
      const configuration = await get(clerkSignUpConfiguration$);
      signal.throwIfAborted();
      const snapshot = snapshotSignUpResource(resource, configuration);
      set(atoms.snapshot$, snapshot);
      set(atoms.fatalState$, null);
      set(scheduleExpiry$, snapshot.verification.expireAtMs, signal);
      if (
        snapshot.emailAddress !== null &&
        snapshot.unverifiedEmailAddress &&
        snapshot.verification.strategy === "email_code" &&
        snapshot.verification.status !== "expired"
      ) {
        const deadlineMs = set(
          signUpResendCooldownStorage.restore$,
          snapshot.emailAddress,
        );
        set(runtime.cooldownDeadlineMs$, deadlineMs);
        set(
          atoms.resendRemainingSeconds$,
          deadlineMs === null ? 0 : Math.ceil((deadlineMs - now()) / 1000),
        );
      }
      if (
        snapshot.verification.status === "expired" ||
        snapshot.clerkStatus === "complete"
      ) {
        set(signUpResendCooldownStorage.clear$);
        set(runtime.cooldownDeadlineMs$, null);
        set(atoms.resendRemainingSeconds$, 0);
      }
      if (
        snapshot.transferable ||
        snapshot.clerkStatus !== "complete" ||
        !snapshot.createdSessionId
      ) {
        return;
      }
      await set(
        dependencies.continuation.completeSession$,
        snapshot.createdSessionId,
        signal,
      );
      signal.throwIfAborted();
    },
  );

  const prepareEmailVerification$ = command(
    async (
      { get, set },
      resource: SignUpResource,
      automatic: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = get(atoms.snapshot$);
      const flowState = get(atoms.state$);
      if (
        flowState.status !== "incomplete" ||
        flowState.step !== "email-code" ||
        !snapshot?.unverifiedEmailAddress ||
        snapshot.verification.strategy === "email_code" ||
        snapshot.verification.status === "expired"
      ) {
        return;
      }
      if (automatic && get(runtime.automaticPreparationAttempted$)) {
        return;
      }
      if (automatic) {
        set(runtime.automaticPreparationAttempted$, true);
      }
      set(atoms.preparationState$, "preparing");
      set(atoms.error$, null);
      const prepared = await settle(
        resource.prepareEmailAddressVerification({ strategy: "email_code" }),
        signal,
      );
      if (!prepared.ok) {
        const error = normalizeClerkError(prepared.error, "code");
        L.warn(
          "Auth v2 sign-up email preparation failed",
          error.clerkCode ?? error.code,
        );
        set(atoms.preparationState$, "failed");
        set(atoms.error$, error);
        return;
      }
      set(atoms.preparationState$, "idle");
      set(atoms.verificationExpired$, false);
      await set(applyResource$, prepared.value, signal);
      signal.throwIfAborted();
      set(startCooldown$, flowState.emailAddress, signal);
    },
  );

  const initialize$ = createInitializeCommand(
    atoms,
    dependencies,
    applyResource$,
    prepareEmailVerification$,
  );

  return {
    applyResource$,
    initialize$,
    prepareEmailVerification$,
  };
}

function createCoalescedOperation(
  runtime: SignUpFlowRuntime,
  operation$: Command<Promise<void>, [AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = get(runtime.inFlight$);
    if (current) {
      await current;
      signal.throwIfAborted();
      return;
    }
    const operation = set(operation$, signal);
    set(runtime.inFlight$, operation);
    await withCleanup(operation, () => {
      set(runtime.inFlight$, (active) => {
        return active === operation ? null : active;
      });
    });
    signal.throwIfAborted();
  });
}

function createOAuthOperation(
  atoms: SignUpFlowAtoms,
  dependencies: AuthV2SignUpFlowDependencies,
): Command<Promise<void>, [AuthV2OAuthStrategy, AbortSignal]> {
  return command(
    async (
      { get, set },
      strategy: AuthV2OAuthStrategy,
      signal: AbortSignal,
    ): Promise<void> => {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (!clerk.client) {
        throw new Error(
          "Loaded Clerk instance did not provide a client resource",
        );
      }
      const resource = clerk.client.signUp;
      const capabilities = discoverAuthV2SignUpExternalCapabilities(
        clerk,
        resource,
      );
      set(atoms.oauthStrategies$, capabilities.oauthStrategies);
      if (!capabilities.oauthStrategies.includes(strategy)) {
        set(atoms.error$, { code: "unknown", field: "general" });
        return;
      }

      const flowState = get(atoms.state$);
      const snapshot = get(atoms.snapshot$);
      if (
        !snapshot ||
        flowState.status !== "incomplete" ||
        flowState.step !== "details"
      ) {
        return;
      }
      const legalAccepted = get(atoms.legalAccepted$);
      if (snapshot.legal.required && !legalAccepted) {
        set(atoms.error$, { code: "legal-required", field: "legal" });
        return;
      }

      set(atoms.error$, null);
      const started = await settle(
        startAuthV2OAuthSignUp(
          resource,
          dependencies.navigation,
          legalAccepted,
          strategy,
        ),
        signal,
      );
      if (!started.ok) {
        const error = normalizeClerkError(started.error, "general");
        L.warn(
          "Auth v2 OAuth sign-up redirect failed",
          error.clerkCode ?? error.code,
        );
        set(atoms.error$, error);
      }
    },
  );
}

function createCoalescedOAuthOperation(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  operation$: Command<Promise<void>, [AuthV2OAuthStrategy, AbortSignal]>,
): Command<Promise<void>, [AuthV2OAuthStrategy, AbortSignal]> {
  return command(
    async (
      { get, set },
      strategy: AuthV2OAuthStrategy,
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(runtime.inFlight$);
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      set(atoms.pendingOAuthStrategy$, strategy);
      const operation = set(operation$, strategy, signal);
      set(runtime.inFlight$, operation);
      await withCleanup(operation, () => {
        set(runtime.inFlight$, (active) => {
          return active === operation ? null : active;
        });
        set(atoms.pendingOAuthStrategy$, (pendingStrategy) => {
          return pendingStrategy === strategy ? null : pendingStrategy;
        });
      });
      signal.throwIfAborted();
    },
  );
}

function signUpParams(
  snapshot: SignUpResourceSnapshot,
  fields: {
    readonly emailAddress: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly legalAccepted: boolean;
    readonly password: string;
  },
  locale: string,
): SignUpCreateParams {
  const params: SignUpCreateParams = { locale };
  const emailAddress = fields.emailAddress.trim();
  const firstName = fields.firstName.trim();
  const lastName = fields.lastName.trim();
  if (snapshot.fields.emailAddress !== "hidden" && emailAddress) {
    params.emailAddress = emailAddress;
  }
  if (snapshot.fields.password !== "hidden" && fields.password) {
    params.password = fields.password;
  }
  if (snapshot.fields.firstName !== "hidden" && firstName) {
    params.firstName = firstName;
  }
  if (snapshot.fields.lastName !== "hidden" && lastName) {
    params.lastName = lastName;
  }
  if (snapshot.legal.required) {
    params.legalAccepted = fields.legalAccepted;
  }
  return params;
}

function createSubmitOperation(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  applyResource$: ApplySignUpResourceCommand,
  prepareEmailVerification$: Command<
    Promise<void>,
    [SignUpResource, boolean, AbortSignal]
  >,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const flowState = get(atoms.state$);
    if (flowState.status !== "incomplete") {
      return;
    }
    const resource = await get(clerkSignUpResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);

    if (flowState.step === "email-code") {
      if (flowState.verification !== "ready") {
        return;
      }
      const code = get(atoms.code$).trim();
      if (!code) {
        return;
      }
      const attempted = await settle(
        resource.attemptEmailAddressVerification({ code }),
        signal,
      );
      if (!attempted.ok) {
        const error = normalizeClerkError(attempted.error, "code");
        if (isExpiredError(error)) {
          set(atoms.verificationExpired$, true);
        }
        set(atoms.error$, error);
        return;
      }
      set(atoms.code$, "");
      await set(applyResource$, attempted.value, signal);
      signal.throwIfAborted();
      return;
    }

    const snapshot = get(atoms.snapshot$);
    if (!snapshot) {
      return;
    }
    if (snapshot.legal.required && !get(atoms.legalAccepted$)) {
      set(atoms.error$, { code: "legal-required", field: "legal" });
      return;
    }
    const password = get(atoms.password$);
    if (snapshot.fields.password !== "hidden" && password) {
      const invalidPassword = await validatePassword(
        resource,
        password,
        signal,
      );
      signal.throwIfAborted();
      if (invalidPassword) {
        set(atoms.error$, {
          code: "password-invalid",
          field: "password",
        });
        return;
      }
    }

    const locale = get(locale$);
    const params = signUpParams(
      snapshot,
      {
        emailAddress: get(atoms.emailAddress$),
        firstName: get(atoms.firstName$),
        lastName: get(atoms.lastName$),
        legalAccepted: get(atoms.legalAccepted$),
        password,
      },
      locale,
    );
    set(runtime.automaticPreparationAttempted$, false);
    set(atoms.preparationState$, "idle");
    set(atoms.verificationExpired$, false);
    set(atoms.captchaPending$, snapshot.captchaEnabled);
    set(atoms.captchaState$, snapshot.captchaEnabled ? "loading" : "idle");
    const request =
      snapshot.clerkStatus === null
        ? resource.create(params)
        : resource.update(params);
    const submitted = await settle(request, signal);
    set(atoms.captchaPending$, false);
    if (!submitted.ok) {
      const error = normalizeClerkError(submitted.error, "general");
      const captchaState = captchaFailureState(error);
      if (captchaState) {
        set(atoms.captchaState$, captchaState);
      } else {
        set(atoms.captchaState$, "idle");
      }
      set(atoms.error$, error);
      return;
    }
    set(atoms.captchaState$, "idle");
    set(atoms.editDetails$, false);
    await set(applyResource$, submitted.value, signal);
    signal.throwIfAborted();
    await set(prepareEmailVerification$, submitted.value, true, signal);
    signal.throwIfAborted();
  });
}

function createResendOperation(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  applyResource$: ApplySignUpResourceCommand,
): Command<Promise<void>, [AbortSignal]> {
  const startCooldown$ = createStartCooldownCommand(
    signUpResendCooldown,
    atoms,
    runtime,
  );
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const flowState = get(atoms.state$);
    if (
      flowState.status !== "incomplete" ||
      flowState.step !== "email-code" ||
      (get(atoms.resendRemainingSeconds$) > 0 &&
        flowState.verification !== "expired")
    ) {
      return;
    }
    const resource = await get(clerkSignUpResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);
    const prepared = await settle(
      resource.prepareEmailAddressVerification({ strategy: "email_code" }),
      signal,
    );
    if (!prepared.ok) {
      const error = normalizeClerkError(prepared.error, "code");
      set(atoms.preparationState$, "failed");
      set(atoms.error$, error);
      return;
    }
    set(atoms.preparationState$, "idle");
    set(atoms.verificationExpired$, false);
    set(atoms.code$, "");
    await set(applyResource$, prepared.value, signal);
    signal.throwIfAborted();
    set(startCooldown$, flowState.emailAddress, signal);
  });
}

function createRestartOperation(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  applyResource$: ApplySignUpResourceCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const resource = await get(clerkSignUpResource$);
    signal.throwIfAborted();
    const reset = await settle(resource.__internal_future.reset(), signal);
    if (!reset.ok || reset.value.error) {
      const error = normalizeClerkError(
        reset.ok ? reset.value.error : reset.error,
        "general",
      );
      set(atoms.error$, error);
      return;
    }
    set(runtime.automaticPreparationAttempted$, false);
    set(signUpResendCooldownStorage.clear$);
    set(runtime.cooldownDeadlineMs$, null);
    set(atoms.editDetails$, false);
    set(atoms.fatalState$, null);
    set(atoms.error$, null);
    set(atoms.emailAddress$, "");
    set(atoms.password$, "");
    set(atoms.firstName$, "");
    set(atoms.lastName$, "");
    set(atoms.legalAccepted$, false);
    set(atoms.code$, "");
    set(atoms.preparationState$, "idle");
    set(atoms.resendRemainingSeconds$, 0);
    set(atoms.verificationExpired$, false);
    set(atoms.captchaState$, "idle");
    await set(applyResource$, resource, signal);
    signal.throwIfAborted();
  });
}

function createFormCommands(atoms: SignUpFlowAtoms) {
  const backToDetails$ = command(({ set }) => {
    set(atoms.editDetails$, true);
    set(atoms.code$, "");
    set(atoms.error$, null);
    set(atoms.preparationState$, "idle");
  });
  const setEmailAddress$ = command(({ get, set }, value: string) => {
    if (get(atoms.emailAddress$) === value) {
      return;
    }
    set(atoms.emailAddress$, value);
    set(atoms.error$, null);
  });
  const setPassword$ = command(({ get, set }, value: string) => {
    if (get(atoms.password$) === value) {
      return;
    }
    set(atoms.password$, value);
    set(atoms.error$, null);
  });
  const setFirstName$ = command(({ get, set }, value: string) => {
    if (get(atoms.firstName$) === value) {
      return;
    }
    set(atoms.firstName$, value);
    set(atoms.error$, null);
  });
  const setLastName$ = command(({ get, set }, value: string) => {
    if (get(atoms.lastName$) === value) {
      return;
    }
    set(atoms.lastName$, value);
    set(atoms.error$, null);
  });
  const setLegalAccepted$ = command(({ get, set }, value: boolean) => {
    if (get(atoms.legalAccepted$) === value) {
      return;
    }
    set(atoms.legalAccepted$, value);
    set(atoms.error$, null);
  });
  const setCode$ = command(({ get, set }, value: string) => {
    if (get(atoms.code$) === value) {
      return;
    }
    set(atoms.code$, value);
    set(atoms.error$, null);
  });
  return {
    backToDetails$,
    setCode$,
    setEmailAddress$,
    setFirstName$,
    setLastName$,
    setLegalAccepted$,
    setPassword$,
  };
}

function createCaptchaRef(atoms: SignUpFlowAtoms) {
  return onRef(
    command(
      ({ get, set }, element: HTMLDivElement, signal: AbortSignal): void => {
        const syncCaptchaState = (): void => {
          if (!get(atoms.captchaPending$)) {
            return;
          }
          set(
            atoms.captchaState$,
            element.dataset.clInteractive === "true" ? "blocked" : "loading",
          );
        };
        const observer = new MutationObserver(syncCaptchaState);
        observer.observe(element, {
          attributeFilter: ["data-cl-interactive"],
          attributes: true,
        });
        syncCaptchaState();
        signal.addEventListener(
          "abort",
          () => {
            observer.disconnect();
          },
          { once: true },
        );
      },
    ),
  );
}

export function createAuthV2SignUpSignals(
  dependencies: AuthV2SignUpFlowDependencies,
): AuthV2SignUpSignals {
  const atoms = createSignUpFlowAtoms();
  const runtime = createSignUpFlowRuntime();
  const { applyResource$, initialize$, prepareEmailVerification$ } =
    createResourceCommands(atoms, runtime, dependencies);
  const submitOperation$ = createSubmitOperation(
    atoms,
    runtime,
    applyResource$,
    prepareEmailVerification$,
  );
  const resendOperation$ = createResendOperation(
    atoms,
    runtime,
    applyResource$,
  );
  const restartOperation$ = createRestartOperation(
    atoms,
    runtime,
    applyResource$,
  );
  const oauthOperation$ = createOAuthOperation(atoms, dependencies);
  const resendCooldownLifecycleRef$ = createResendCooldownLifecycleRef(
    signUpResendCooldown,
    atoms,
    runtime,
  );
  const formCommands = createFormCommands(atoms);
  return {
    ...formCommands,
    captchaRef$: createCaptchaRef(atoms),
    captchaState$: computed((get) => {
      return get(atoms.captchaState$);
    }),
    code$: computed((get) => {
      return get(atoms.code$);
    }),
    emailAddress$: computed((get) => {
      return get(atoms.emailAddress$);
    }),
    error$: computed((get) => {
      return get(atoms.error$);
    }),
    firstName$: computed((get) => {
      return get(atoms.firstName$);
    }),
    initialize$: createCoalescedOperation(runtime, initialize$),
    lastName$: computed((get) => {
      return get(atoms.lastName$);
    }),
    legalAccepted$: computed((get) => {
      return get(atoms.legalAccepted$);
    }),
    oauthStrategies$: computed((get) => {
      return get(atoms.oauthStrategies$);
    }),
    pendingOAuthStrategy$: computed((get) => {
      return get(atoms.pendingOAuthStrategy$);
    }),
    password$: computed((get) => {
      return get(atoms.password$);
    }),
    resendCode$: createCoalescedOperation(runtime, resendOperation$),
    resendCooldownLifecycleRef$,
    resendState$: computed((get) => {
      const remainingSeconds = get(atoms.resendRemainingSeconds$);
      return remainingSeconds > 0
        ? { remainingSeconds, status: "cooling-down" }
        : { remainingSeconds: 0, status: "ready" };
    }),
    restart$: createCoalescedOperation(runtime, restartOperation$),
    state$: atoms.state$,
    startOAuth$: createCoalescedOAuthOperation(atoms, runtime, oauthOperation$),
    submit$: createCoalescedOperation(runtime, submitOperation$),
  };
}
