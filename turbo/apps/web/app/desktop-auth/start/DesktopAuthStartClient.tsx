"use client";

import { useEffect, useRef } from "react";
import { SignIn, useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";
import { useTheme } from "../../components/ThemeProvider";
import { AuthLayout } from "../../components/auth/AuthLayout";
import { getClerkAppearance } from "../../components/auth/clerk-appearance";

const DESKTOP_AUTH_CALLBACK_PATH = "/desktop-auth/callback";
const DESKTOP_AUTH_CALLBACK_SCHEME_PARAM = "callbackScheme";
const DESKTOP_AUTH_CALLBACK_SCHEMES = new Set([
  "ai.vm0.zero.desktop",
  "ai.vm0.zero.desktop.dev",
]);

function desktopAuthCallbackPath(rawScheme: string | null): string {
  if (!rawScheme || !DESKTOP_AUTH_CALLBACK_SCHEMES.has(rawScheme)) {
    return DESKTOP_AUTH_CALLBACK_PATH;
  }

  const searchParams = new URLSearchParams({
    [DESKTOP_AUTH_CALLBACK_SCHEME_PARAM]: rawScheme,
  });
  return `${DESKTOP_AUTH_CALLBACK_PATH}?${searchParams.toString()}`;
}

export function DesktopAuthStartClient() {
  const { isLoaded, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const { theme } = useTheme();
  const didRedirect = useRef(false);
  const callbackPath = desktopAuthCallbackPath(
    searchParams.get(DESKTOP_AUTH_CALLBACK_SCHEME_PARAM),
  );

  useEffect(() => {
    if (!isLoaded || !isSignedIn || didRedirect.current) {
      return;
    }

    didRedirect.current = true;
    window.location.replace(callbackPath);
  }, [callbackPath, isLoaded, isSignedIn]);

  if (!isLoaded || isSignedIn) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
    );
  }

  return (
    <AuthLayout>
      <div className="relative z-10 flex w-full max-w-md flex-col gap-3">
        <SignIn
          appearance={getClerkAppearance(theme)}
          fallbackRedirectUrl={callbackPath}
          forceRedirectUrl={callbackPath}
          oauthFlow="redirect"
          path="/desktop-auth/start"
          routing="path"
          signUpFallbackRedirectUrl={callbackPath}
          signUpForceRedirectUrl={callbackPath}
        />
      </div>
    </AuthLayout>
  );
}
