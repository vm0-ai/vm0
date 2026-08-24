import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { AuthShell } from "../auth/auth-shell.tsx";
import { Link } from "../router/link.tsx";
import { AuthV2Shell } from "./auth-v2-shell.tsx";

export type AuthV2PageMode = "sign-in" | "sign-up";

interface AuthV2PageProps {
  mode: AuthV2PageMode;
}

export function AuthV2Page({ mode }: AuthV2PageProps) {
  const { t } = useTranslation();
  const authBrand = resolveAuthBrandContext();
  const signIn = mode === "sign-in";
  const legacyRoute = signIn ? ROUTES.signIn : ROUTES.signUp;
  const title = signIn
    ? t(
        ($) => {
          return $.auth.v2.signIn.title;
        },
        { brandName: authBrand.brandName },
      )
    : t(
        ($) => {
          return $.auth.v2.signUp.title;
        },
        { brandName: authBrand.brandName },
      );
  const description = t(($) => {
    return signIn ? $.auth.v2.signIn.description : $.auth.v2.signUp.description;
  });
  const action = t(($) => {
    return signIn ? $.auth.v2.signIn.action : $.auth.v2.signUp.action;
  });

  return (
    <AuthShell authBrand={authBrand} variant="v2">
      <AuthV2Shell description={description} focusKey={mode} title={title}>
        <Button
          asChild
          className="h-9 w-full bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
        >
          <Link
            pathname={legacyRoute}
            options={{
              hash: location.hash,
              searchParams: new URLSearchParams(location.search),
            }}
          >
            {action}
          </Link>
        </Button>
      </AuthV2Shell>
    </AuthShell>
  );
}
