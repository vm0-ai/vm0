"use client";

import { SignIn } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";
import { buildSignInRedirectUrl } from "../../../src/lib/adAttribution";
import {
  getAllowedRedirectOrigins,
  getAppUrl,
  getPaidOnboardingUrl,
} from "../../../src/lib/zero/url";

export function SignInClient() {
  const { theme } = useTheme();
  const searchParams = useSearchParams();
  const redirectUrl = buildSignInRedirectUrl(
    getAppUrl(),
    searchParams.toString(),
    getAllowedRedirectOrigins(),
    getPaidOnboardingUrl(),
  );

  return (
    <AuthLayout>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-3">
        <SignIn
          appearance={getClerkAppearance(theme)}
          fallbackRedirectUrl={redirectUrl}
          forceRedirectUrl={redirectUrl}
        />
      </div>
    </AuthLayout>
  );
}
