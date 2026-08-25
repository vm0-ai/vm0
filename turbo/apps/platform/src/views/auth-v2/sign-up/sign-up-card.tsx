import { Button } from "@okouai/ui";
import { useGet } from "ccstate-react";

import type { AuthV2Navigation } from "../../../signals/auth-v2/navigation.ts";
import type { AuthV2SignUpSignals } from "../../../signals/auth-v2/sign-up-flow.ts";
import type { AuthBrandContext } from "../../../signals/auth.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { Link } from "../../router/link.tsx";
import { AuthV2Shell } from "../auth-v2-shell.tsx";
import { SignUpCardContent, SignUpSwitch } from "./sign-up-content.tsx";
import { signUpCardDescription, useAuthV2SignUpCopy } from "./sign-up-copy.ts";

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
  const description = signUpCardDescription(flowState, copy);
  const signInHref = navigation.href("sign-in");
  return (
    <AuthV2Shell
      announcement={description}
      description={description}
      focusKey="sign-up"
      title={copy.signUpTitle}
    >
      <div className="space-y-4">
        <SignUpCardContent
          copy={copy}
          signInHref={signInHref}
          signals={signals}
          state={flowState}
        />
        {flowState.status === "incomplete" ? (
          <SignUpSwitch copy={copy} signInHref={signInHref} />
        ) : null}
        <div className="flex justify-center">
          <Button asChild size="sm" variant="link">
            <Link
              options={{
                hash: location.hash,
                searchParams: new URLSearchParams(location.search),
              }}
              pathname={ROUTES.signUp}
            >
              {copy.legacySignUp}
            </Link>
          </Button>
        </div>
      </div>
    </AuthV2Shell>
  );
}
