"use client";

import { SignIn } from "@clerk/nextjs";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";

export function SignInClient() {
  const { theme } = useTheme();

  return (
    <AuthLayout>
      <SignIn appearance={getClerkAppearance(theme)} />
    </AuthLayout>
  );
}
