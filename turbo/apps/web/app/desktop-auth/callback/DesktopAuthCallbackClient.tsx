"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";

interface HandoffResponse {
  readonly callbackUrl?: string;
}

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_CALLBACK_SCHEME_PARAM = "callbackScheme";
const DESKTOP_AUTH_CALLBACK_SCHEMES = new Set([
  "ai.vm0.zero.desktop",
  "ai.vm0.zero.desktop.dev",
]);

function desktopAuthCallbackScheme(rawScheme: string | null): string | null {
  if (!rawScheme || !DESKTOP_AUTH_CALLBACK_SCHEMES.has(rawScheme)) {
    return null;
  }
  return rawScheme;
}

function desktopAuthStartPath(callbackScheme: string | null): string {
  if (!callbackScheme) {
    return DESKTOP_AUTH_START_PATH;
  }

  const searchParams = new URLSearchParams({
    [DESKTOP_AUTH_CALLBACK_SCHEME_PARAM]: callbackScheme,
  });
  return `${DESKTOP_AUTH_START_PATH}?${searchParams.toString()}`;
}

async function createDesktopAuthHandoff(
  getToken: () => Promise<string | null>,
  callbackScheme: string | null,
): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Missing browser session.");
  }

  const response = await fetch("/api/desktop-auth/handoff", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(callbackScheme ? { callbackScheme } : {}),
  });
  if (!response.ok) {
    throw new Error("Desktop sign-in failed.");
  }

  const body = (await response.json()) as HandoffResponse;
  if (!body.callbackUrl) {
    throw new Error("Desktop sign-in failed.");
  }

  return body.callbackUrl;
}

export function DesktopAuthCallbackClient() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const didRun = useRef(false);
  const callbackScheme = desktopAuthCallbackScheme(
    searchParams.get(DESKTOP_AUTH_CALLBACK_SCHEME_PARAM),
  );

  useEffect(() => {
    if (!isLoaded || didRun.current) {
      return;
    }
    didRun.current = true;

    if (!isSignedIn) {
      window.location.replace(desktopAuthStartPath(callbackScheme));
      return;
    }

    createDesktopAuthHandoff(getToken, callbackScheme)
      .then((callbackUrl) => {
        window.location.href = callbackUrl;
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Desktop sign-in failed.",
        );
      });
  }, [callbackScheme, getToken, isLoaded, isSignedIn]);

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
