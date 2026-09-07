import { useGet, useSet } from "ccstate-react";

import type { AuthV2Navigation } from "../../../signals/auth-v2/navigation.ts";
import type { AuthV2SignUpSignals } from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";
import { AuthV2IdentityPreview } from "../auth-v2-identity-preview.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import { SignUpCardContent, SignUpSwitch } from "./sign-up-content.tsx";
import {
  signUpCardDescription,
  signUpCardTitle,
  useAuthV2SignUpCopy,
} from "./sign-up-copy.ts";

export function AuthV2SignUpCard({
  authBrand,
  navigation,
  signals,
}: {
  readonly authBrand: AuthBrandContext;
  readonly navigation: AuthV2Navigation;
  readonly signals: AuthV2SignUpSignals;
}) {
  const copy = useAuthV2SignUpCopy(authBrand.brandName);
  const flowState = useGet(signals.state$);
  const backToDetails = useSet(signals.backToDetails$);
  const description = signUpCardDescription(flowState, copy);
  const title = signUpCardTitle(flowState, copy);
  const signInHref = navigation.href("sign-in");
  const focusKey =
    flowState.status === "incomplete"
      ? `sign-up:${flowState.status}:${flowState.step}`
      : `sign-up:${flowState.status}`;
  return (
    <AuthV2Shell
      announcement={description}
      authBrand={authBrand}
      cardFooter={
        flowState.status === "incomplete" && flowState.step === "details" ? (
          <SignUpSwitch copy={copy} signInHref={signInHref} />
        ) : null
      }
      description={description}
      focusKey={focusKey}
      headerDetail={
        flowState.status === "incomplete" && flowState.step === "email-code" ? (
          <AuthV2IdentityPreview
            actionLabel={copy.editEmailAddress}
            value={flowState.emailAddress}
            onEdit={backToDetails}
          />
        ) : null
      }
      title={title}
    >
      <SignUpCardContent
        copy={copy}
        signInHref={signInHref}
        signals={signals}
        state={flowState}
      />
    </AuthV2Shell>
  );
}
