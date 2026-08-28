import type { Clerk } from "@clerk/clerk-js";
import type {
  SessionResource,
  SignedInSessionResource,
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
import { ROUTES } from "../route-paths.ts";
import { settle, withCleanup } from "../utils.ts";
import type { AuthV2Navigation, AuthV2RouteMode } from "./navigation.ts";

export const AUTH_V2_CHOOSE_ORGANIZATION_PATH = "/tasks/choose-organization";

export interface AuthV2ContinuationOrganization {
  readonly id: string;
  readonly imageUrl: string | null;
  readonly name: string;
}

export type AuthV2ContinuationFailureReason =
  | "activation-failed"
  | "missing-session"
  | "no-organizations"
  | "organization-activation-failed"
  | "session-unavailable";

export type AuthV2ContinuationUnknownReason =
  | "second-factor"
  | "unknown-task"
  | "unsupported-task";

export type AuthV2ContinuationState =
  | { readonly status: "loading" }
  | { readonly status: "inactive" }
  | { readonly status: "recovering" }
  | {
      readonly accountIdentifier: string;
      readonly organizations: readonly AuthV2ContinuationOrganization[];
      readonly selectingOrganizationId: string | null;
      readonly status: "incomplete";
      readonly task: "choose-organization";
    }
  | { readonly status: "complete" }
  | {
      readonly reason: AuthV2ContinuationFailureReason;
      readonly status: "failure";
    }
  | {
      readonly reason: AuthV2ContinuationUnknownReason;
      readonly status: "unknown";
    };

export interface AuthV2ContinuationSignals {
  readonly completeSession$: Command<Promise<void>, [string, AbortSignal]>;
  readonly failClosed$: Command<void, [AuthV2ContinuationUnknownReason]>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly recover$: Command<Promise<void>, [AbortSignal]>;
  readonly restart$: Command<Promise<void>, [AbortSignal]>;
  readonly selectOrganization$: Command<Promise<void>, [string, AbortSignal]>;
  readonly state$: Computed<AuthV2ContinuationState>;
}

export type AuthV2ContinuationFlowHandoff = Pick<
  AuthV2ContinuationSignals,
  "completeSession$" | "failClosed$" | "recover$"
>;

export interface AuthV2ContinuationDependencies {
  readonly isContinuationRoute: boolean;
  readonly mode: AuthV2RouteMode;
  readonly navigation: AuthV2Navigation;
  readonly presentation: "inline" | "route";
}

type ContinuationSessionSource = "organization" | "recovery" | "session";
type DecorateUrl = (url: string) => string;

interface ContinuationAtoms {
  readonly sessionId$: State<string | null>;
  readonly state$: State<AuthV2ContinuationState>;
}

interface ContinuationRuntime {
  readonly activatedOrganizationId$: State<string | null>;
  readonly handledSessionId$: State<string | null>;
  readonly inFlight$: State<Promise<void> | null>;
  readonly redirected$: State<boolean>;
  readonly taskNavigated$: State<boolean>;
}

type ApplySessionCommand = Command<
  void,
  [SessionResource, ContinuationSessionSource, DecorateUrl]
>;

function taskKey(
  session: SessionResource,
): { readonly kind: "none" } | { readonly key: string; readonly kind: "key" } {
  const task: unknown = session.currentTask;
  if (task === undefined || task === null) {
    return { kind: "none" };
  }
  if (typeof task !== "object" || !("key" in task)) {
    return { key: "", kind: "key" };
  }
  const key: unknown = task.key;
  return { key: typeof key === "string" ? key : "", kind: "key" };
}

function availableOrganizations(
  session: SessionResource,
): readonly AuthV2ContinuationOrganization[] {
  const organizations: AuthV2ContinuationOrganization[] = [];
  const seenOrganizationIds = new Set<string>();
  for (const membership of session.user?.organizationMemberships ?? []) {
    const { id, imageUrl, name } = membership.organization;
    if (!seenOrganizationIds.has(id)) {
      seenOrganizationIds.add(id);
      organizations.push({ id, imageUrl: imageUrl ?? null, name });
    }
  }
  return organizations;
}

function continuationAccountIdentifier(session: SessionResource): string {
  const user = session.user;
  return (
    user?.primaryEmailAddress?.emailAddress ??
    user?.fullName ??
    user?.username ??
    "Account"
  );
}

function createContinuationAtoms(): ContinuationAtoms {
  return {
    sessionId$: state<string | null>(null),
    state$: state<AuthV2ContinuationState>({ status: "loading" }),
  };
}

function createContinuationRuntime(): ContinuationRuntime {
  return {
    activatedOrganizationId$: state<string | null>(null),
    handledSessionId$: state<string | null>(null),
    inFlight$: state<Promise<void> | null>(null),
    redirected$: state(false),
    taskNavigated$: state(false),
  };
}

function createApplySessionCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  dependencies: AuthV2ContinuationDependencies,
): ApplySessionCommand {
  const redirect$ = command(({ get, set }, destination: string): void => {
    if (get(runtime.redirected$)) {
      return;
    }
    set(runtime.redirected$, true);
    window.location.href = destination;
  });
  const navigateToTask$ = command(({ get, set }, destination: string): void => {
    if (get(runtime.taskNavigated$)) {
      return;
    }
    set(runtime.taskNavigated$, true);
    window.location.href = destination;
  });

  return command(
    (
      { set },
      session: SessionResource,
      source: ContinuationSessionSource,
      decorateUrl: DecorateUrl,
    ): void => {
      set(atoms.sessionId$, session.id);
      const currentTask = taskKey(session);
      if (currentTask.kind === "key") {
        if (currentTask.key === "choose-organization") {
          if (source === "organization") {
            set(atoms.state$, {
              reason: "organization-activation-failed",
              status: "failure",
            });
            return;
          }
          const organizations = availableOrganizations(session);
          if (organizations.length === 0) {
            set(atoms.state$, {
              reason: "no-organizations",
              status: "failure",
            });
            return;
          }
          set(atoms.state$, {
            accountIdentifier: continuationAccountIdentifier(session),
            organizations,
            selectingOrganizationId: null,
            status: "incomplete",
            task: "choose-organization",
          });
          if (
            dependencies.presentation === "route" &&
            !dependencies.isContinuationRoute
          ) {
            set(
              navigateToTask$,
              decorateUrl(
                dependencies.navigation.href(
                  dependencies.mode,
                  AUTH_V2_CHOOSE_ORGANIZATION_PATH,
                ),
              ),
            );
          }
          return;
        }
        set(atoms.state$, {
          reason:
            currentTask.key === "setup-mfa"
              ? "second-factor"
              : currentTask.key === "reset-password"
                ? "unsupported-task"
                : "unknown-task",
          status: "unknown",
        });
        return;
      }

      if (session.status === "active") {
        set(atoms.state$, { status: "complete" });
        set(
          redirect$,
          decorateUrl(dependencies.navigation.completionRedirectUrl),
        );
        return;
      }
      if (session.status === "pending") {
        set(atoms.state$, { reason: "unknown-task", status: "unknown" });
        return;
      }
      set(atoms.state$, {
        reason: "session-unavailable",
        status: "failure",
      });
    },
  );
}

