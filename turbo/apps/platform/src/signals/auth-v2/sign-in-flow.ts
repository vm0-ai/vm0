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
import {
  discoverAuthV2ExistingAccounts,
  discoverAuthV2ExternalCapabilities,
  type AuthV2ExistingAccount,
  type AuthV2ExternalCapabilities,
  recoverAuthV2GoogleOAuth,
  requestGoogleOneTapCredential,
  startAuthV2GoogleOAuth,
} from "./sign-in-external-strategies.ts";
import type { AuthV2ContinuationFlowHandoff } from "./continuation.ts";
import type { AuthV2Navigation } from "./navigation.ts";

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
      readonly id: "oauth:oauth_google";
      readonly kind: "oauth";
      readonly strategy: "oauth_google";
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
  | "email-code"
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
  readonly code:
    | "clerk"
    | "passkey-cancelled"
    | "passkey-unavailable"
    | "password-mismatch"
    | "unknown";
  readonly field: AuthV2SignInErrorField;
  readonly message?: string;
}

interface SignInResourceSnapshot {
  readonly clerkStatus: string | null;
  readonly createdSessionId: string | null;
  readonly factors: readonly AuthV2SignInFactor[];
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
  readonly selectSession$: Command<Promise<void>, [string, AbortSignal]>;
  readonly setCode$: Command<void, [string]>;
  readonly setConfirmPassword$: Command<void, [string]>;
  readonly setIdentifier$: Command<void, [string]>;
  readonly setNewPassword$: Command<void, [string]>;
  readonly setPassword$: Command<void, [string]>;
  readonly state$: Computed<AuthV2SignInState>;
  readonly submit$: Command<Promise<void>, [AbortSignal]>;
  readonly useAnotherAccount$: Command<void, []>;
}

type CoalescedOperation = "one-tap" | "resource";
type AuthV2SignInUnknownState = Extract<
  AuthV2SignInState,
  { status: "unknown" }
>;

interface SignInFlowAtoms {
  readonly accounts$: State<readonly AuthV2ExistingAccount[]>;
  readonly capabilities$: State<AuthV2ExternalCapabilities>;
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
  readonly useAnotherAccount$: State<boolean>;
}

interface SignInFlowRuntime {
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
    googleOAuth: false,
    googleOneTapClientId: null,
    passkey: false,
  };
}

interface FactorDiscovery {
  readonly factors: readonly AuthV2SignInFactor[];
  readonly unknownStrategies: readonly string[];
}

function discoverFactors(
  factors: readonly SignInFirstFactor[] | null,
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
    } else if (factor.strategy === "oauth_google") {
      discovered.push({
        id: "oauth:oauth_google",
        kind: "oauth",
        strategy: "oauth_google",
      });
    } else if (factor.strategy === "passkey") {
      discovered.push({ id: "passkey", kind: "passkey" });
    } else {
      unknownStrategies.push(factor.strategy);
    }
  }
  return { factors: discovered, unknownStrategies };
}

function entryFactors(
  capabilities: AuthV2ExternalCapabilities,
): readonly AuthV2SignInFactor[] {
  const factors: AuthV2SignInFactor[] = [];
  if (capabilities.googleOAuth) {
    factors.push({
      id: "oauth:oauth_google",
      kind: "oauth",
      strategy: "oauth_google",
    });
  }
  if (capabilities.passkey) {
    factors.push({ id: "passkey", kind: "passkey" });
  }
  return factors;
}

