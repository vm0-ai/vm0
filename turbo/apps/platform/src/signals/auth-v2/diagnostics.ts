import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import type {
  AuthV2DiagnosticErrorCategory,
  AuthV2DiagnosticFlow,
  AuthV2DiagnosticMethod,
  AuthV2DiagnosticProperties,
  AuthV2DiagnosticStep,
} from "../../lib/posthog.ts";
import { withCleanup } from "../utils.ts";
import type {
  AuthV2ContinuationSignals,
  AuthV2ContinuationState,
} from "./continuation.ts";
import type {
  AuthV2SignInError,
  AuthV2SignInFactor,
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "./sign-in-flow.ts";
import type {
  AuthV2SignUpError,
  AuthV2SignUpSignals,
  AuthV2SignUpState,
} from "./sign-up-flow.ts";
import type { AuthV2OAuthStrategy } from "./oauth-strategies.ts";

type AuthV2DiagnosticsFlow = Exclude<AuthV2DiagnosticFlow, "unknown">;
type CaptureAuthV2Diagnostic = (properties: AuthV2DiagnosticProperties) => void;

interface DiagnosticAttempt {
  readonly method: AuthV2DiagnosticMethod;
  readonly step: AuthV2DiagnosticStep;
}

interface SignInInitializeAttempt extends DiagnosticAttempt {
  readonly resourceAttemptVersion: number;
}

interface DiagnosticResult {
  readonly errorCategory: AuthV2DiagnosticErrorCategory;
  readonly outcome: "failure" | "success";
}

interface DiagnosticCommandRuntime {
  readonly attemptVersion$?: State<number>;
  readonly inFlight$: State<Promise<void> | null>;
}

const SIGN_UP_RESTART_ATTEMPT$ = computed((): DiagnosticAttempt => {
  return { method: "unknown", step: "restart" };
});

const CONTINUATION_INITIALIZE_ATTEMPT$ = computed((): DiagnosticAttempt => {
  return { method: "session", step: "recovery" };
});

interface AuthV2SignInDiagnosticOptions {
  readonly continuationState$: Computed<AuthV2ContinuationState>;
  readonly isBaseRoute: boolean;
  readonly isOAuthCallbackRoute: boolean;
}

interface AuthV2SignUpDiagnosticOptions {
  readonly continuationState$: Computed<AuthV2ContinuationState>;
  readonly isOAuthCallbackRoute: boolean;
}

interface AuthV2Diagnostics {
  readonly instrumentContinuation: (
    signals: AuthV2ContinuationSignals,
  ) => AuthV2ContinuationSignals;
  readonly instrumentSignIn: (
    signals: AuthV2SignInSignals,
    options: AuthV2SignInDiagnosticOptions,
  ) => AuthV2SignInSignals;
  readonly instrumentSignUp: (
    signals: AuthV2SignUpSignals,
    options: AuthV2SignUpDiagnosticOptions,
  ) => AuthV2SignUpSignals;
}

function diagnosticResult(
  errorCategory: AuthV2DiagnosticErrorCategory | null,
): DiagnosticResult {
  return errorCategory
    ? { errorCategory, outcome: "failure" }
    : { errorCategory: "none", outcome: "success" };
}

function signInErrorCategory(
  error: AuthV2SignInError,
): AuthV2DiagnosticErrorCategory {
  switch (error.code) {
    case "access-not-allowed":
    case "user-banned": {
      return "invalid-credentials";
    }
    case "code-expired": {
      return "invalid-code";
    }
    case "passkey-cancelled": {
      return "cancelled";
    }
    case "passkey-unavailable": {
      return "method-unavailable";
    }
    case "password-mismatch": {
      return "invalid-input";
    }
    case "unknown": {
      return "unknown";
    }
    case "clerk": {
      if (error.field === "code") {
        return "invalid-code";
      }
      if (error.field === "identifier" || error.field === "password") {
        return "invalid-credentials";
      }
      return error.field === "new-password"
        ? "invalid-input"
        : "provider-error";
    }
  }
}

function signInStateErrorCategory(
  flowState: AuthV2SignInState,
): AuthV2DiagnosticErrorCategory | null {
  if (flowState.status !== "unknown") {
    return null;
  }
  switch (flowState.reason) {
    case "missing-session": {
      return "session-unavailable";
    }
    case "unsupported-factor":
    case "unsupported-status": {
      return "unsupported-state";
    }
  }
}

function signInResult(
  flowState: AuthV2SignInState,
  error: AuthV2SignInError | null,
  continuationState: AuthV2ContinuationState,
): DiagnosticResult {
  return diagnosticResult(
    (error
      ? signInErrorCategory(error)
      : signInStateErrorCategory(flowState)) ??
      continuationStateErrorCategory(continuationState),
  );
}

function signUpErrorCategory(
  error: AuthV2SignUpError,
): AuthV2DiagnosticErrorCategory {
  switch (error.code) {
    case "legal-required":
    case "password-invalid": {
      return "invalid-input";
    }
    case "unknown": {
      return "unknown";
    }
    case "clerk": {
      if (error.field === "captcha") {
        return "captcha";
      }
      if (error.field === "code") {
        return "invalid-code";
      }
      return error.field === "general" ? "provider-error" : "invalid-input";
    }
  }
}

function signUpStateErrorCategory(
  flowState: AuthV2SignUpState,
): AuthV2DiagnosticErrorCategory | null {
  if (flowState.status !== "unknown") {
    return null;
  }
  switch (flowState.reason) {
    case "missing-legal-configuration": {
      return "configuration";
    }
    case "missing-session": {
      return "session-unavailable";
    }
    case "unsupported-field":
    case "unsupported-status": {
      return "unsupported-state";
    }
  }
}

function signUpResult(
  flowState: AuthV2SignUpState,
  error: AuthV2SignUpError | null,
  continuationState: AuthV2ContinuationState,
): DiagnosticResult {
  return diagnosticResult(
    (error
      ? signUpErrorCategory(error)
      : signUpStateErrorCategory(flowState)) ??
      continuationStateErrorCategory(continuationState),
  );
}

function continuationStateErrorCategory(
  flowState: AuthV2ContinuationState,
): AuthV2DiagnosticErrorCategory | null {
  if (flowState.status === "failure") {
    switch (flowState.reason) {
      case "activation-failed":
      case "session-unavailable":
      case "missing-session": {
        return "session-unavailable";
      }
      case "no-organizations":
      case "organization-activation-failed": {
        return "organization-unavailable";
      }
    }
  }
  if (flowState.status === "unknown") {
    switch (flowState.reason) {
      case "second-factor":
      case "unknown-task":
      case "unsupported-task": {
        return "unsupported-state";
      }
    }
  }
  return null;
}

function diagnosticProperties(
  flow: AuthV2DiagnosticsFlow,
  attempt: DiagnosticAttempt,
  result: DiagnosticResult,
): AuthV2DiagnosticProperties {
  return {
    error_category: result.errorCategory,
    flow,
    method: attempt.method,
    outcome: result.outcome,
    step: attempt.step,
  };
}

function createAsyncDiagnosticCommand<Attempt extends DiagnosticAttempt>(
  source$: Command<Promise<void>, [AbortSignal]>,
  attempt$: Computed<Attempt | null>,
  finish$: Command<AuthV2DiagnosticProperties | null, [Attempt]>,
  capture: CaptureAuthV2Diagnostic,
  runtime: DiagnosticCommandRuntime,
): Command<Promise<void>, [AbortSignal]> {
  const run$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const attempt = get(attempt$);
      if (attempt && runtime.attemptVersion$) {
        set(runtime.attemptVersion$, (version) => {
          return version + 1;
        });
      }
      await set(source$, signal);
      signal.throwIfAborted();
      if (!attempt) {
        return;
      }
      const properties = set(finish$, attempt);
      if (properties) {
        capture(properties);
      }
    },
  );
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = get(runtime.inFlight$);
    if (current) {
      await current;
      signal.throwIfAborted();
      return;
    }
    const operation = set(run$, signal);
    set(runtime.inFlight$, operation);
    await withCleanup(operation, () => {
      set(runtime.inFlight$, (active) => {
        return active === operation ? null : active;
      });
    });
    signal.throwIfAborted();
  });
}

