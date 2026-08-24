import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { AuthV2SignInSignals } from "../../signals/auth-v2/sign-in-flow.ts";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { AuthShell } from "../auth/auth-shell.tsx";
import { Link } from "../router/link.tsx";
import { AuthV2Shell } from "./auth-v2-shell.tsx";
import { AuthV2SignInCard } from "./sign-in/sign-in-card.tsx";

export type AuthV2PageMode = "sign-in" | "sign-up";

type AuthV2PageProps =
  | {
      readonly mode: "sign-in";
      readonly signInSignals: AuthV2SignInSignals;
    }
  | { readonly mode: "sign-up" };

export function AuthV2Page(props: AuthV2PageProps) {
  const { t } = useTranslation();
  const authBrand = resolveAuthBrandContext();
  const title = t(
    ($) => {
      return $.auth.v2.signUp.title;
    },
    { brandName: authBrand.brandName },
  );
  const description = t(($) => {
    return $.auth.v2.signUp.description;
  });
  const action = t(($) => {
    return $.auth.v2.signUp.action;
  });

  return (
    <AuthShell authBrand={authBrand} variant="v2">
      {props.mode === "sign-in" ? (
        <AuthV2SignInCard signals={props.signInSignals} />
      ) : (
        <AuthV2Shell
          description={description}
          focusKey={props.mode}
          title={title}
        >
          <Button
            asChild
            className="h-9 w-full bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
          >
            <Link
              pathname={ROUTES.signUp}
              options={{
                hash: location.hash,
                searchParams: new URLSearchParams(location.search),
              }}
            >
              {action}
            </Link>
          </Button>
        </AuthV2Shell>
      )}
    </AuthShell>
  );
}
