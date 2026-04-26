"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn } from "@clerk/nextjs/legacy";

function SignInTokenContent() {
  const searchParams = useSearchParams();
  const { signIn, setActive, isLoaded } = useSignIn();
  const [error, setError] = useState("");
  const didRun = useRef(false);

  const token = searchParams.get("token");

  useEffect(() => {
    if (!isLoaded || !token || didRun.current) return;
    didRun.current = true;

    signIn
      .create({ strategy: "ticket", ticket: token })
      .then((result) => {
        if (result.status === "complete" && result.createdSessionId) {
          return setActive({ session: result.createdSessionId }).then(() => {
            window.location.href = "/";
          });
        }
        throw new Error(`Unexpected status: ${result.status}`);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      });
  }, [isLoaded, token, signIn, setActive]);

  if (!token) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>
        Error: Missing token parameter
      </p>
    );
  }

  if (error) {
    return (
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}

export function SignInTokenClient() {
  return (
    <Suspense
      fallback={
        <p style={{ padding: "2rem", fontFamily: "monospace" }}>Loading...</p>
      }
    >
      <SignInTokenContent />
    </Suspense>
  );
}
