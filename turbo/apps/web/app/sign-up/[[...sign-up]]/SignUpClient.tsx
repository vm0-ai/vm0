"use client";

import { SignUp } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";
import { buildSignupRedirectUrl } from "../../../src/lib/adAttribution";
import {
  getAllowedRedirectOrigins,
  getAppUrl,
} from "../../../src/lib/zero/url";

export function SignUpClient() {
  const { theme } = useTheme();
  const searchParams = useSearchParams();
  const redirectUrl = buildSignupRedirectUrl(
    getAppUrl(),
    searchParams.toString(),
    getAllowedRedirectOrigins(),
  );

  return (
    <AuthLayout>
      <SignUp
        appearance={getClerkAppearance(theme)}
        fallbackRedirectUrl={redirectUrl}
        forceRedirectUrl={redirectUrl}
      />
    </AuthLayout>
  );
}
