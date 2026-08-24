import type { Clerk } from "@clerk/clerk-js";
import type {
  PrepareFirstFactorParams,
  SignInFirstFactor,
  SignInResource,
} from "@clerk/react/types";
import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";

import { clerk$ } from "../auth.ts";
import { settle, withCleanup } from "../utils.ts";

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
    };

export type AuthV2SignInStep =
  | "identifier"
  | "choose-factor"
  | "password"
  | "email-code"
  | "password-reset-code"
  | "new-password";

export type AuthV2SignInUnknownReason =
  | "activation-failed"
  | "missing-session"
  | "unsupported-factor"
  | "unsupported-status";

export type AuthV2SignInState =
  | { readonly status: "loading" }
  | {
      readonly factors: readonly AuthV2SignInFactor[];
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
  readonly code: "clerk" | "password-mismatch" | "unknown";
  readonly field: AuthV2SignInErrorField;
  readonly message?: string;
}

interface SignInResourceSnapshot {
  readonly clerkStatus: string | null;
  readonly createdSessionId: string | null;
  readonly factors: readonly AuthV2SignInFactor[];
  readonly transferable: boolean;
}

export interface AuthV2SignInFlowDependencies {
  readonly resolveRedirectUrl: () => string;
}

export interface AuthV2SignInSignals {
  readonly backToIdentifier$: Command<void, []>;
  readonly backToMethods$: Command<void, []>;
  readonly code$: Computed<string>;
  readonly confirmPassword$: Computed<string>;
  readonly error$: Computed<AuthV2SignInError | null>;
  readonly identifier$: Computed<string>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly newPassword$: Computed<string>;
  readonly password$: Computed<string>;
  readonly resendCode$: Command<Promise<void>, [AbortSignal]>;
  readonly restart$: Command<void, []>;
  readonly selectFactor$: Command<Promise<void>, [string, AbortSignal]>;
  readonly setCode$: Command<void, [string]>;
  readonly setConfirmPassword$: Command<void, [string]>;
  readonly setIdentifier$: Command<void, [string]>;
  readonly setNewPassword$: Command<void, [string]>;
  readonly setPassword$: Command<void, [string]>;
  readonly state$: Computed<AuthV2SignInState>;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
}

type CoalescedOperation = "resource";
type AuthV2SignInUnknownState = Extract<
  AuthV2SignInState,
  { status: "unknown" }
>;

interface SignInFlowAtoms {
  readonly code$: State<string>;
  readonly confirmPassword$: State<string>;
  readonly editIdentifier$: State<boolean>;
  readonly error$: State<AuthV2SignInError | null>;
  readonly fatalState$: State<AuthV2SignInUnknownState | null>;
  readonly identifier$: State<string>;
  readonly newPassword$: State<string>;
  readonly password$: State<string>;
  readonly selectedFactor$: State<AuthV2SignInFactor | null>;
  readonly snapshot$: State<SignInResourceSnapshot | null>;
  readonly state$: Computed<AuthV2SignInState>;
}

interface SignInFlowRuntime {
  readonly activatedSessionId$: State<string | null>;
  readonly activation$: State<{
    readonly promise: Promise<void>;
    readonly sessionId: string;
  } | null>;
  readonly inFlight$: State<ReadonlyMap<CoalescedOperation, Promise<void>>>;
  readonly preparedFactorId$: State<string | null>;
}

type ApplySignInResourceCommand = Command<
  Promise<void>,
  [SignInResource, AbortSignal]
>;

function discoverFactors(
  factors: readonly SignInFirstFactor[] | null,
): readonly AuthV2SignInFactor[] {
  if (!factors) {
    return [];
  }

  return factors.flatMap((factor): AuthV2SignInFactor[] => {
    if (factor.strategy === "password") {
      return [{ id: "password", kind: "password" }];
    }
    if (factor.strategy === "email_code") {
      return [
        {
          emailAddressId: factor.emailAddressId,
          id: `email-code:${factor.emailAddressId}`,
          kind: "email-code",
          safeIdentifier: factor.safeIdentifier,
        },
      ];
    }
    if (factor.strategy === "reset_password_email_code") {
      return [
        {
          emailAddressId: factor.emailAddressId,
          id: `password-reset:${factor.emailAddressId}`,
          kind: "password-reset",
          safeIdentifier: factor.safeIdentifier,
        },
      ];
    }
    return [];
  });
}

