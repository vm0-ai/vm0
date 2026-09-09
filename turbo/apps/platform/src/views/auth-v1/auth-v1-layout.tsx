import type { ReactNode } from "react";
import type { AuthBrandContext } from "../../signals/auth.ts";
import { AuthShell } from "../auth/auth-shell.tsx";

interface AuthV1LayoutProps {
  authBrand: AuthBrandContext;
  children: ReactNode;
}

export function AuthV1Layout({ authBrand, children }: AuthV1LayoutProps) {
  return <AuthShell authBrand={authBrand}>{children}</AuthShell>;
}