function createValueDiagnosticCommand<Value>(
  source$: Command<Promise<void>, [Value, AbortSignal]>,
  describe$: Command<DiagnosticAttempt | null, [Value]>,
  finish$: Command<AuthV2DiagnosticProperties | null, [DiagnosticAttempt]>,
  capture: CaptureAuthV2Diagnostic,
  runtime: DiagnosticCommandRuntime,
): Command<Promise<void>, [Value, AbortSignal]> {
  const run$ = command(
    async ({ set }, value: Value, signal: AbortSignal): Promise<void> => {
      const attempt = set(describe$, value);
      if (attempt && runtime.attemptVersion$) {
        set(runtime.attemptVersion$, (version) => {
          return version + 1;
        });
      }
      await set(source$, value, signal);
      signal.throwIfAborted();
      if (!attempt) {
        return;
      }
      const properties = set(finish$, attempt);
      if (properties) {
        capture(properties);
      }
    },
  );
  return command(
    async ({ get, set }, value: Value, signal: AbortSignal): Promise<void> => {
      const current = get(runtime.inFlight$);
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      const operation = set(run$, value, signal);
      set(runtime.inFlight$, operation);
      await withCleanup(operation, () => {
        set(runtime.inFlight$, (active) => {
          return active === operation ? null : active;
        });
      });
      signal.throwIfAborted();
    },
  );
}