function snapshotSignInResource(
  resource: SignInResource,
): SignInResourceSnapshot {
  // The legacy resource is the stable low-level API used by this app. Clerk
  // exposes transferability on its future view, so keep that SDK detail
  // isolated in this adapter rather than leaking it into the flow or view.
  return {
    clerkStatus: resource.status,
    createdSessionId: resource.createdSessionId,
    factors: discoverFactors(resource.supportedFirstFactors),
    transferable: resource.__internal_future.isTransferable,
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

function normalizeClerkError(
  error: unknown,
  fallbackField: AuthV2SignInErrorField,
): AuthV2SignInError {
  if (isRecord(error) && Array.isArray(error.errors)) {
    const firstError = error.errors.find(isRecord);
    if (firstError) {
      const message =
        stringProperty(firstError, "longMessage") ??
        stringProperty(firstError, "message");
      return {
        code: "clerk",
        field: clerkErrorField(firstError, fallbackField),
        ...(message ? { message } : {}),
      };
    }
  }
  return { code: "unknown", field: fallbackField };
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
  step: AuthV2SignInStep,
  selectedFactor: AuthV2SignInFactor | null = null,
): AuthV2SignInState {
  return {
    factors: snapshot.factors,
    selectedFactor,
    status: "incomplete",
    step,
  };
}

function deriveSignInFlowState(
  snapshot: SignInResourceSnapshot | null,
  selectedFactor: AuthV2SignInFactor | null,
  editIdentifier: boolean,
  fatalState: AuthV2SignInUnknownState | null,
): AuthV2SignInState {
  if (fatalState) {
    return fatalState;
  }
  if (!snapshot) {
    return { status: "loading" };
  }
  if (snapshot.transferable) {
    return { status: "transfer" };
  }
  if (
    editIdentifier ||
    snapshot.clerkStatus === "needs_identifier" ||
    snapshot.clerkStatus === null
  ) {
    return incompleteState(snapshot, "identifier");
  }
  if (snapshot.clerkStatus === "needs_first_factor") {
    if (snapshot.factors.length === 0) {
      return {
        clerkStatus: snapshot.clerkStatus,
        reason: "unsupported-factor",
        status: "unknown",
      };
    }
    const currentFactor = selectedFactorForSnapshot(snapshot, selectedFactor);
    const step =
      currentFactor?.kind === "password"
        ? "password"
        : currentFactor?.kind === "email-code"
          ? "email-code"
          : currentFactor?.kind === "password-reset"
            ? "password-reset-code"
            : "choose-factor";
    return incompleteState(snapshot, step, currentFactor);
  }
  if (snapshot.clerkStatus === "needs_new_password") {
    return incompleteState(snapshot, "new-password", selectedFactor);
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
  const snapshot$ = state<SignInResourceSnapshot | null>(null);
  const selectedFactor$ = state<AuthV2SignInFactor | null>(null);
  const editIdentifier$ = state(false);
  const fatalState$ = state<AuthV2SignInUnknownState | null>(null);
  const error$ = state<AuthV2SignInError | null>(null);
  const identifier$ = state("");
  const password$ = state("");
  const code$ = state("");
  const newPassword$ = state("");
  const confirmPassword$ = state("");
  const state$ = computed((get) => {
    return deriveSignInFlowState(
      get(snapshot$),
      get(selectedFactor$),
      get(editIdentifier$),
      get(fatalState$),
    );
  });
  return {
    code$,
    confirmPassword$,
    editIdentifier$,
    error$,
    fatalState$,
    identifier$,
    newPassword$,
    password$,
    selectedFactor$,
    snapshot$,
    state$,
  };
}

function createSignInFlowRuntime(): SignInFlowRuntime {
  return {
    activatedSessionId$: state<string | null>(null),
    activation$: state<{
      readonly promise: Promise<void>;
      readonly sessionId: string;
    } | null>(null),
    inFlight$: state<ReadonlyMap<CoalescedOperation, Promise<void>>>(new Map()),
    preparedFactorId$: state<string | null>(null),
  };
}

function createResourceCommands(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  dependencies: AuthV2SignInFlowDependencies,
): {
  readonly applyResource$: ApplySignInResourceCommand;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
} {
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
  const activateSession$ = command(
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

  const applyResource$ = command(
    async (
      { set },
      resource: SignInResource,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = snapshotSignInResource(resource);
      set(atoms.snapshot$, snapshot);
      set(atoms.fatalState$, null);
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
        set(atoms.fatalState$, {
          clerkStatus: snapshot.clerkStatus,
          reason: "activation-failed",
          status: "unknown",
        });
      }
    },
  );

  const initialize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const resource = await get(clerkSignInResource$);
      signal.throwIfAborted();
      await set(applyResource$, resource, signal);
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
    let fallbackField: AuthV2SignInErrorField = "general";
    let request: Promise<SignInResource> | null = null;

    if (flowState.step === "identifier") {
      const identifier = get(atoms.identifier$).trim();
      if (!identifier) {
        return;
      }
      fallbackField = "identifier";
      set(runtime.preparedFactorId$, null);
      request = resource.create({ identifier });
    } else if (flowState.step === "password") {
      const password = get(atoms.password$);
      if (!password) {
        return;
      }
      fallbackField = "password";
      request = resource.attemptFirstFactor({
        password,
        strategy: "password",
      });
    } else if (
      flowState.step === "email-code" ||
      flowState.step === "password-reset-code"
    ) {
      const code = get(atoms.code$).trim();
      if (!code) {
        return;
      }
      fallbackField = "code";
      request = resource.attemptFirstFactor({
        code,
        strategy:
          flowState.step === "email-code"
            ? "email_code"
            : "reset_password_email_code",
      });
    } else if (flowState.step === "new-password") {
      const password = get(atoms.newPassword$);
      if (!password) {
        return;
      }
      fallbackField = "new-password";
      if (password !== get(atoms.confirmPassword$)) {
        set(atoms.error$, {
          code: "password-mismatch",
          field: "new-password",
        });
        return;
      }
      request = resource.resetPassword({ password });
    } else {
      return;
    }

    const result = await settle(request, signal);
    if (!result.ok) {
      set(atoms.error$, normalizeClerkError(result.error, fallbackField));
      return;
    }
    if (flowState.step === "identifier") {
      set(atoms.editIdentifier$, false);
      set(atoms.selectedFactor$, null);
    }
    await set(applyResource$, result.value, signal);
    signal.throwIfAborted();
  });
}

function factorPreparation(
  factor: Exclude<AuthV2SignInFactor, { kind: "password" }>,
): PrepareFirstFactorParams {
  return {
    emailAddressId: factor.emailAddressId,
    strategy:
      factor.kind === "email-code" ? "email_code" : "reset_password_email_code",
  };
}

function createFactorSelectionCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
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
      if (
        factor.kind === "password" ||
        get(runtime.preparedFactorId$) === factor.id
      ) {
        set(atoms.selectedFactor$, factor);
        return;
      }

      const resource = await get(clerkSignInResource$);
      signal.throwIfAborted();
      const prepared = await settle(
        resource.prepareFirstFactor(factorPreparation(factor)),
        signal,
      );
      if (!prepared.ok) {
        set(atoms.error$, normalizeClerkError(prepared.error, "general"));
        return;
      }
      set(runtime.preparedFactorId$, factor.id);
      await set(applyResource$, prepared.value, signal);
      signal.throwIfAborted();
      set(atoms.selectedFactor$, factor);
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
      });
      signal.throwIfAborted();
    },
  );
}

