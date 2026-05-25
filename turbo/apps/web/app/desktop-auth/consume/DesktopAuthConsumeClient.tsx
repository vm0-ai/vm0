"use client";

import { useEffect, useRef, useState } from "react";
import { useSignIn } from "@clerk/nextjs/legacy";

interface DesktopAuthConsumeClientProps {
  readonly code?: string;
  readonly errorMessage?: string;
}

interface ConsumeResponse {
  readonly token?: string;
  readonly error?: {
    readonly message?: string;
  };
}

const DESKTOP_AUTH_TOKEN_PATH = "/desktop-auth/token";

async function exchangeDesktopAuthCode(code: string): Promise<string> {
  const response = await fetch("/api/desktop-auth/consume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const body = (await response.json()) as ConsumeResponse;

  if (!response.ok) {
    throw new Error(body.error?.message ?? "Desktop sign-in failed.");
  }
  if (!body.token) {
    throw new Error("Desktop sign-in failed.");
  }

  return body.token;
}

export function DesktopAuthConsumeClient({
  code,
  errorMessage,
}: DesktopAuthConsumeClientProps) {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [error, setError] = useState(errorMessage ?? "");
  const didRun = useRef(false);

  useEffect(() => {
    if (!isLoaded || !code || didRun.current || errorMessage) {
      return;
    }
    didRun.current = true;

    exchangeDesktopAuthCode(code)
      .then((token) => {
        return signIn.create({ strategy: "ticket", ticket: token });
      })
      .then((result) => {
        if (result.status === "complete" && result.createdSessionId) {
          return setActive({ session: result.createdSessionId }).then(() => {
            window.location.href = DESKTOP_AUTH_TOKEN_PATH;
          });
        }
        throw new Error(`Unexpected status: ${result.status}`);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      });
  }, [code, errorMessage, isLoaded, signIn, setActive]);

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