function createSyncDiagnosticCommand(
  source$: Command<void, []>,
  attempt: DiagnosticAttempt,
  finish$: Command<AuthV2DiagnosticProperties | null, [DiagnosticAttempt]>,
  capture: CaptureAuthV2Diagnostic,
): Command<void, []> {
  return command(({ set }): void => {
    set(source$);
    const properties = set(finish$, attempt);
    if (properties) {
      capture(properties);
    }
  });
}

function signInFactorMethod(
  factor: AuthV2SignInFactor,
): AuthV2DiagnosticMethod {
  switch (factor.kind) {
    case "email-code": {
      return "email-code";
    }
    case "client-trust-email-code": {
      return "email-code";
    }
    case "oauth": {
      return factor.strategy === "oauth_apple" ? "apple-oauth" : "google-oauth";
    }
    case "passkey": {
      return "passkey";
    }
    case "password": {
      return "password";
    }
    case "password-reset": {
      return "password-reset";
    }
  }
}

function createSignInFinishCommands(
  flow: AuthV2DiagnosticsFlow,
  signals: AuthV2SignInSignals,
  options: AuthV2SignInDiagnosticOptions,
  resourceAttemptVersion$: State<number>,
): {
  readonly finish$: Command<AuthV2DiagnosticProperties, [DiagnosticAttempt]>;
  readonly finishInitialize$: Command<
    AuthV2DiagnosticProperties | null,
    [SignInInitializeAttempt]
  >;
} {
  const finish$ = command(
    ({ get }, attempt: DiagnosticAttempt): AuthV2DiagnosticProperties => {
      return diagnosticProperties(
        flow,
        attempt,
        signInResult(
          get(signals.state$),
          get(signals.error$),
          get(options.continuationState$),
        ),
      );
    },
  );
  const finishInitialize$ = command(
    (
      { get },
      attempt: SignInInitializeAttempt,
    ): AuthV2DiagnosticProperties | null => {
      if (get(resourceAttemptVersion$) !== attempt.resourceAttemptVersion) {
        return null;
      }
      const flowState = get(signals.state$);
      const error = get(signals.error$);
      const result = signInResult(
        flowState,
        error,
        get(options.continuationState$),
      );
      if (result.outcome === "failure") {
        const method =
          options.isBaseRoute && error ? "google-one-tap" : attempt.method;
        return diagnosticProperties(flow, { ...attempt, method }, result);
      }
      if (options.isBaseRoute && flowState.status === "complete") {
        return diagnosticProperties(
          flow,
          { method: "google-one-tap", step: "initialize" },
          result,
        );
      }
      return null;
    },
  );

  return { finish$, finishInitialize$ };
}

