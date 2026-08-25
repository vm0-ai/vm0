import { command, computed, state } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import type { AuthV2DiagnosticProperties } from "../../lib/posthog.ts";
import { testContext } from "../__tests__/test-helpers.ts";
import { createDeferredPromise } from "../utils.ts";
import {
  createAuthV2Diagnostics,
  type AuthV2SignInDiagnosticOptions,
} from "./diagnostics.ts";
import type {
  AuthV2SignInError,
  AuthV2SignInSignals,
  AuthV2SignInState,
} from "./sign-in-flow.ts";

const context = testContext();

function createSignInHarness(options?: {
  readonly submit?: () => Promise<void>;
}) {
  const flowState$ = state<AuthV2SignInState>({
    accounts: [],
    factors: [],
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
  const sourceSubmit = vi.fn(
    options?.submit ??
      (() => {
        return Promise.resolve();
      }),
  );
  const noOp$ = command((): void => {});
  const asyncNoOp$ = command((_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  });
  const stringAsyncNoOp$ = command(
    (_context, _value: string, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      return Promise.resolve();
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
  const submit$ = command(
    async (_context, signal: AbortSignal): Promise<void> => {
      await sourceSubmit();
      signal.throwIfAborted();
    },
  );

  return {
    error$,
    flowState$,
    identifier$,
    signals: {
      backToIdentifier$: noOp$,
      backToMethods$: noOp$,
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
      initialize$: asyncNoOp$,
      newPassword$: computed((get) => {
        return get(newPassword$);
      }),
      password$: computed((get) => {
        return get(password$);
      }),
      resendCode$: asyncNoOp$,
      restart$: noOp$,
      selectFactor$: stringAsyncNoOp$,
      selectSession$: stringAsyncNoOp$,
      setCode$,
      setConfirmPassword$,
      setIdentifier$,
      setNewPassword$,
      setPassword$,
      state$: computed((get) => {
        return get(flowState$);
      }),
      submit$,
      useAnotherAccount$: noOp$,
    } satisfies AuthV2SignInSignals,
    sourceSubmit,
  };
}

function instrumentSignIn(
  signals: AuthV2SignInSignals,
  capture: (properties: AuthV2DiagnosticProperties) => void,
): AuthV2SignInSignals {
  return createAuthV2Diagnostics("sign-in", capture).instrumentSignIn(signals, {
    isBaseRoute: false,
    isOAuthCallbackRoute: false,
  } satisfies AuthV2SignInDiagnosticOptions);
}

describe("auth v2 diagnostics", () => {
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

  it("does not report rerenders or successful refresh recovery", async () => {
    const harness = createSignInHarness();
    const capture = vi.fn<(properties: AuthV2DiagnosticProperties) => void>();
    const signals = instrumentSignIn(harness.signals, capture);

    context.store.get(signals.state$);
    context.store.get(signals.state$);
    context.store.set(harness.flowState$, {
      accounts: [],
      factors: [],
      selectedFactor: null,
      status: "incomplete",
      step: "identifier",
    });
    context.store.get(signals.state$);
    await context.store.set(signals.initialize$, context.signal);
    await context.store.set(signals.initialize$, context.signal);

    expect(capture).not.toHaveBeenCalled();
  });

  it("maps provider errors to closed categories without forwarding secrets", async () => {
    const providerMessage = "raw message for private.person@example.com";
    const providerPayload = "provider_payload_sensitive_4d0ad5";
    const identifier = "private.person@example.com";
    const harness = createSignInHarness();
    context.store.set(harness.identifier$, identifier);
    context.store.set(harness.error$, {
      code: "clerk",
      field: "general",
      message: `${providerMessage} ${providerPayload}`,
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
      message: "arbitrary unmapped failure text",
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
    expect(serializedCalls).not.toContain(providerMessage);
    expect(serializedCalls).not.toContain(providerPayload);
    expect(serializedCalls).not.toContain(identifier);
    expect(serializedCalls).not.toContain("arbitrary unmapped failure text");
  });
});
