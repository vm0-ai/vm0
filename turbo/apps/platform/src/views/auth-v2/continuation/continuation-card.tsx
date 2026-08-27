import { Button, cn } from "@okouai/ui";
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
import { AUTH_V2_PRIMARY_ACTION_CLASS } from "../auth-v2-action-styles.ts";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import {
  type AuthV2ContinuationCopy,
  useAuthV2ContinuationCopy,
} from "./continuation-copy.ts";

function continuationHeading(
  state: AuthV2ContinuationState,
  copy: AuthV2ContinuationCopy,
): { readonly description: string; readonly title: string } {
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

function OrganizationContent({
  copy,
  signals,
  state,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly signals: AuthV2ContinuationSignals;
  readonly state: Extract<AuthV2ContinuationState, { status: "incomplete" }>;
}) {
  const pageSignal = useGet(pageSignal$);
  const [selectionLoadable, selectOrganization] = useLoadableSet(
    signals.selectOrganization$,
  );
  const selectionPending = selectionLoadable.state === "loading";
  return (
    <div className="space-y-2">
      {state.organizations.map((organization) => {
        const selected =
          state.selectingOrganizationId === organization.id && selectionPending;
        const actionLabel = copy.selectOrganization(organization.name);
        return (
          <Button
            aria-busy={selected}
            aria-label={actionLabel}
            className={
              selected ? "w-full justify-center" : "w-full justify-start"
            }
            disabled={selectionPending}
            key={organization.id}
            onClick={() => {
              detach(
                selectOrganization(organization.id, pageSignal),
                Reason.DomCallback,
                "select auth v2 organization",
              );
            }}
            type="button"
            variant="outline"
          >
            {selected ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              actionLabel
            )}
          </Button>
        );
      })}
    </div>
  );
}

function RecoveryContent({
  copy,
  signals,
}: {
  readonly copy: AuthV2ContinuationCopy;
  readonly signals: AuthV2ContinuationSignals;
}) {
  const pageSignal = useGet(pageSignal$);
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
          restart(pageSignal),
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
  signals,
  state,
}: {
  readonly authBrand: AuthBrandContext;
  readonly signals: AuthV2ContinuationSignals;
  readonly state: AuthV2ContinuationState;
}) {
  const copy = useAuthV2ContinuationCopy(authBrand.brandName);
  if (state.status === "inactive") {
    return null;
  }
  const heading = continuationHeading(state, copy);
  const focusKey =
    "reason" in state
      ? `continuation:${state.status}:${state.reason}`
      : `continuation:${state.status}`;
  const content =
    state.status === "incomplete" ? (
      <OrganizationContent copy={copy} signals={signals} state={state} />
    ) : state.status === "failure" || state.status === "unknown" ? (
      <RecoveryContent copy={copy} signals={signals} />
    ) : (
      <LoadingContent label={heading.description} />
    );
  return (
    <AuthV2Shell
      announcement={heading.description}
      authBrand={authBrand}
      description={heading.description}
      focusKey={focusKey}
      title={heading.title}
    >
      {content}
    </AuthV2Shell>
  );
}