function createSignInAttemptSignals(
  signals: AuthV2SignInSignals,
  options: AuthV2SignInDiagnosticOptions,
  resourceAttemptVersion$: State<number>,
): {
  readonly describeFactor$: Command<DiagnosticAttempt | null, [string]>;
  readonly describeSession$: Command<DiagnosticAttempt | null, [string]>;
  readonly initializeAttempt$: Computed<SignInInitializeAttempt>;
  readonly resendAttempt$: Computed<DiagnosticAttempt | null>;
  readonly submitAttempt$: Computed<DiagnosticAttempt | null>;
} {
  const initializeAttempt$ = computed((get): SignInInitializeAttempt => {
    return {
      method: "unknown",
      resourceAttemptVersion: get(resourceAttemptVersion$),
      step: options.isOAuthCallbackRoute ? "oauth-callback" : "initialize",
    };
  });
  const submitAttempt$ = computed((get): DiagnosticAttempt | null => {
    const flowState = get(signals.state$);
    if (flowState.status !== "incomplete") {
      return null;
    }
    switch (flowState.step) {
      case "identifier": {
        return get(signals.identifier$).trim()
          ? { method: "identifier", step: "identifier" }
          : null;
      }
      case "password": {
        return get(signals.password$)
          ? { method: "password", step: "password" }
          : null;
      }
      case "email-code": {
        return get(signals.code$).trim()
          ? { method: "email-code", step: "email-code" }
          : null;
      }
      case "client-trust-code": {
        return get(signals.code$).trim()
          ? { method: "email-code", step: "email-code" }
          : null;
      }
      case "password-reset-code": {
        return get(signals.code$).trim()
          ? { method: "password-reset", step: "password-reset-code" }
          : null;
      }
      case "new-password": {
        return get(signals.newPassword$)
          ? { method: "password-reset", step: "new-password" }
          : null;
      }
      case "choose-factor":
      case "choose-session":
      case "help":
      case "password-recovery": {
        return null;
      }
    }
  });
  const describeFactor$ = command(
    ({ get }, factorId: string): DiagnosticAttempt | null => {
      const flowState = get(signals.state$);
      if (
        flowState.status !== "incomplete" ||
        (flowState.step !== "choose-factor" &&
          flowState.step !== "identifier" &&
          flowState.step !== "password-recovery")
      ) {
        return null;
      }
      const factor = flowState.factors.find((candidate) => {
        return candidate.id === factorId;
      });
      return {
        method: factor ? signInFactorMethod(factor) : "unknown",
        step:
          flowState.step === "identifier"
            ? "identifier"
            : flowState.step === "password-recovery"
              ? "recovery"
              : "choose-factor",
      };
    },
  );
  const describeSession$ = command(
    ({ get }, _sessionId: string): DiagnosticAttempt | null => {
      const flowState = get(signals.state$);
      return flowState.status === "incomplete" &&
        flowState.step === "choose-session"
        ? { method: "session", step: "choose-session" }
        : null;
    },
  );
  const resendAttempt$ = computed((get): DiagnosticAttempt | null => {
    const flowState = get(signals.state$);
    if (flowState.status !== "incomplete") {
      return null;
    }
    if (
      flowState.step === "email-code" ||
      flowState.step === "client-trust-code"
    ) {
      return { method: "email-code", step: "email-code" };
    }
    return flowState.step === "password-reset-code"
      ? { method: "password-reset", step: "password-reset-code" }
      : null;
  });

  return {
    describeFactor$,
    describeSession$,
    initializeAttempt$,
    resendAttempt$,
    submitAttempt$,
  };
}

