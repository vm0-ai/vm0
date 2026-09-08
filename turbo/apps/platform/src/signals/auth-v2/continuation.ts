import type { BrowserClerk as Clerk } from "@clerk/shared/types";
import type {
  SessionResource,
  SignedInSessionResource,
  UserOrganizationInvitationResource,
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

import {
  createAuthV2SecurityTaskCommand,
  type AuthV2SecurityTaskAction,
  type AuthV2SecurityTaskState,
} from "./continuation-security.ts";

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

export type AuthV2ContinuationUnknownReason = "second-factor" | "unknown-task";

export type AuthV2ContinuationState =
  | { readonly status: "loading" }
  | AuthV2SecurityTaskState
  | { readonly status: "inactive" }
  | { readonly status: "recovering" }
  | {
      readonly accountIdentifier: string;
      readonly organizations: readonly AuthV2ContinuationOrganization[];
      readonly invitations: readonly AuthV2ContinuationOrganization[];
      readonly canCreateOrganization: boolean;
      readonly error: "request-failed" | null;
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
  readonly submitSecurityTask$: Command<
    Promise<void>,
    [AuthV2SecurityTaskAction, AbortSignal]
  >;
  readonly createOrganization$: Command<Promise<void>, [string, AbortSignal]>;
  readonly acceptInvitation$: Command<Promise<void>, [string, AbortSignal]>;
  readonly initialize$: Command<Promise<void>, [AbortSignal]>;
  readonly recover$: Command<Promise<void>, [AbortSignal]>;
  readonly restart$: Command<Promise<void>, [AbortSignal]>;
  readonly selectOrganization$: Command<Promise<void>, [string, AbortSignal]>;
  readonly state$: Computed<AuthV2ContinuationState>;
}

export type AuthV2ContinuationFlowHandoff = Pick<
  AuthV2ContinuationSignals,
  "completeSession$" | "recover$"
>;

interface AuthV2ContinuationDependencies {
  readonly isContinuationRoute: boolean;
  readonly isInvitationEntry?: boolean;
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
  readonly invitations$: State<readonly UserOrganizationInvitationResource[]>;
}

type ApplySessionCommand = Command<
  Promise<void>,
  [SessionResource, ContinuationSessionSource, DecorateUrl, AbortSignal]
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
    invitations$: state<readonly UserOrganizationInvitationResource[]>([]),
  };
}

function createApplyOrganizationTaskCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
) {
  return command(
    async (
      { set },
      session: SessionResource,
      source: ContinuationSessionSource,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (source === "organization") {
        set(atoms.state$, {
          reason: "organization-activation-failed",
          status: "failure",
        });
        return false;
      }
      const organizations = availableOrganizations(session);
      const user = session.user;
      const invitations =
        user && organizations.length === 0
          ? await settle(
              user.getOrganizationInvitations({
                status: "pending",
                pageSize: 100,
              }),
              signal,
            )
          : { ok: true as const, value: { data: [] } };
      const pendingInvitations = invitations.ok ? invitations.value.data : [];
      set(runtime.invitations$, pendingInvitations);
      const canCreateOrganization =
        organizations.length === 0 && user?.createOrganizationEnabled === true;
      if (
        organizations.length === 0 &&
        pendingInvitations.length === 0 &&
        !canCreateOrganization &&
        invitations.ok
      ) {
        set(atoms.state$, {
          reason: "no-organizations",
          status: "failure",
        });
        return false;
      }
      set(atoms.state$, {
        accountIdentifier: continuationAccountIdentifier(session),
        organizations,
        invitations: pendingInvitations.map((invitation) => {
          return {
            id: invitation.id,
            name: invitation.publicOrganizationData.name,
            imageUrl: invitation.publicOrganizationData.imageUrl,
          };
        }),
        canCreateOrganization,
        error: invitations.ok ? null : "request-failed",
        selectingOrganizationId: null,
        status: "incomplete",
        task: "choose-organization",
      });
      return true;
    },
  );
}

function createApplyTaskCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
) {
  const applyOrganization$ = createApplyOrganizationTaskCommand(atoms, runtime);
  return command(
    async (
      { get, set },
      session: SessionResource,
      key: string,
      source: ContinuationSessionSource,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (key === "choose-organization") {
        return await set(applyOrganization$, session, source, signal);
      } else if (key === "reset-password") {
        set(atoms.state$, {
          accountIdentifier: continuationAccountIdentifier(session),
          status: "incomplete",
          task: "reset-password",
          error: null,
          updated: false,
        });
      } else if (key === "setup-mfa") {
        const clerk = await get(clerk$);
        signal.throwIfAborted();
        const attributes =
          clerk.__internal_environment?.userSettings.attributes;
        const methods: ("totp" | "phone_code")[] = [];
        if (attributes?.authenticator_app?.enabled) {
          methods.push("totp");
        }
        if (attributes?.phone_number?.used_for_second_factor) {
          methods.push("phone_code");
        }
        if (methods.length === 0) {
          set(atoms.state$, { reason: "second-factor", status: "unknown" });
          return false;
        }
        set(atoms.state$, {
          accountIdentifier: continuationAccountIdentifier(session),
          status: "incomplete",
          task: "setup-mfa",
          methods,
          error: null,
          secret: null,
          phoneNumber: null,
          backupCodes: null,
        });
      } else {
        set(atoms.state$, { reason: "unknown-task", status: "unknown" });
        return false;
      }
      return true;
    },
  );
}

