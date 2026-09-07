import { Button, cn, Input } from "@okouai/ui";
import type { Computed } from "ccstate";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";

import type {
  AuthV2ContinuationSignals,
  AuthV2ContinuationState,
} from "../../../signals/auth-v2/continuation.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { WorkspaceLogo } from "../../components/avatar.tsx";
import {
  AUTH_V2_LINK_ACTION_CLASS,
  AUTH_V2_PRIMARY_ACTION_CLASS,
} from "../auth-v2-action-styles.ts";
import { AuthV2ChoiceRow } from "../auth-v2-choice-row.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import {
  type AuthV2ContinuationCopy,
  useAuthV2ContinuationCopy,
} from "./continuation-copy.ts";

import { AuthV2SecurityTaskContent } from "./security-task-content.tsx";
import { AuthV2ErrorAlert } from "../auth-v2-error-alert.tsx";
import { AuthV2SubmitButton } from "../auth-v2-submit-button.tsx";
import {
  useAuthV2SignInCopy,
  type AuthV2SignInCopy,
} from "../sign-in/sign-in-copy.ts";

function continuationHeading(
  state: AuthV2ContinuationState,
  copy: AuthV2ContinuationCopy,
  signInCopy: AuthV2SignInCopy,
): { readonly description: string; readonly title: string } {
  if (state.status === "incomplete" && state.task === "reset-password") {
    return {
      title: signInCopy.newPasswordTitle,
      description: signInCopy.newPasswordSubtitle,
    };
  }
  if (state.status === "incomplete" && state.task === "setup-mfa") {
    return {
      title: state.backupCodes?.length ? copy.backupTitle : copy.securityTitle,
      description: copy.securityDescription,
    };
  }
  if (state.status === "incomplete") {
    return {
      description: copy.chooseOrganizationDescription,
      title: copy.chooseOrganizationTitle,
    };
  }
  if (state.status === "complete") {
    return {
      description: copy.completeDescription,
      title: copy.completeTitle,
    };
  }
  if (state.status === "failure" && state.reason === "no-organizations") {
    return {
      description: copy.noOrganizationsDescription,
      title: copy.noOrganizationsTitle,
    };
  }
  if (state.status === "failure") {
    return {
      description: copy.activationErrorDescription,
      title: copy.activationErrorTitle,
    };
  }
  if (state.status === "unknown" && state.reason === "second-factor") {
    return {
      description: copy.secondFactorDescription,
      title: copy.secondFactorTitle,
    };
  }
  if (state.status === "unknown") {
    return {
      description: copy.unsupportedDescription,
      title: copy.unsupportedTitle,
    };
  }
  return {
    description: copy.loadingDescription,
    title: copy.loadingTitle,
  };
}

function LoadingContent({ label }: { readonly label: string }) {
  return (
    <div className="flex justify-center py-2" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function OrganizationCreationForm({
  copy,
  pending,
  creating,
  createOrganization,
  operationSignal$,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly pending: boolean;
  readonly creating: boolean;
  readonly createOrganization: (
    name: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly operationSignal$: Computed<AbortSignal>;
}) {
  const operationSignal = useGet(operationSignal$);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const name = new FormData(event.currentTarget).get("organizationName");
        if (typeof name === "string") {
          detach(
            createOrganization(name, operationSignal),
            Reason.DomCallback,
            "create authentication organization",
          );
        }
      }}
    >
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="task-organization-name">
          {copy.organizationName}
        </label>
        <Input
          id="task-organization-name"
          name="organizationName"
          required
          disabled={pending}
        />
      </div>
      <AuthV2SubmitButton
        busy={creating}
        disabled={pending}
        label={copy.createOrganization}
      />
    </form>
  );
}

function OrganizationContent({
  copy,
  operationSignal$,
  signals,
  state,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly operationSignal$: Computed<AbortSignal>;
  readonly signals: AuthV2ContinuationSignals;
  readonly state: Extract<
    AuthV2ContinuationState,
    { task: "choose-organization" }
  >;
}) {
  const operationSignal = useGet(operationSignal$);
  const [selectionLoadable, selectOrganization] = useLoadableSet(
    signals.selectOrganization$,
  );
  const [createLoadable, createOrganization] = useLoadableSet(
    signals.createOrganization$,
  );
  const [inviteLoadable, acceptInvitation] = useLoadableSet(
    signals.acceptInvitation$,
  );
  const [recoveryLoadable, recover] = useLoadableSet(signals.recover$);
  const selectionPending =
    selectionLoadable.state === "loading" ||
    createLoadable.state === "loading" ||
    inviteLoadable.state === "loading" ||
    recoveryLoadable.state === "loading";
  return (
    <div className="space-y-4">
      {state.error ? (
        <>
          <AuthV2ErrorAlert message={copy.taskError} focusKey={state.error} />
          {state.invitations.length === 0 && !state.canCreateOrganization ? (
            <Button
              className="w-full"
              disabled={selectionPending}
              onClick={() => {
                detach(
                  recover(operationSignal),
                  Reason.DomCallback,
                  "reload organization choices",
                );
              }}
            >
              {copy.retry}
            </Button>
          ) : null}
        </>
      ) : null}
      <div className="divide-y divide-border">
        {state.organizations.map((organization) => {
          const selected =
            state.selectingOrganizationId === organization.id &&
            selectionPending;
          const actionLabel = copy.selectOrganization(organization.name);
          return (
            <AuthV2ChoiceRow
              actionLabel={actionLabel}
              busy={selected}
              disabled={selectionPending}
              key={organization.id}
              leading={
                <WorkspaceLogo
                  imageUrl={organization.imageUrl}
                  name={organization.name}
                  size="md"
                />
              }
              onSelect={() => {
                detach(
                  selectOrganization(organization.id, operationSignal),
                  Reason.DomCallback,
                  "select auth v2 organization",
                );
              }}
              primary={organization.name}
            />
          );
        })}
        {state.invitations.map((invitation) => {
          return (
            <AuthV2ChoiceRow
              key={invitation.id}
              actionLabel={copy.joinOrganization(invitation.name)}
              busy={inviteLoadable.state === "loading"}
              disabled={selectionPending}
              leading={
                <WorkspaceLogo
                  imageUrl={invitation.imageUrl}
                  name={invitation.name}
                  size="md"
                />
              }
              primary={copy.joinOrganization(invitation.name)}
              onSelect={() => {
                detach(
                  acceptInvitation(invitation.id, operationSignal),
                  Reason.DomCallback,
                  "accept authentication organization invitation",
                );
              }}
            />
          );
        })}
      </div>
      {state.canCreateOrganization ? (
        <OrganizationCreationForm
          copy={copy}
          pending={selectionPending}
          creating={createLoadable.state === "loading"}
          createOrganization={createOrganization}
          operationSignal$={operationSignal$}
        />
      ) : null}
    </div>
  );
}