function createSignInInstrumentation(
  flow: AuthV2DiagnosticsFlow,
  capture: CaptureAuthV2Diagnostic,
  signals: AuthV2SignInSignals,
  options: AuthV2SignInDiagnosticOptions,
): AuthV2SignInSignals {
  const resourceAttemptVersion$ = state(0);
  const initializeRuntime: DiagnosticCommandRuntime = {
    inFlight$: state<Promise<void> | null>(null),
  };
  const resourceRuntime: DiagnosticCommandRuntime = {
    attemptVersion$: resourceAttemptVersion$,
    inFlight$: state<Promise<void> | null>(null),
  };
  const { finish$, finishInitialize$ } = createSignInFinishCommands(
    flow,
    signals,
    options,
    resourceAttemptVersion$,
  );
  const {
    describeFactor$,
    describeSession$,
    initializeAttempt$,
    resendAttempt$,
    submitAttempt$,
  } = createSignInAttemptSignals(signals, options, resourceAttemptVersion$);

  return {
    ...signals,
    initializeExternalStrategies$: createAsyncDiagnosticCommand(
      signals.initializeExternalStrategies$,
      initializeAttempt$,
      finishInitialize$,
      capture,
      initializeRuntime,
    ),
    resendCode$: createAsyncDiagnosticCommand(
      signals.resendCode$,
      resendAttempt$,
      finish$,
      capture,
      resourceRuntime,
    ),
    restart$: createSyncDiagnosticCommand(
      signals.restart$,
      { method: "unknown", step: "restart" },
      finish$,
      capture,
    ),
    selectFactor$: createValueDiagnosticCommand(
      signals.selectFactor$,
      describeFactor$,
      finish$,
      capture,
      resourceRuntime,
    ),
    selectSession$: createValueDiagnosticCommand(
      signals.selectSession$,
      describeSession$,
      finish$,
      capture,
      resourceRuntime,
    ),
    submit$: createAsyncDiagnosticCommand(
      signals.submit$,
      submitAttempt$,
      finish$,
      capture,
      resourceRuntime,
    ),
  };
}