function createApplySessionCommand(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  dependencies: AuthV2ContinuationDependencies,
): ApplySessionCommand {
  const applyTask$ = createApplyTaskCommand(atoms, runtime);
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
    async (
      { set },
      session: SessionResource,
      source: ContinuationSessionSource,
      decorateUrl: DecorateUrl,
      signal: AbortSignal,
    ): Promise<void> => {
      set(atoms.sessionId$, session.id);
      const currentTask = taskKey(session);
      if (currentTask.kind === "key") {
        if (
          !(await set(applyTask$, session, currentTask.key, source, signal))
        ) {
          return;
        }
        if (
          dependencies.presentation === "route" &&
          !dependencies.isContinuationRoute
        ) {
          set(
            navigateToTask$,
            decorateUrl(
              dependencies.navigation.href(
                dependencies.mode,
                `/tasks/${currentTask.key}`,
              ),
            ),
          );
        }
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
    await set(
      applySession$,
      session,
      "recovery",
      clerk.buildUrlWithAuth.bind(clerk),
      signal,
    );
  });
}

function createCoalescedOperation<Value>(
  runtime: ContinuationRuntime,
  operation$: Command<Promise<void>, [Value, AbortSignal]>,
): Command<Promise<void>, [Value, AbortSignal]> {
  return command(
    async ({ get, set }, value: Value, signal: AbortSignal): Promise<void> => {
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
          navigate: async ({ decorateUrl, session }) => {
            await set(applySession$, session, "session", decorateUrl, signal);
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
        continuationState.task !== "choose-organization" ||
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
          navigate: async ({ decorateUrl, session }) => {
            await set(
              applySession$,
              session,
              "organization",
              decorateUrl,
              signal,
            );
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

function createResumeSessionCommand(
  atoms: ContinuationAtoms,
  applySession$: ApplySessionCommand,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const sessionId = get(atoms.sessionId$);
    if (!sessionId) {
      return;
    }
    await clerk.setActive({
      session: sessionId,
      navigate: async ({ session, decorateUrl }) => {
        await set(applySession$, session, "session", decorateUrl, signal);
      },
    });
    signal.throwIfAborted();
  });
}

function createOrganizationRecoveryCommands(
  atoms: ContinuationAtoms,
  runtime: ContinuationRuntime,
  applySession$: ApplySessionCommand,
) {
  // Once a write succeeds, offer the resulting membership. Further attempts
  // only activate it; the create/accept action is no longer available.
  const perform$ = command(
    async (
      { get, set },
      action: { kind: "create" | "accept"; value: string },
      signal: AbortSignal,
    ) => {
      const current = get(atoms.state$);
      if (
        current.status !== "incomplete" ||
        current.task !== "choose-organization"
      ) {
        return;
      }
      set(atoms.state$, { ...current, error: null });
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      if (clerk.session?.id !== get(atoms.sessionId$)) {
        throw new Error("Authentication session changed");
      }
      let organization: AuthV2ContinuationOrganization;
      if (action.kind === "create") {
        if (!current.canCreateOrganization || !action.value.trim()) {
          return;
        }
        const created = await clerk.createOrganization({
          name: action.value.trim(),
        });
        signal.throwIfAborted();
        organization = {
          id: created.id,
          name: action.value.trim(),
          imageUrl: null,
        };
      } else {
        const invitation = get(runtime.invitations$).find((item) => {
          return item.id === action.value;
        });
        if (!invitation) {
          return;
        }
        await invitation.accept();
        signal.throwIfAborted();
        organization = invitation.publicOrganizationData;
      }
      set(atoms.state$, {
        ...current,
        organizations: [organization],
        invitations: [],
        canCreateOrganization: false,
        error: null,
      });
      await clerk.setActive({
        organization: organization.id,
        navigate: async ({ session, decorateUrl }) => {
          await set(
            applySession$,
            session,
            "organization",
            decorateUrl,
            signal,
          );
        },
      });
      signal.throwIfAborted();
    },
  );
  const run$ = createCoalescedOperation(
    runtime,
    command(
      async (
        { get, set },
        action: { kind: "create" | "accept"; value: string },
        signal: AbortSignal,
      ) => {
        const result = await settle(set(perform$, action, signal), signal);
        if (!result.ok) {
          const current = get(atoms.state$);
          if (
            current.status === "incomplete" &&
            current.task === "choose-organization"
          ) {
            set(atoms.state$, { ...current, error: "request-failed" });
          }
        }
      },
    ),
  );
  return {
    createOrganization$: command(
      async ({ set }, name: string, signal: AbortSignal) => {
        await set(run$, { kind: "create", value: name }, signal);
      },
    ),
    acceptInvitation$: command(
      async ({ set }, id: string, signal: AbortSignal) => {
        await set(run$, { kind: "accept", value: id }, signal);
      },
    ),
  };
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
  const pathPrefixes = [`${ROUTES.signIn}/tasks/`, `${ROUTES.signUp}/tasks/`];
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
    ...createOrganizationRecoveryCommands(atoms, runtime, applySession$),
    submitSecurityTask$: createCoalescedOperation(
      runtime,
      createAuthV2SecurityTaskCommand({
        ...atoms,
        resume$: createResumeSessionCommand(atoms, applySession$),
      }),
    ),
    completeSession$: createCompleteSessionCommand(
      atoms,
      runtime,
      applySession$,
    ),
    initialize$: dependencies.isInvitationEntry
      ? command(({ set }) => {
          set(atoms.state$, { status: "inactive" });
          return Promise.resolve();
        })
      : recover$,
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