function OrganizationFooter({
  accountIdentifier,
  copy,
  operationSignal$,
  signals,
}: {
  readonly accountIdentifier: string;
  readonly copy: AuthV2ContinuationCopy;
  readonly operationSignal$: Computed<AbortSignal>;
  readonly signals: AuthV2ContinuationSignals;
}) {
  const operationSignal = useGet(operationSignal$);
  const [restartLoadable, restart] = useLoadableSet(signals.restart$);
  const signingOut = restartLoadable.state === "loading";
  return (
    <div className="flex w-full items-center justify-between gap-4 text-sm">
      <span className="min-w-0 truncate">
        {copy.signedInAs(accountIdentifier)}
      </span>
      <Button
        aria-busy={signingOut}
        aria-label={copy.signOut}
        className={cn(
          "h-auto w-fit shrink-0 p-0 text-sm leading-5",
          AUTH_V2_LINK_ACTION_CLASS,
        )}
        disabled={signingOut}
        onClick={() => {
          detach(
            restart(operationSignal),
            Reason.DomCallback,
            "sign out of auth v2 organization continuation",
          );
        }}
        type="button"
        variant="link"
      >
        {signingOut ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          copy.signOut
        )}
      </Button>
    </div>
  );
}

function RecoveryContent({
  copy,
  operationSignal$,
  signals,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly operationSignal$: Computed<AbortSignal>;
  readonly signals: AuthV2ContinuationSignals;
}) {
  const operationSignal = useGet(operationSignal$);
  const [restartLoadable, restart] = useLoadableSet(signals.restart$);
  const restarting = restartLoadable.state === "loading";
  return (
    <Button
      aria-busy={restarting}
      aria-label={copy.recoveryAction}
      className={cn("w-full", AUTH_V2_PRIMARY_ACTION_CLASS)}
      disabled={restarting}
      onClick={() => {
        detach(
          restart(operationSignal),
          Reason.DomCallback,
          "restart auth v2 after continuation failure",
        );
      }}
      type="button"
    >
      {restarting ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        copy.recoveryAction
      )}
    </Button>
  );
}

export function AuthV2ContinuationCard({
  authBrand,
  operationSignal$ = pageSignal$,
  signals,
  state,
  surface = "page",
}: {
  readonly authBrand: AuthBrandContext;
  readonly operationSignal$?: Computed<AbortSignal>;
  readonly signals: AuthV2ContinuationSignals;
  readonly state: AuthV2ContinuationState;
  readonly surface?: "dialog" | "page";
}) {
  const copy = useAuthV2ContinuationCopy(authBrand.brandName);
  const signInCopy = useAuthV2SignInCopy(authBrand);
  if (state.status === "inactive") {
    return null;
  }
  const heading = continuationHeading(state, copy, signInCopy);
  const focusKey =
    "reason" in state
      ? `continuation:${state.status}:${state.reason}`
      : state.status === "incomplete"
        ? `continuation:${state.task}:${state.task === "setup-mfa" && state.backupCodes !== null ? "saved" : "input"}`
        : `continuation:${state.status}`;
  const content =
    state.status === "incomplete" && state.task !== "choose-organization" ? (
      <AuthV2SecurityTaskContent
        copy={copy}
        operationSignal$={operationSignal$}
        signals={signals}
        state={state}
      />
    ) : state.status === "incomplete" ? (
      <OrganizationContent
        copy={copy}
        operationSignal$={operationSignal$}
        signals={signals}
        state={state}
      />
    ) : state.status === "failure" || state.status === "unknown" ? (
      <RecoveryContent
        copy={copy}
        operationSignal$={operationSignal$}
        signals={signals}
      />
    ) : (
      <LoadingContent label={heading.description} />
    );
  return (
    <AuthV2Shell
      announcement={heading.description}
      authBrand={authBrand}
      cardFooter={
        state.status === "incomplete" ? (
          <OrganizationFooter
            accountIdentifier={state.accountIdentifier}
            copy={copy}
            operationSignal$={operationSignal$}
            signals={signals}
          />
        ) : null
      }
      description={heading.description}
      focusKey={focusKey}
      layout={
        state.status === "incomplete" &&
        state.task === "choose-organization" &&
        state.organizations.length > 0
          ? "choice"
          : "default"
      }
      surface={surface}
      title={heading.title}
    >
      {content}
    </AuthV2Shell>
  );
}
