import { Button } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";

import type { AuthV2Navigation } from "../../../signals/auth-v2/navigation.ts";
import type { AuthV2SignInSignals } from "../../../signals/auth-v2/sign-in-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { Link } from "../../router/link.tsx";
import { AUTH_V2_LINK_ACTION_CLASS } from "../auth-v2-action-styles.ts";
import { AuthV2IdentityPreview } from "../auth-v2-identity-preview.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import {
  SignInCardContent,
  SignInMethodsHelpFooter,
  SignInSwitch,
} from "./sign-in-content.tsx";
import {
  signInCardDescription,
  signInCardTitle,
  useAuthV2SignInCopy,
} from "./sign-in-copy.ts";

export function AuthV2SignInCard({
  authBrand,
  navigation,
  signals,
}: {
  readonly authBrand: AuthBrandContext;
  readonly navigation: AuthV2Navigation;
  readonly signals: AuthV2SignInSignals;
}) {
  const copy = useAuthV2SignInCopy();
  const flowState = useGet(signals.state$);
  const identifier = useGet(signals.identifier$);
  const backToIdentifier = useSet(signals.backToIdentifier$);
  const description = signInCardDescription(flowState, copy);
  const title = signInCardTitle(flowState, copy);
  const showsIdentifierPreview =
    flowState.status === "incomplete" &&
    (flowState.step === "password" ||
      flowState.step === "email-code" ||
      flowState.step === "password-reset-code") &&
    identifier.length > 0;
  const showsAccountSwitch =
    flowState.status === "incomplete" && flowState.step === "identifier";
  const showsMethodsHelp =
    flowState.status === "incomplete" &&
    (flowState.step === "choose-factor" ||
      flowState.step === "password-recovery");
  const signUpHref = navigation.href("sign-up");
  const focusKey =
    flowState.status === "incomplete"
      ? `sign-in:${flowState.status}:${flowState.step}`
      : `sign-in:${flowState.status}`;
  return (
    <AuthV2Shell
      announcement={description ?? title}
      authBrand={authBrand}
      cardFooter={
        showsMethodsHelp ? (
          <SignInMethodsHelpFooter copy={copy} signals={signals} />
        ) : showsAccountSwitch ? (
          <SignInSwitch copy={copy} signUpHref={signUpHref} />
        ) : null
      }
      description={description}
      focusKey={focusKey}
      footer={
        <div className="flex justify-center">
          <Button
            asChild
            className={AUTH_V2_LINK_ACTION_CLASS}
            size="sm"
            variant="link"
          >
            <Link
              pathname={ROUTES.signIn}
              options={{
                hash: location.hash,
                searchParams: new URLSearchParams(location.search),
              }}
            >
              {copy.legacySignIn}
            </Link>
          </Button>
        </div>
      }
      headerDetail={
        showsIdentifierPreview ? (
          <AuthV2IdentityPreview
            actionLabel={copy.editIdentifier}
            value={identifier}
            onEdit={backToIdentifier}
          />
        ) : null
      }
      title={title}
    >
      <SignInCardContent
        copy={copy}
        signUpHref={signUpHref}
        signals={signals}
        state={flowState}
      />
    </AuthV2Shell>
  );
}