function findRecoverableSession(clerk: Clerk): SignedInSessionResource | null {
  const activeSession = clerk.session;
  if (
    activeSession?.status === "active" ||
    activeSession?.status === "pending"
  ) {
    return activeSession;
  }
  return null;
}

function createRecoveryCommand(
  atoms: ContinuationAtoms,
  applySession$: ApplySessionCommand,
  dependencies: AuthV2ContinuationDependencies,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(atoms.state$, { status: "recovering" });
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const session = findRecoverableSession(clerk);
    const hasPendingContinuation =
      session?.status === "pending" ||
      (session ? taskKey(session).kind === "key" : false);
    if (!dependencies.isContinuationRoute && !hasPendingContinuation) {
      set(atoms.state$, { status: "inactive" });
      return;
    }
    if (!session) {
      set(atoms.state$, { reason: "missing-session", status: "failure" });
      return;
    }
    set(applySession$, session, "recovery", clerk.buildUrlWithAuth.bind(clerk));
  });
}

function createCoalescedOperation(
  runtime: ContinuationRuntime,
  operation$: Command<Promise<void>, [string, AbortSignal]>,
): Command<Promise<void>, [string, AbortSignal]> {
  return command(
    async ({ get, set }, value: string, signal: AbortSignal): Promise<void> => {
      const current = get(runtime.inFlight$);
      if (current) {
        await current;
        signal.throwIfAborted();
        return;
      }
      const operation = set(operation$, value, signal);
      const trackedOperation = withCleanup(operation, () => {
        set(runtime.inFlight$, null);
      });
      set(runtime.inFlight$, trackedOperation);
      await trackedOperation;
      signal.throwIfAborted();
    },
  );
}

function createCompleteSessionCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  applySession$: ApplySessionCommand,
): Command<Promise<void>, [string, AbortSignal]> {
  const activateSession$ = command(
    async (
      { get, set },
      sessionId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(runtime.handledSessionId$) === sessionId) {
        return;
      }
      set(runtime.handledSessionId$, sessionId);
      set(atoms.sessionId$, sessionId);
      set(atoms.state$, { status: "recovering" });
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const activation = await settle(
        clerk.setActive({
          navigate: ({ decorateUrl, session }) => {
            set(applySession$, session, "session", decorateUrl);
          },
          session: sessionId,
        }),
        signal,
      );
      if (!activation.ok) {
        set(atoms.state$, {
          reason: "activation-failed",
          status: "failure",
        });
        return;
      }
    },
  );
  return createCoalescedOperation(runtime, activateSession$);
}

function createSelectOrganizationCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  applySession$: ApplySessionCommand,
): Command<Promise<void>, [string, AbortSignal]> {
  const activateOrganization$ = command(
    async (
      { get, set },
      organizationId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      if (get(runtime.activatedOrganizationId$) === organizationId) {
        return;
      }
      const continuationState = get(atoms.state$);
      if (
        continuationState.status !== "incomplete" ||
        !continuationState.organizations.some((organization) => {
          return organization.id === organizationId;
        })
      ) {
        return;
      }
      set(atoms.state$, {
        ...continuationState,
        selectingOrganizationId: organizationId,
      });
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const activation = await settle(
        clerk.setActive({
          navigate: ({ decorateUrl, session }) => {
            set(applySession$, session, "organization", decorateUrl);
          },
          organization: organizationId,
        }),
        signal,
      );
      if (!activation.ok) {
        set(atoms.state$, {
          reason: "organization-activation-failed",
          status: "failure",
        });
        return;
      }
      set(runtime.activatedOrganizationId$, organizationId);
    },
  );
  return createCoalescedOperation(runtime, activateOrganization$);
}

function createRestartCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  dependencies: AuthV2ContinuationDependencies,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = get(runtime.inFlight$);
    if (current) {
      await current;
      signal.throwIfAborted();
      return;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const sessionId = get(atoms.sessionId$);
    if (sessionId) {
      const signedOut = await settle(clerk.signOut({ sessionId }), signal);
      if (!signedOut.ok) {
        return;
      }
    }
    if (dependencies.presentation === "inline") {
      set(atoms.sessionId$, null);
      set(runtime.activatedOrganizationId$, null);
      set(runtime.handledSessionId$, null);
      set(runtime.redirected$, false);
      set(runtime.taskNavigated$, false);
      set(atoms.state$, { status: "inactive" });
      return;
    }
    window.location.href = dependencies.navigation.href(dependencies.mode);
  });
}

export function isAuthV2ContinuationLocation(
  pathname: string,
  hash: string,
): boolean {
  const pathPrefixes = [
    `${ROUTES.signInV2}/tasks/`,
    `${ROUTES.signUpV2}/tasks/`,
  ];
  const hashPath = hash.startsWith("#") ? hash.slice(1) : hash;
  return (
    pathPrefixes.some((prefix) => {
      return pathname.startsWith(prefix);
    }) || hashPath.startsWith("/tasks/")
  );
}

export function createAuthV2ContinuationSignals(
  dependencies: AuthV2ContinuationDependencies,
): AuthV2ContinuationSignals {
  const atoms = createContinuationAtoms();
  const runtime = createContinuationRuntime();
  const applySession$ = createApplySessionCommand(atoms, runtime, dependencies);
  const recover$ = createRecoveryCommand(atoms, applySession$, dependencies);
  return {
    completeSession$: createCompleteSessionCommand(
      atoms,
      runtime,
      applySession$,
    ),
    failClosed$: command(({ set }, reason) => {
      set(atoms.state$, { reason, status: "unknown" });
    }),
    initialize$: recover$,
    recover$,
    restart$: createRestartCommand(atoms, runtime, dependencies),
    selectOrganization$: createSelectOrganizationCommand(
      atoms,
      runtime,
      applySession$,
    ),
    state$: computed((get) => {
      return get(atoms.state$);
    }),
  };
}
