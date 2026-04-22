"use client";

import { SignUp } from "@clerk/nextjs";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";

export function SignUpClient() {
  const { theme } = useTheme();

  return (
    <AuthLayout>
      <SignUp appearance={getClerkAppearance(theme)} />
    </AuthLayout>
  );
}