function createSignUpInstrumentation(
  flow: AuthV2DiagnosticsFlow,
  capture: CaptureAuthV2Diagnostic,
  signals: AuthV2SignUpSignals,
  options: AuthV2SignUpDiagnosticOptions,
): AuthV2SignUpSignals {
  const runtime: DiagnosticCommandRuntime = {
    inFlight$: state<Promise<void> | null>(null),
  };
  const finish$ = command(
    ({ get }, attempt: DiagnosticAttempt): AuthV2DiagnosticProperties => {
      return diagnosticProperties(
        flow,
        attempt,
        signUpResult(
          get(signals.state$),
          get(signals.error$),
          get(options.continuationState$),
        ),
      );
    },
  );
  const initializeAttempt$ = computed((): DiagnosticAttempt => {
    return {
      method: "unknown",
      step: options.isOAuthCallbackRoute ? "oauth-callback" : "initialize",
    };
  });
  const finishInitialize$ = command(
    (
      { get },
      attempt: DiagnosticAttempt,
    ): AuthV2DiagnosticProperties | null => {
      const result = signUpResult(
        get(signals.state$),
        get(signals.error$),
        get(options.continuationState$),
      );
      return result.outcome === "failure"
        ? diagnosticProperties(flow, attempt, result)
        : null;
    },
  );
  const submitAttempt$ = computed((get): DiagnosticAttempt | null => {
    const flowState = get(signals.state$);
    if (flowState.status !== "incomplete") {
      return null;
    }
    if (flowState.step === "details") {
      return { method: "password", step: "details" };
    }
    return flowState.verification === "ready" && get(signals.code$).trim()
      ? { method: "email-code", step: "email-code" }
      : null;
  });
  const describeOAuth$ = command(
    ({ get }, strategy: AuthV2OAuthStrategy): DiagnosticAttempt | null => {
      const flowState = get(signals.state$);
      if (flowState.status !== "incomplete" || flowState.step !== "details") {
        return null;
      }
      return {
        method: strategy === "oauth_apple" ? "apple-oauth" : "google-oauth",
        step: "details",
      };
    },
  );
  const resendAttempt$ = computed((get): DiagnosticAttempt | null => {
    const flowState = get(signals.state$);
    if (
      flowState.status !== "incomplete" ||
      flowState.step !== "email-code" ||
      (get(signals.resendState$).status === "cooling-down" &&
        flowState.verification !== "expired")
    ) {
      return null;
    }
    return { method: "email-code", step: "email-code" };
  });
  return {
    ...signals,
    initialize$: createAsyncDiagnosticCommand(
      signals.initialize$,
      initializeAttempt$,
      finishInitialize$,
      capture,
      runtime,
    ),
    resendCode$: createAsyncDiagnosticCommand(
      signals.resendCode$,
      resendAttempt$,
      finish$,
      capture,
      runtime,
    ),
    restart$: createAsyncDiagnosticCommand(
      signals.restart$,
      SIGN_UP_RESTART_ATTEMPT$,
      finish$,
      capture,
      runtime,
    ),
    startOAuth$: createValueDiagnosticCommand(
      signals.startOAuth$,
      describeOAuth$,
      finish$,
      capture,
      runtime,
    ),
    submit$: createAsyncDiagnosticCommand(
      signals.submit$,
      submitAttempt$,
      finish$,
      capture,
      runtime,
    ),
  };
}

function createContinuationInstrumentation(
  flow: AuthV2DiagnosticsFlow,
  capture: CaptureAuthV2Diagnostic,
  signals: AuthV2ContinuationSignals,
): AuthV2ContinuationSignals {
  const runtime: DiagnosticCommandRuntime = {
    inFlight$: state<Promise<void> | null>(null),
  };
  const finish$ = command(
    (
      { get },
      attempt: DiagnosticAttempt,
    ): AuthV2DiagnosticProperties | null => {
      const result = diagnosticResult(
        continuationStateErrorCategory(get(signals.state$)),
      );
      return attempt.step === "recovery" && result.outcome === "success"
        ? null
        : diagnosticProperties(flow, attempt, result);
    },
  );
  const describeOrganization$ = command(
    ({ get }, organizationId: string): DiagnosticAttempt | null => {
      const flowState = get(signals.state$);
      if (
        flowState.status !== "incomplete" ||
        !flowState.organizations.some((organization) => {
          return organization.id === organizationId;
        })
      ) {
        return null;
      }
      return { method: "organization", step: "choose-organization" };
    },
  );

  return {
    ...signals,
    initialize$: createAsyncDiagnosticCommand(
      signals.initialize$,
      CONTINUATION_INITIALIZE_ATTEMPT$,
      finish$,
      capture,
      runtime,
    ),
    selectOrganization$: createValueDiagnosticCommand(
      signals.selectOrganization$,
      describeOrganization$,
      finish$,
      capture,
      runtime,
    ),
  };
}

export function createAuthV2Diagnostics(
  flow: AuthV2DiagnosticsFlow,
  capture: CaptureAuthV2Diagnostic,
): AuthV2Diagnostics {
  return {
    instrumentContinuation: (signals) => {
      return createContinuationInstrumentation(flow, capture, signals);
    },
    instrumentSignIn: (signals, options) => {
      return createSignInInstrumentation(flow, capture, signals, options);
    },
    instrumentSignUp: (signals, options) => {
      return createSignUpInstrumentation(flow, capture, signals, options);
    },
  };
}
