"use client";

import { SignIn } from "@clerk/nextjs";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";

export function SignInClient() {
  const { theme } = useTheme();

  return (
    <AuthLayout>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-3">
        <SignIn appearance={getClerkAppearance(theme)} />
      </div>
    </AuthLayout>
  );
}