function createResendCodeOperation$(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const factor = get(atoms.selectedFactor$);
    if (!factor || factor.kind === "password") {
      return;
    }

    const resource = await get(clerkSignInResource$);
    signal.throwIfAborted();
    set(atoms.error$, null);
    const prepared = await settle(
      resource.prepareFirstFactor(factorPreparation(factor)),
      signal,
    );
    if (!prepared.ok) {
      set(atoms.error$, normalizeClerkError(prepared.error, "code"));
      return;
    }
    set(runtime.preparedFactorId$, factor.id);
    await set(applyResource$, prepared.value, signal);
    signal.throwIfAborted();
  });
}

function createFormCommands(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
) {
  const backToMethods$ = command(({ set }) => {
    set(atoms.selectedFactor$, null);
    set(atoms.code$, "");
    set(atoms.password$, "");
    set(atoms.error$, null);
  });
  const backToIdentifier$ = command(({ set }) => {
    set(atoms.editIdentifier$, true);
    set(atoms.selectedFactor$, null);
    set(atoms.code$, "");
    set(atoms.password$, "");
    set(atoms.error$, null);
  });
  const restart$ = command(({ set }) => {
    set(runtime.preparedFactorId$, null);
    set(atoms.snapshot$, {
      clerkStatus: "needs_identifier",
      createdSessionId: null,
      factors: [],
      transferable: false,
    });
    set(atoms.selectedFactor$, null);
    set(atoms.editIdentifier$, false);
    set(atoms.fatalState$, null);
    set(atoms.error$, null);
    set(atoms.identifier$, "");
    set(atoms.password$, "");
    set(atoms.code$, "");
    set(atoms.newPassword$, "");
    set(atoms.confirmPassword$, "");
  });
  const setIdentifier$ = command(({ set }, value: string) => {
    set(atoms.identifier$, value);
    set(atoms.error$, null);
  });
  const setPassword$ = command(({ set }, value: string) => {
    set(atoms.password$, value);
    set(atoms.error$, null);
  });
  const setCode$ = command(({ set }, value: string) => {
    set(atoms.code$, value);
    set(atoms.error$, null);
  });
  const setNewPassword$ = command(({ set }, value: string) => {
    set(atoms.newPassword$, value);
    set(atoms.error$, null);
  });
  const setConfirmPassword$ = command(({ set }, value: string) => {
    set(atoms.confirmPassword$, value);
    set(atoms.error$, null);
  });
  return {
    backToIdentifier$,
    backToMethods$,
    restart$,
    setCode$,
    setConfirmPassword$,
    setIdentifier$,
    setNewPassword$,
    setPassword$,
  };
}

