import type { Clerk } from "@clerk/clerk-js";
import type {
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

import { now } from "../../lib/time.ts";
import { clerk$ } from "../auth.ts";
import { locale$ } from "../locale.ts";
import { logger } from "../log.ts";
import { createDeferredPromise, onRef, settle, withCleanup } from "../utils.ts";

const L = logger("AuthV2SignUp");

export const AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS = 30;
const AUTH_V2_SIGN_UP_RESEND_COOLDOWN_MS =
  AUTH_V2_SIGN_UP_RESEND_COOLDOWN_SECONDS * 1000;

const SUPPORTED_SIGN_UP_FIELDS = [
  "email_address",
  "first_name",
  "last_name",
  "legal_accepted",
  "password",
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

export type AuthV2SignUpCaptchaState =
  | "blocked"
  | "error"
  | "expired"
  | "idle"
  | "loading";

export type AuthV2SignUpUnknownReason =
  | "activation-failed"
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

export interface AuthV2SignUpFlowDependencies {
  readonly resolveRedirectUrl: () => string;
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
  readonly password$: Computed<string>;
  readonly resendCode$: Command<Promise<void>, [AbortSignal]>;
  readonly resendCoolingDown$: Computed<boolean>;
  readonly restart$: Command<Promise<void>, [AbortSignal]>;
  readonly setCode$: Command<void, [string]>;
  readonly setEmailAddress$: Command<void, [string]>;
  readonly setFirstName$: Command<void, [string]>;
  readonly setLastName$: Command<void, [string]>;
  readonly setLegalAccepted$: Command<void, [boolean]>;
  readonly setPassword$: Command<void, [string]>;
  readonly state$: Computed<AuthV2SignUpState>;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
}

interface SignUpConfiguration {
  readonly captchaEnabled: boolean;
  readonly privacyPolicyUrl: string | null;
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
  readonly unsupportedFields: readonly SignUpField[];
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
  readonly password$: State<string>;
  readonly preparationState$: State<"failed" | "idle" | "preparing">;
  readonly resendCoolingDown$: State<boolean>;
  readonly snapshot$: State<SignUpResourceSnapshot | null>;
  readonly state$: Computed<AuthV2SignUpState>;
  readonly verificationExpired$: State<boolean>;
}

interface SignUpFlowRuntime {
  readonly activatedSessionId$: State<string | null>;
  readonly activation$: State<{
    readonly promise: Promise<void>;
    readonly sessionId: string;
  } | null>;
  readonly automaticPreparationAttempted$: State<boolean>;
  readonly cooldownTimer$: State<number | null>;
  readonly expiryTimer$: State<number | null>;
  readonly inFlight$: State<Promise<void> | null>;
}

type ApplySignUpResourceCommand = Command<
  Promise<void>,
  [SignUpResource, AbortSignal]
>;

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

function signUpFields(resource: SignUpResource): AuthV2SignUpFields {
  const requiredFields = new Set(resource.requiredFields);
  const optionalFields = new Set(resource.optionalFields);
  return {
    emailAddress: fieldRequirement(
      "email_address",
      requiredFields,
      optionalFields,
    ),
    firstName: fieldRequirement("first_name", requiredFields, optionalFields),
    lastName: fieldRequirement("last_name", requiredFields, optionalFields),
    password: resource.hasPassword
      ? "hidden"
      : fieldRequirement("password", requiredFields, optionalFields),
  };
}

function unsupportedSignUpFields(
  resource: SignUpResource,
): readonly SignUpField[] {
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
  const legalRequired =
    resource.requiredFields.includes("legal_accepted") &&
    resource.missingFields.includes("legal_accepted");
  return {
    captchaEnabled: configuration.captchaEnabled,
    clerkStatus: resource.status,
    createdSessionId: resource.createdSessionId,
    emailAddress: resource.emailAddress,
    fields: signUpFields(resource),
    legal: {
      privacyPolicyUrl: configuration.privacyPolicyUrl,
      required: legalRequired,
      termsUrl: configuration.termsUrl,
    },
    missingFields: [...resource.missingFields],
    transferable: resource.__internal_future.isTransferable,
    unsupportedFields: unsupportedSignUpFields(resource),
    unverifiedEmailAddress: resource.unverifiedFields.includes("email_address"),
    verification: {
      expireAtMs: verification.expireAt?.getTime() ?? null,
      status: verification.status,
      strategy: verification.strategy,
    },
  };
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
  const lastName$ = state("");
  const legalAccepted$ = state(false);
  const code$ = state("");
  const captchaState$ = state<AuthV2SignUpCaptchaState>("idle");
  const captchaPending$ = state(false);
  const resendCoolingDown$ = state(false);
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
    password$,
    preparationState$,
    resendCoolingDown$,
    snapshot$,
    state$,
    verificationExpired$,
  };
}

function createSignUpFlowRuntime(): SignUpFlowRuntime {
  return {
    activatedSessionId$: state<string | null>(null),
    activation$: state<{
      readonly promise: Promise<void>;
      readonly sessionId: string;
    } | null>(null),
    automaticPreparationAttempted$: state(false),
    cooldownTimer$: state<number | null>(null),
    expiryTimer$: state<number | null>(null),
    inFlight$: state<Promise<void> | null>(null),
  };
}

export const clerkSignUpResource$ = computed(async (get) => {
  const clerk = await get(clerk$);
  if (!clerk.client) {
    throw new Error("Loaded Clerk instance did not provide a client resource");
  }
  return clerk.client.signUp;
});

const clerkSignUpConfiguration$ = computed(async (get) => {
  const clerk = await get(clerk$);
  const displayConfig = clerk.__internal_environment?.displayConfig;
  if (!displayConfig) {
    throw new Error(
      "Loaded Clerk instance did not provide display configuration",
    );
  }
  return {
    captchaEnabled:
      displayConfig.captchaWidgetType !== null &&
      (displayConfig.captchaPublicKey !== null ||
        displayConfig.captchaPublicKeyInvisible !== null),
    privacyPolicyUrl: displayConfig.privacyPolicyUrl || null,
    termsUrl: displayConfig.termsUrl || null,
  } satisfies SignUpConfiguration;
});

function clearTimer(
  timer: number | null,
  setTimer: (timer: number | null) => void,
): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    setTimer(null);
  }
}