function snapshotSignInResource(
  resource: SignInResource,
  capabilities: AuthV2ExternalCapabilities,
): SignInResourceSnapshot {
  // The legacy resource is the stable low-level API used by this app. Clerk
  // exposes transferability on its future view, so keep that SDK detail
  // isolated in this adapter rather than leaking it into the flow or view.
  const discovered = discoverFactors(resource.supportedFirstFactors);
  const factors =
    resource.status === "needs_identifier" || resource.status === null
      ? entryFactors(capabilities)
      : discovered.factors;
  return {
    clerkStatus: resource.status,
    createdSessionId: resource.createdSessionId,
    factors,
    transferable: resource.__internal_future.isTransferable,
    unknownFactorStrategies: discovered.unknownStrategies,
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
  if (!isRecord(error)) {
    return { code: "unknown", field: fallbackField };
  }
  const apiError = Array.isArray(error.errors)
    ? error.errors.find(isRecord)
    : null;
  const normalizedError = apiError ?? error;
  const clerkCode = stringProperty(normalizedError, "code");
  if (!apiError && !clerkCode) {
    return { code: "unknown", field: fallbackField };
  }
  const message =
    stringProperty(normalizedError, "longMessage") ??
    stringProperty(normalizedError, "message");
  const code =
    clerkCode === "passkey_retrieval_cancelled" ||
    clerkCode === "passkey_operation_aborted"
      ? "passkey-cancelled"
      : clerkCode === "passkey_not_supported" ||
          clerkCode === "passkey_pa_not_supported"
        ? "passkey-unavailable"
        : "clerk";
  return {
    code,
    field: clerkErrorField(normalizedError, fallbackField),
    ...(message ? { message } : {}),
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
    selectedFactor,
    status: "incomplete",
    step,
  };
}

interface DeriveSignInFlowOptions {
  readonly accounts: readonly AuthV2ExistingAccount[];
  readonly editIdentifier: boolean;
  readonly fatalState: AuthV2SignInUnknownState | null;
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
  if (factor?.kind === "password-reset") {
    return "password-reset-code";
  }
  return "choose-factor";
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
    const currentFactor = selectedFactorForSnapshot(
      snapshot,
      options.selectedFactor,
    );
    return incompleteState(
      snapshot,
      options.accounts,
      stepForSelectedFactor(currentFactor),
      currentFactor,
    );
  }
  if (snapshot.clerkStatus === "needs_new_password") {
    return incompleteState(
      snapshot,
      options.accounts,
      "new-password",
      options.selectedFactor,
    );
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
  const editIdentifier$ = state(false);
  const fatalState$ = state<AuthV2SignInUnknownState | null>(null);
  const error$ = state<AuthV2SignInError | null>(null);
  const identifier$ = state("");
  const password$ = state("");
  const code$ = state("");
  const newPassword$ = state("");
  const confirmPassword$ = state("");
  const useAnotherAccount$ = state(false);
  const state$ = computed((get) => {
    return deriveSignInFlowState(get(snapshot$), {
      accounts: get(accounts$),
      editIdentifier: get(editIdentifier$),
      fatalState: get(fatalState$),
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
    identifier$,
    newPassword$,
    password$,
    selectedFactor$,
    snapshot$,
    state$,
    useAnotherAccount$,
  };
}

function createSignInFlowRuntime(): SignInFlowRuntime {
  return {
    handledSessionId$: state<string | null>(null),
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
  const applyResource$ = command(
    async (
      { get, set },
      resource: SignInResource,
      signal: AbortSignal,
    ): Promise<void> => {
      const snapshot = snapshotSignInResource(
        resource,
        get(atoms.capabilities$),
      );
      set(atoms.snapshot$, snapshot);
      set(atoms.fatalState$, null);
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

  const initialize$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (!clerk.client) {
        throw new Error(
          "Loaded Clerk instance did not provide a client resource",
        );
      }
      set(atoms.capabilities$, discoverAuthV2ExternalCapabilities(clerk));

      if (dependencies.isOAuthCallbackRoute) {
        const recovery = await settle(
          recoverAuthV2GoogleOAuth(clerk, dependencies.navigation),
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

function createFactorSelectionCommand(
  atoms: SignInFlowAtoms,
  runtime: SignInFlowRuntime,
  applyResource$: ApplySignInResourceCommand,
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
        set(atoms.selectedFactor$, factor);
        return;
      }

      const resource = await get(clerkSignInResource$);
      signal.throwIfAborted();
      if (factor.kind === "oauth") {
        const redirect = await settle(
          startAuthV2GoogleOAuth(resource, dependencies.navigation),
          signal,
        );
        if (!redirect.ok) {
          set(atoms.error$, normalizeClerkError(redirect.error, "general"));
        }
        return;
      }
      if (factor.kind === "passkey") {
        const authentication = await settle(
          resource.authenticateWithPasskey({ flow: "discoverable" }),
          signal,
        );
        if (!authentication.ok) {
          set(
            atoms.error$,
            normalizeClerkError(authentication.error, "general"),
          );
          return;
        }
        await set(applyResource$, authentication.value, signal);
        signal.throwIfAborted();
        return;
      }
      if (get(runtime.preparedFactorId$) === factor.id) {
        set(atoms.selectedFactor$, factor);
        return;
      }
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
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const factor = get(atoms.selectedFactor$);
    if (
      !factor ||
      (factor.kind !== "email-code" && factor.kind !== "password-reset")
    ) {
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
    set(atoms.useAnotherAccount$, true);
    set(atoms.selectedFactor$, null);
    set(atoms.code$, "");
    set(atoms.password$, "");
    set(atoms.error$, null);
  });
  const restart$ = command(({ get, set }) => {
    set(runtime.preparedFactorId$, null);
    set(atoms.snapshot$, {
      clerkStatus: "needs_identifier",
      createdSessionId: null,
      factors: entryFactors(get(atoms.capabilities$)),
      transferable: false,
      unknownFactorStrategies: [],
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
    set(atoms.useAnotherAccount$, true);
  });
  const useAnotherAccount$ = command(({ set }) => {
    set(atoms.useAnotherAccount$, true);
    set(atoms.error$, null);
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
    useAnotherAccount$,
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
    password$: computed((get) => {
      return get(atoms.password$);
    }),
    resendCode$: createCoalescedOperation$(
      runtime,
      "resource",
      resendCodeOperation$,
    ),
    selectFactor$: createFactorSelectionCommand(
      atoms,
      runtime,
      applyResource$,
      dependencies,
    ),
    selectSession$: createSessionSelectionCommand(
      atoms,
      runtime,
      dependencies.continuation.completeSession$,
    ),
    state$: atoms.state$,
    submit$: createCoalescedOperation$(runtime, "resource", submitOperation$),
  };
}
