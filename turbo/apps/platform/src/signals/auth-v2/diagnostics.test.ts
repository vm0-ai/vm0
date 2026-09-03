import { command, computed, state, type Computed } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import type { AuthV2DiagnosticProperties } from "../../lib/posthog.ts";
import { testContext } from "../__tests__/test-helpers.ts";
import { createDeferredPromise, onRef } from "../utils.ts";
import {
  createAuthV2Diagnostics,
  type AuthV2SignInDiagnosticOptions,
  type AuthV2SignUpDiagnosticOptions,
} from "./diagnostics.ts";
import type { AuthV2ContinuationState } from "./continuation.ts";
import type {
  AuthV2SignInError,
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "./sign-in-flow.ts";
import type {
  AuthV2SignUpError,
  AuthV2SignUpSignals,
  AuthV2SignUpState,
} from "./sign-up-flow.ts";

const context = testContext();

const INACTIVE_CONTINUATION_STATE$ = computed((): AuthV2ContinuationState => {
  return { status: "inactive" };
});
const IDLE_CAPTCHA_STATE$ = computed((): "idle" => {
  return "idle";
});
const EMPTY_STRING$ = computed(() => {
  return "";
});
const TEST_EMAIL_ADDRESS$ = computed(() => {
  return "person@example.com";
});
const TRUE$ = computed(() => {
  return true;
});
const NULL$ = computed(() => {
  return null;
});
const READY_SIGN_IN_RESEND_STATE$ = computed(() => {
  return { remainingSeconds: 0, status: "ready" } as const;
});
const READY_SIGN_UP_RESEND_STATE$ = computed(() => {
  return { remainingSeconds: 0, status: "ready" } as const;
});
const TEST_PASSWORD$ = computed(() => {
  return "password";
});

const SIGN_IN_NO_OP$ = command((): void => {});
const SIGN_IN_NO_OP_REF$ = onRef(
  command((_context, _element: HTMLSpanElement, signal: AbortSignal): void => {
    signal.throwIfAborted();
  }),
);
const SIGN_IN_ASYNC_NO_OP$ = command(
  (_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);
const SIGN_IN_STRING_ASYNC_NO_OP$ = command(
  (_context, _value: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);

function createSignInHarness(options?: {
  readonly initialize?: () => Promise<void>;
  readonly submit?: () => Promise<void>;
  readonly submitState?: AuthV2SignInState;
}) {
  const flowState$ = state<AuthV2SignInState>({
    accounts: [],
    factors: [],
    identifierMode: "email",
    selectedFactor: null,
    status: "incomplete",
    step: "identifier",
  });
  const error$ = state<AuthV2SignInError | null>(null);
  const code$ = state("");
  const confirmPassword$ = state("");
  const identifier$ = state("person@example.com");
  const newPassword$ = state("");
  const password$ = state("");
  const signOutOfOtherSessions$ = state(true);
  const sourceSubmit = vi.fn(
    options?.submit ??
      (() => {
        return Promise.resolve();
      }),
  );
  const sourceInitialize = vi.fn(
    options?.initialize ??
      (() => {
        return Promise.resolve();
      }),
  );
  const initializeExternalStrategies$ = command(
    async (_context, signal: AbortSignal): Promise<void> => {
      await sourceInitialize();
      signal.throwIfAborted();
    },
  );
  const setCode$ = command(({ set }, value: string): void => {
    set(code$, value);
  });
  const setConfirmPassword$ = command(({ set }, value: string): void => {
    set(confirmPassword$, value);
  });
  const setIdentifier$ = command(({ set }, value: string): void => {
    set(identifier$, value);
  });
  const setNewPassword$ = command(({ set }, value: string): void => {
    set(newPassword$, value);
  });
  const setPassword$ = command(({ set }, value: string): void => {
    set(password$, value);
  });
  const setSignOutOfOtherSessions$ = command(
    ({ set }, value: boolean): void => {
      set(signOutOfOtherSessions$, value);
    },
  );
  const submit$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await sourceSubmit();
      signal.throwIfAborted();
      if (options?.submitState) {
        set(flowState$, options.submitState);
      }
    },
  );

  return {
    error$,
    flowState$,
    identifier$,
    signals: {
      backFromHelp$: SIGN_IN_NO_OP$,
      backFromMethods$: SIGN_IN_NO_OP$,
      backFromNewPassword$: SIGN_IN_NO_OP$,
      backFromPasswordRecovery$: SIGN_IN_NO_OP$,
      backToIdentifier$: SIGN_IN_NO_OP$,
      backToMethods$: SIGN_IN_NO_OP$,
      code$: computed((get) => {
        return get(code$);
      }),
      confirmPassword$: computed((get) => {
        return get(confirmPassword$);
      }),
      error$: computed((get) => {
        return get(error$);
      }),
      identifier$: computed((get) => {
        return get(identifier$);
      }),
      initialize$: SIGN_IN_ASYNC_NO_OP$,
      initializeExternalStrategies$,
      newPassword$: computed((get) => {
        return get(newPassword$);
      }),
      pendingFactorId$: NULL$,
      password$: computed((get) => {
        return get(password$);
      }),
      resendCode$: SIGN_IN_ASYNC_NO_OP$,
      resendCooldownLifecycleRef$: SIGN_IN_NO_OP_REF$,
      resendState$: READY_SIGN_IN_RESEND_STATE$,
      restart$: SIGN_IN_NO_OP$,
      selectFactor$: SIGN_IN_STRING_ASYNC_NO_OP$,
      selectSession$: SIGN_IN_STRING_ASYNC_NO_OP$,
      setCode$,
      setConfirmPassword$,
      setIdentifier$,
      setNewPassword$,
      setPassword$,
      setSignOutOfOtherSessions$,
      showHelp$: SIGN_IN_NO_OP$,
      showPasswordRecovery$: SIGN_IN_NO_OP$,
      signOutOfOtherSessions$: computed((get) => {
        return get(signOutOfOtherSessions$);
      }),
      state$: computed((get) => {
        return get(flowState$);
      }),
      submit$,
      useAnotherAccount$: SIGN_IN_NO_OP$,
    } satisfies AuthV2SignInSignals,
    sourceInitialize,
    sourceSubmit,
  };
}

function instrumentSignIn(
  signals: AuthV2SignInSignals,
  capture: (properties: AuthV2DiagnosticProperties) => void,
  continuationState$: Computed<AuthV2ContinuationState> = INACTIVE_CONTINUATION_STATE$,
): AuthV2SignInSignals {
  return createAuthV2Diagnostics("sign-in", capture).instrumentSignIn(signals, {
    continuationState$,
    isBaseRoute: false,
    isOAuthCallbackRoute: false,
  } satisfies AuthV2SignInDiagnosticOptions);
}

function createSignUpHarness(options?: {
  readonly startGoogleOAuth?: () => Promise<void>;
  readonly submit?: () => Promise<void>;
}) {
  const flowState$ = state<AuthV2SignUpState>({
    captchaEnabled: false,
    fields: {
      emailAddress: "required",
      firstName: "optional",
      lastName: "optional",
      password: "required",
    },
    legal: { privacyPolicyUrl: null, required: true, termsUrl: null },
    status: "incomplete",
    step: "details",
  });
  const error$ = state<AuthV2SignUpError | null>(null);
  const sourceSubmit = vi.fn(
    options?.submit ??
      (() => {
        return Promise.resolve();
      }),
  );
  const sourceGoogleOAuth = vi.fn(
    options?.startGoogleOAuth ??
      (() => {
        return Promise.resolve();
      }),
  );
  const noOp$ = command((): void => {});
  const setString$ = command((_context, _value: string): void => {});
  const setBoolean$ = command((_context, _value: boolean): void => {});
  const asyncNoOp$ = command((_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  });
  const captchaRef$ = onRef(
    command((_context, _element: HTMLDivElement, signal: AbortSignal): void => {
      signal.throwIfAborted();
    }),
  );
  const submit$ = command(
    async (_context, signal: AbortSignal): Promise<void> => {
      await sourceSubmit();
      signal.throwIfAborted();
    },
  );
  const startOAuth$ = command(
    async (
      _context,
      _strategy: "oauth_apple" | "oauth_google",
      signal: AbortSignal,
    ): Promise<void> => {
      await sourceGoogleOAuth();
      signal.throwIfAborted();
    },
  );
  return {
    signals: {
      backToDetails$: noOp$,
      captchaRef$,
      captchaState$: IDLE_CAPTCHA_STATE$,
      code$: EMPTY_STRING$,
      emailAddress$: TEST_EMAIL_ADDRESS$,
      error$: computed((get) => {
        return get(error$);
      }),
      firstName$: EMPTY_STRING$,
      initialize$: asyncNoOp$,
      lastName$: EMPTY_STRING$,
      legalAccepted$: TRUE$,
      oauthStrategies$: computed(() => {
        return ["oauth_google"] as const;
      }),
      pendingOAuthStrategy$: NULL$,
      password$: TEST_PASSWORD$,
      resendCode$: asyncNoOp$,
      resendCooldownLifecycleRef$: SIGN_IN_NO_OP_REF$,
      resendState$: READY_SIGN_UP_RESEND_STATE$,
      restart$: asyncNoOp$,
      setCode$: setString$,
      setEmailAddress$: setString$,
      setFirstName$: setString$,
      setLastName$: setString$,
      setLegalAccepted$: setBoolean$,
      setPassword$: setString$,
      startOAuth$,
      state$: computed((get) => {
        return get(flowState$);
      }),
      submit$,
    } satisfies AuthV2SignUpSignals,
    sourceGoogleOAuth,
    sourceSubmit,
  };
}

function instrumentSignUp(
  signals: AuthV2SignUpSignals,
  capture: (properties: AuthV2DiagnosticProperties) => void,
  continuationState$: Computed<AuthV2ContinuationState> = INACTIVE_CONTINUATION_STATE$,
): AuthV2SignUpSignals {
  return createAuthV2Diagnostics("sign-up", capture).instrumentSignUp(signals, {
    continuationState$,
    isOAuthCallbackRoute: false,
  } satisfies AuthV2SignUpDiagnosticOptions);
}

describe("auth v2 diagnostic attempt ownership", () => {
  it("coalesces concurrent retries but preserves sequential user attempts", async () => {
    const deferred = createDeferredPromise<void>(context.signal);
    const harness = createSignInHarness({
      submit: async () => {
        await deferred.promise;
      },
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignIn(harness.signals, capture);

    const firstAttempt = context.store.set(signals.submit$, context.signal);
    const coalescedRetry = context.store.set(signals.submit$, context.signal);

    expect(harness.sourceSubmit).toHaveBeenCalledOnce();
    deferred.resolve();
    await Promise.all([firstAttempt, coalescedRetry]);

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenLastCalledWith({
      error_category: "none",
      flow: "sign-in",
      method: "identifier",
      outcome: "success",
      step: "identifier",
    });

    await context.store.set(signals.submit$, context.signal);

    expect(harness.sourceSubmit).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("coalesces different commands that share one source operation", async () => {
    const deferred = createDeferredPromise<void>(context.signal);
    const harness = createSignUpHarness({
      submit: async () => {
        await deferred.promise;
      },
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignUp(harness.signals, capture);

    const passwordAttempt = context.store.set(signals.submit$, context.signal);
    const coalescedGoogleAttempt = context.store.set(
      signals.startOAuth$,
      "oauth_google",
      context.signal,
    );

    expect(harness.sourceSubmit).toHaveBeenCalledOnce();
    expect(harness.sourceGoogleOAuth).not.toHaveBeenCalled();
    deferred.resolve();
    await Promise.all([passwordAttempt, coalescedGoogleAttempt]);

    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenLastCalledWith({
      error_category: "none",
      flow: "sign-up",
      method: "password",
      outcome: "success",
      step: "details",
    });

    await context.store.set(
      signals.startOAuth$,
      "oauth_google",
      context.signal,
    );

    expect(harness.sourceGoogleOAuth).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("keeps resource attempts independent from pending initialization", async () => {
    const initializationDeferred = createDeferredPromise<void>(context.signal);
    const harness = createSignInHarness({
      initialize: async () => {
        await initializationDeferred.promise;
      },
      submitState: { status: "complete" },
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = createAuthV2Diagnostics(
      "sign-in",
      capture,
    ).instrumentSignIn(harness.signals, {
      continuationState$: INACTIVE_CONTINUATION_STATE$,
      isBaseRoute: true,
      isOAuthCallbackRoute: false,
    });

    const initialization = context.store.set(
      signals.initializeExternalStrategies$,
      context.signal,
    );
    expect(harness.sourceInitialize).toHaveBeenCalledOnce();

    await context.store.set(signals.submit$, context.signal);

    expect(harness.sourceSubmit).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenLastCalledWith({
      error_category: "none",
      flow: "sign-in",
      method: "identifier",
      outcome: "success",
      step: "identifier",
    });

    initializationDeferred.resolve();
    await initialization;

    expect(capture).toHaveBeenCalledOnce();
  });
});

describe("auth v2 diagnostic continuation outcomes", () => {
  it("reports sign-in session activation failures from continuation", async () => {
    const continuationState$ = state<AuthV2ContinuationState>({
      status: "inactive",
    });
    const harness = createSignInHarness({
      submit: () => {
        context.store.set(continuationState$, {
          reason: "activation-failed",
          status: "failure",
        });
        return Promise.resolve();
      },
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignIn(
      harness.signals,
      capture,
      computed((get) => {
        return get(continuationState$);
      }),
    );

    await context.store.set(signals.submit$, context.signal);

    expect(capture).toHaveBeenLastCalledWith({
      error_category: "session-unavailable",
      flow: "sign-in",
      method: "identifier",
      outcome: "failure",
      step: "identifier",
    });
  });

  it("reports sign-up session activation failures from continuation", async () => {
    const continuationState$ = state<AuthV2ContinuationState>({
      status: "inactive",
    });
    const harness = createSignUpHarness({
      submit: () => {
        context.store.set(continuationState$, {
          reason: "activation-failed",
          status: "failure",
        });
        return Promise.resolve();
      },
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignUp(
      harness.signals,
      capture,
      computed((get) => {
        return get(continuationState$);
      }),
    );

    await context.store.set(signals.submit$, context.signal);

    expect(capture).toHaveBeenLastCalledWith({
      error_category: "session-unavailable",
      flow: "sign-up",
      method: "password",
      outcome: "failure",
      step: "details",
    });
  });
});

describe("auth v2 diagnostic privacy", () => {
  it.each([
    {
      error: { code: "access-not-allowed", field: "general" },
      expectedCategory: "invalid-credentials",
    },
    {
      error: { code: "user-banned", field: "general" },
      expectedCategory: "invalid-credentials",
    },
    {
      error: { code: "code-expired", field: "code" },
      expectedCategory: "invalid-code",
    },
  ] as const)(
    "maps $error.code to $expectedCategory",
    async ({ error, expectedCategory }) => {
      const harness = createSignInHarness();
      context.store.set(harness.error$, error);
      const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
      const signals = instrumentSignIn(harness.signals, capture);

      await context.store.set(signals.submit$, context.signal);

      expect(capture).toHaveBeenLastCalledWith({
        error_category: expectedCategory,
        flow: "sign-in",
        method: "identifier",
        outcome: "failure",
        step: "identifier",
      });
    },
  );

  it("does not report rerenders or successful refresh recovery", async () => {
    const harness = createSignInHarness();
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignIn(harness.signals, capture);

    context.store.get(signals.state$);
    context.store.get(signals.state$);
    context.store.set(harness.flowState$, {
      accounts: [],
      factors: [],
      identifierMode: "email",
      selectedFactor: null,
      status: "incomplete",
      step: "identifier",
    });
    context.store.get(signals.state$);
    await context.store.set(
      signals.initializeExternalStrategies$,
      context.signal,
    );
    await context.store.set(
      signals.initializeExternalStrategies$,
      context.signal,
    );

    expect(capture).not.toHaveBeenCalled();
  });

  it("maps provider errors to closed categories without forwarding secrets", async () => {
    const providerCode = "provider_code_sensitive_4d0ad5";
    const identifier = "private.person@example.com";
    const harness = createSignInHarness();
    context.store.set(harness.identifier$, identifier);
    context.store.set(harness.error$, {
      clerkCode: providerCode,
      code: "clerk",
      field: "general",
    });
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignIn(harness.signals, capture);

    await context.store.set(signals.submit$, context.signal);

    expect(capture).toHaveBeenLastCalledWith({
      error_category: "provider-error",
      flow: "sign-in",
      method: "identifier",
      outcome: "failure",
      step: "identifier",
    });

    context.store.set(harness.error$, {
      code: "unknown",
      field: "general",
    });
    await context.store.set(signals.submit$, context.signal);

    expect(capture).toHaveBeenLastCalledWith({
      error_category: "unknown",
      flow: "sign-in",
      method: "identifier",
      outcome: "failure",
      step: "identifier",
    });
    const serializedCalls = JSON.stringify(capture.mock.calls);
    expect(serializedCalls).not.toContain(providerCode);
    expect(serializedCalls).not.toContain(identifier);
  });
});
