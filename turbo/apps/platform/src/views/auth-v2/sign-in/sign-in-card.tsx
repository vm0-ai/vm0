import { Button } from "@okouai/ui";
import { useGet } from "ccstate-react";

import type { AuthV2Navigation } from "../../../signals/auth-v2/navigation.ts";
import type { AuthV2SignInSignals } from "../../../signals/auth-v2/sign-in-flow.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { Link } from "../../router/link.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import { SignInCardContent, SignInSwitch } from "./sign-in-content.tsx";
import {
  signInCardDescription,
  signInCardTitle,
  useAuthV2SignInCopy,
} from "./sign-in-copy.ts";

export function AuthV2SignInCard({
  navigation,
  signals,
}: {
  readonly navigation: AuthV2Navigation;
  readonly signals: AuthV2SignInSignals;
}) {
  const copy = useAuthV2SignInCopy();
  const flowState = useGet(signals.state$);
  const description = signInCardDescription(flowState, copy);
  const title = signInCardTitle(flowState, copy);
  const signUpHref = navigation.href("sign-up");
  const focusKey =
    flowState.status === "incomplete"
      ? `sign-in:${flowState.status}:${flowState.step}`
      : `sign-in:${flowState.status}`;
  return (
    <AuthV2Shell
      announcement={description}
      description={description}
      focusKey={focusKey}
      footer={
        <>
          {flowState.status === "incomplete" ? (
            <SignInSwitch copy={copy} signUpHref={signUpHref} />
          ) : null}
          <div className="flex justify-center">
            <Button asChild size="sm" variant="link">
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
        </>
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