function createScheduleExpiryCommand(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
): Command<void, [number | null, AbortSignal]> {
  const markExpired$ = command(({ set }) => {
    set(atoms.verificationExpired$, true);
    set(runtime.expiryTimer$, null);
  });
  return command(
    ({ get, set }, expireAtMs: number | null, signal: AbortSignal): void => {
      clearTimer(get(runtime.expiryTimer$), (timer) => {
        set(runtime.expiryTimer$, timer);
      });
      set(atoms.verificationExpired$, false);
      if (expireAtMs === null) {
        return;
      }
      const delay = Math.max(0, expireAtMs - now());
      if (delay === 0) {
        set(markExpired$);
        return;
      }
      const timer = window.setTimeout(() => {
        set(markExpired$);
      }, delay);
      set(runtime.expiryTimer$, timer);
      signal.addEventListener(
        "abort",
        () => {
          if (get(runtime.expiryTimer$) === timer) {
            window.clearTimeout(timer);
            set(runtime.expiryTimer$, null);
          }
        },
        { once: true },
      );
    },
  );
}

function createStartCooldownCommand(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
): Command<void, [AbortSignal]> {
  const finishCooldown$ = command(({ set }) => {
    set(atoms.resendCoolingDown$, false);
    set(runtime.cooldownTimer$, null);
  });
  return command(({ get, set }, signal: AbortSignal): void => {
    clearTimer(get(runtime.cooldownTimer$), (timer) => {
      set(runtime.cooldownTimer$, timer);
    });
    set(atoms.resendCoolingDown$, true);
    const timer = window.setTimeout(() => {
      set(finishCooldown$);
    }, AUTH_V2_SIGN_UP_RESEND_COOLDOWN_MS);
    set(runtime.cooldownTimer$, timer);
    signal.addEventListener(
      "abort",
      () => {
        if (get(runtime.cooldownTimer$) === timer) {
          window.clearTimeout(timer);
          set(runtime.cooldownTimer$, null);
        }
      },
      { once: true },
    );
  });
}

