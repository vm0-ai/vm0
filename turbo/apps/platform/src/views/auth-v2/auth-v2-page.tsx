import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { resolveAuthBrandContext } from "../../signals/auth.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { AuthShell } from "../auth/auth-shell.tsx";
import { Link } from "../router/link.tsx";
import { AuthV2SignInCard } from "./sign-in/sign-in-card.tsx";

export type AuthV2PageMode = "sign-in" | "sign-up";

interface AuthV2PageProps {
  mode: AuthV2PageMode;
}

export function AuthV2Page({ mode }: AuthV2PageProps) {
  const { t } = useTranslation();
  const authBrand = resolveAuthBrandContext();
  const signIn = mode === "sign-in";
  const legacyRoute = signIn ? ROUTES.signIn : ROUTES.signUp;

  return (
    <AuthShell authBrand={authBrand}>
      {signIn ? (
        <AuthV2SignInCard />
      ) : (
        <Card className="w-full max-w-md rounded-3xl" data-testid="app-auth-v2">
          <CardHeader className="items-center text-center">
            <h1 className="text-lg font-medium text-foreground">
              {t(($) => {
                return $.auth.documentTitles.signUp;
              })}
            </h1>
            <CardDescription>
              {t(($) => {
                return $.auth.v2.unavailable;
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <Button className="w-full" asChild>
              <Link
                pathname={legacyRoute}
                options={{
                  hash: location.hash,
                  searchParams: new URLSearchParams(location.search),
                }}
              >
                {t(($) => {
                  return $.auth.v2.continueToSignUp;
                })}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </AuthShell>
  );
}
