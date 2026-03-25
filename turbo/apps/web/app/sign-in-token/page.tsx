"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSignIn } from "@clerk/nextjs";

export default function SignInTokenPage() {
  const searchParams = useSearchParams();
  const { signIn, setActive, isLoaded } = useSignIn();
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!isLoaded) return;

    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      setErrorMessage("Missing token parameter");
      return;
    }

    signIn
      .create({ strategy: "ticket", ticket: token })
      .then((result) => {
        if (result.status === "complete" && result.createdSessionId) {
          return setActive({ session: result.createdSessionId }).then(() => {
            setStatus("success");
            window.location.href = "/";
          });
        }
        setStatus("error");
        setErrorMessage(`Unexpected status: ${result.status}`);
      })
      .catch((err: unknown) => {
        setStatus("error");
        setErrorMessage(
          err instanceof Error ? err.message : "Sign-in failed",
        );
      });
  }, [isLoaded, searchParams, signIn, setActive]);

  return (
    <div style={{ padding: "2rem", fontFamily: "monospace" }}>
      {status === "loading" && <p>Signing in...</p>}
      {status === "success" && <p>Success. Redirecting...</p>}
      {status === "error" && <p>Error: {errorMessage}</p>}
    </div>
  );
}