function createActivateSessionCommand(
  runtime: SignUpFlowRuntime,
  dependencies: AuthV2SignUpFlowDependencies,
): Command<Promise<void>, [string, AbortSignal]> {
  const performActivation$ = command(
    async (
      { set },
      clerk: Clerk,
      sessionId: string,
      redirectUrl: string,
      signal: AbortSignal,
    ): Promise<void> => {
      await clerk.setActive({ redirectUrl, session: sessionId });
      signal.throwIfAborted();
      set(runtime.activatedSessionId$, sessionId);
    },
  );
  return command(
    async (
      { get, set },
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(runtime.activatedSessionId$) === sessionId) {
        return;
      }
      const activeActivation = get(runtime.activation$);
      if (activeActivation) {
        await activeActivation.promise;
        signal.throwIfAborted();
        if (get(runtime.activatedSessionId$) === sessionId) {
          return;
        }
      }

      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const activationPromise = set(
        performActivation$,
        clerk,
        sessionId,
        dependencies.resolveRedirectUrl(),
        signal,
      );
      const trackedActivation = withCleanup(activationPromise, () => {
        set(runtime.activation$, (current) => {
          return current?.sessionId === sessionId ? null : current;
        });
      });
      set(runtime.activation$, { promise: trackedActivation, sessionId });
      await trackedActivation;
      signal.throwIfAborted();
    },
  );
}

function createResourceCommands(
  atoms: SignUpFlowAtoms,
  runtime: SignUpFlowRuntime,
  dependencies: AuthV2SignUpFlowDependencies,
): {
  readonly applyResource$: ApplySignUpResourceCommand;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly prepareEmailVerification$: Command<
    Promise<void>,
    [SignUpResource, boolean, AbortSignal]
  >;
} {
  const scheduleExpiry$ = createScheduleExpiryCommand(atoms, runtime);
  const startCooldown$ = createStartCooldownCommand(atoms, runtime);
  const activateSession$ = createActivateSessionCommand(runtime, dependencies);

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
        snapshot.transferable ||
        snapshot.clerkStatus !== "complete" ||
        !snapshot.createdSessionId
      ) {
        return;
      }
      const activation = await settle(
        set(activateSession$, snapshot.createdSessionId, signal),
        signal,
      );
      if (!activation.ok) {
        L.error("Auth v2 sign-up activation failed", snapshot.clerkStatus);
        set(atoms.fatalState$, {
          clerkStatus: snapshot.clerkStatus,
          reason: "activation-failed",
          status: "unknown",
        });
      }
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
      set(startCooldown$, signal);
    },
  );

  const initialize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const resource = await get(clerkSignUpResource$);
      signal.throwIfAborted();
      set(atoms.emailAddress$, resource.emailAddress ?? "");
      set(atoms.firstName$, resource.firstName ?? "");
      set(atoms.lastName$, resource.lastName ?? "");
      set(atoms.legalAccepted$, resource.legalAcceptedAt !== null);
      await set(applyResource$, resource, signal);
      signal.throwIfAborted();
      await set(prepareEmailVerification$, resource, true, signal);
      signal.throwIfAborted();
    },
  );

  return { applyResource$, initialize$, prepareEmailVerification$ };
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
  const startCooldown$ = createStartCooldownCommand(atoms, runtime);
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const flowState = get(atoms.state$);
    if (
      flowState.status !== "incomplete" ||
      flowState.step !== "email-code" ||
      (get(atoms.resendCoolingDown$) && flowState.verification !== "expired")
    ) {
      return;
    }
    const resource = await get(clerkSignUpResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);
    set(atoms.preparationState$, "preparing");
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
    set(startCooldown$, signal);
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
  const setEmailAddress$ = command(({ set }, value: string) => {
    set(atoms.emailAddress$, value);
    set(atoms.error$, null);
  });
  const setPassword$ = command(({ set }, value: string) => {
    set(atoms.password$, value);
    set(atoms.error$, null);
  });
  const setFirstName$ = command(({ set }, value: string) => {
    set(atoms.firstName$, value);
    set(atoms.error$, null);
  });
  const setLastName$ = command(({ set }, value: string) => {
    set(atoms.lastName$, value);
    set(atoms.error$, null);
  });
  const setLegalAccepted$ = command(({ set }, value: boolean) => {
    set(atoms.legalAccepted$, value);
    set(atoms.error$, null);
  });
  const setCode$ = command(({ set }, value: string) => {
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
    initialize$,
    lastName$: computed((get) => {
      return get(atoms.lastName$);
    }),
    legalAccepted$: computed((get) => {
      return get(atoms.legalAccepted$);
    }),
    password$: computed((get) => {
      return get(atoms.password$);
    }),
    resendCode$: createCoalescedOperation(runtime, resendOperation$),
    resendCoolingDown$: computed((get) => {
      return get(atoms.resendCoolingDown$);
    }),
    restart$: createCoalescedOperation(runtime, restartOperation$),
    state$: atoms.state$,
    submit$: createCoalescedOperation(runtime, submitOperation$),
  };
}