export function createAuthV2SignInSignals(
  dependencies: AuthV2SignInFlowDependencies,
): AuthV2SignInSignals {
  const atoms = createSignInFlowAtoms();
  const runtime = createSignInFlowRuntime();
  const { applyResource$, initialize$ } = createResourceCommands(
    atoms,
    runtime,
    dependencies,
  );
  const submitOperation$ = createSubmitOperation$(
    atoms,
    runtime,
    applyResource$,
  );
  const resendCodeOperation$ = createResendCodeOperation$(
    atoms,
    runtime,
    applyResource$,
  );
  const formCommands = createFormCommands(atoms, runtime);
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
    initialize$,
    newPassword$: computed((get) => {
      return get(atoms.newPassword$);
    }),
    password$: computed((get) => {
      return get(atoms.password$);
    }),
    resendCode$: createCoalescedOperation$(
      runtime,
      "resource",
      resendCodeOperation$,
    ),
    selectFactor$: createFactorSelectionCommand(atoms, runtime, applyResource$),
    state$: atoms.state$,
    submit$: createCoalescedOperation$(runtime, "resource", submitOperation$),
  };
}

const authV2SignInSignals = createAuthV2SignInSignals({
  // Redirect, brand, and attribution policy intentionally live outside the
  // flow. The parallel redirect track can replace this resolver without
  // changing Clerk operations or activation ownership.
  resolveRedirectUrl: () => {
    return "/";
  },
});

export const authV2SignInSignals$ = computed(() => {
  return authV2SignInSignals;
});
