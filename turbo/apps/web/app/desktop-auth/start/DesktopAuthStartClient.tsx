"use client";

import { useEffect, useRef } from "react";
import { SignIn, useAuth } from "@clerk/nextjs";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";

const DESKTOP_AUTH_CALLBACK_PATH = "/desktop-auth/callback";

export function DesktopAuthStartClient() {
  const { isLoaded, isSignedIn } = useAuth();
  const { theme } = useTheme();
  const didRedirect = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || didRedirect.current) {
      return;
    }

    didRedirect.current = true;
    window.location.replace(DESKTOP_AUTH_CALLBACK_PATH);
  }, [isLoaded, isSignedIn]);

  if (!isLoaded || isSignedIn) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
    );
  }

  return (
    <AuthLayout>
      <SignIn
        appearance={getClerkAppearance(theme)}
        fallbackRedirectUrl={DESKTOP_AUTH_CALLBACK_PATH}
        forceRedirectUrl={DESKTOP_AUTH_CALLBACK_PATH}
        oauthFlow="redirect"
        path="/desktop-auth/start"
        routing="path"
        signUpFallbackRedirectUrl={DESKTOP_AUTH_CALLBACK_PATH}
        signUpForceRedirectUrl={DESKTOP_AUTH_CALLBACK_PATH}
      />
    </AuthLayout>
  );
}
