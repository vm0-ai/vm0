import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { Command } from "ccstate";

import { authV2InvitationError$ } from "../../signals/auth-v2/invitation.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { AuthV2ContinuationSignals } from "../../signals/auth-v2/continuation.ts";
import type { AuthV2SignInSignals } from "../../signals/auth-v2/sign-in-flow.ts";
import type { AuthV2PlatformContext } from "../../signals/auth-v2/platform-context.ts";
import type { AuthV2SignUpSignals } from "../../signals/auth-v2/sign-up-flow.ts";
import { AuthShell } from "../auth/auth-shell.tsx";
import { AuthV2ContinuationCard } from "./continuation/continuation-card.tsx";
import { AuthV2SignInCard } from "./sign-in/sign-in-card.tsx";
import { AuthV2SignUpCard } from "./sign-up/sign-up-card.tsx";
import { AuthV2Shell } from "./auth-v2-shell.tsx";
import { useAuthV2ContinuationCopy } from "./continuation/continuation-copy.ts";
import { AuthV2SubmitButton } from "./auth-v2-submit-button.tsx";

export type AuthV2PageMode = "sign-in" | "sign-up";

type AuthV2PageProps = {
  readonly continuationSignals: AuthV2ContinuationSignals;
  readonly retryInvitation$: Command<Promise<void>, [AbortSignal]>;
} & (
  | {
      readonly mode: "sign-in";
      readonly platformContext: AuthV2PlatformContext;
      readonly signInSignals: AuthV2SignInSignals;
    }
  | {
      readonly mode: "sign-up";
      readonly platformContext: AuthV2PlatformContext;
      readonly signUpSignals: AuthV2SignUpSignals;
    }
);

export function AuthV2Page(props: AuthV2PageProps) {
  const continuationState = useGet(props.continuationSignals.state$);
  const invitationError = useGet(authV2InvitationError$);
  const [retryLoadable, retry] = useLoadableSet(props.retryInvitation$);
  const signal = useGet(pageSignal$);
  const copy = useAuthV2ContinuationCopy(
    props.platformContext.authBrand.brandName,
  );
  return (
    <AuthShell authBrand={props.platformContext.authBrand}>
      {invitationError ? (
        <AuthV2Shell
          authBrand={props.platformContext.authBrand}
          title={copy.activationErrorTitle}
          description={copy.invitationError}
          focusKey="invitation-error"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              detach(
                retry(signal),
                Reason.DomCallback,
                "retry authentication invitation",
              );
            }}
          >
            <AuthV2SubmitButton
              busy={retryLoadable.state === "loading"}
              label={copy.retry}
            />
          </form>
        </AuthV2Shell>
      ) : continuationState.status !== "inactive" ? (
        <AuthV2ContinuationCard
          authBrand={props.platformContext.authBrand}
          signals={props.continuationSignals}
          state={continuationState}
        />
      ) : props.mode === "sign-in" ? (
        <AuthV2SignInCard
          authBrand={props.platformContext.authBrand}
          navigation={props.platformContext.navigation}
          signals={props.signInSignals}
        />
      ) : (
        <AuthV2SignUpCard
          authBrand={props.platformContext.authBrand}
          navigation={props.platformContext.navigation}
          signals={props.signUpSignals}
        />
      )}
    </AuthShell>
  );
}
