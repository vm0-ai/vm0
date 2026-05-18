"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";

interface HandoffResponse {
  readonly callbackUrl?: string;
}

async function createDesktopAuthHandoff(
  getToken: () => Promise<string | null>,
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
    body: "{}",
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
  const [error, setError] = useState("");
  const didRun = useRef(false);

  useEffect(() => {
    if (!isLoaded || didRun.current) {
      return;
    }
    didRun.current = true;

    if (!isSignedIn) {
      window.location.href = `/sign-in?redirect_url=${encodeURIComponent(
        "/desktop-auth/callback",
      )}`;
      return;
    }

    createDesktopAuthHandoff(getToken)
      .then((callbackUrl) => {
        window.location.href = callbackUrl;
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Desktop sign-in failed.",
        );
      });
  }, [getToken, isLoaded, isSignedIn]);

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
