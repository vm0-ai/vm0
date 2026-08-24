import { Button } from "@okouai/ui";
import { useGet } from "ccstate-react";

import { authV2SignInSignals$ } from "../../../signals/auth-v2/sign-in-flow.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { Link } from "../../router/link.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import { SignInCardContent } from "./sign-in-content.tsx";
import { signInCardDescription, useAuthV2SignInCopy } from "./sign-in-copy.ts";

export function AuthV2SignInCard() {
  const copy = useAuthV2SignInCopy();
  const signals = useGet(authV2SignInSignals$);
  const flowState = useGet(signals.state$);
  const description = signInCardDescription(flowState, copy);
  return (
    <AuthV2Shell
      announcement={description}
      description={description}
      focusKey="sign-in"
      title={copy.signInTitle}
    >
      <div className="space-y-4">
        <SignInCardContent copy={copy} signals={signals} state={flowState} />
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
      </div>
    </AuthV2Shell>
  );
}
