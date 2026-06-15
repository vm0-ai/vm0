"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";

import { DesktopAuthStatusPage } from "../DesktopAuthStatusPage";

interface HandoffResponse {
  readonly callbackUrl?: string;
  readonly handoffId?: string;
}

interface DesktopAuthHandoff {
  readonly callbackUrl: string;
  readonly handoffId: string;
}

type DesktopAuthHandoffStatus = "pending" | "consumed" | "completed";

interface HandoffStatusResponse {
  readonly status?: DesktopAuthHandoffStatus;
}

const DESKTOP_AUTH_START_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_CALLBACK_SCHEME_PARAM = "callbackScheme";
const DESKTOP_AUTH_CALLBACK_SCHEMES = new Set([
  "ai.vm0.zero.desktop",
  "ai.vm0.zero.desktop.dev",
]);
const DESKTOP_AUTH_STATUS_POLL_MS = 1000;

type ViewState = "signing_in" | "waiting" | "completed";

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
): Promise<DesktopAuthHandoff> {
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
  if (!body.callbackUrl || !body.handoffId) {
    throw new Error("Desktop sign-in failed.");
  }

  return {
    callbackUrl: body.callbackUrl,
    handoffId: body.handoffId,
  };
}

async function getDesktopAuthHandoffStatus(
  getToken: () => Promise<string | null>,
  handoffId: string,
): Promise<DesktopAuthHandoffStatus> {
  const token = await getToken();
  if (!token) {
    throw new Error("Missing browser session.");
  }

  const response = await fetch(`/api/desktop-auth/handoff/${handoffId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error("Desktop sign-in failed.");
  }

  const body = (await response.json()) as HandoffStatusResponse;
  if (!body.status) {
    throw new Error("Desktop sign-in failed.");
  }

  return body.status;
}

function WaitingStatus(): React.JSX.Element {
  return (
    <DesktopAuthStatusPage
      title="Waiting for Zero Computer Use"
      description="This page will update when desktop sign-in completes."
      tone="waiting"
    />
  );
}

function CompletedStatus(): React.JSX.Element {
  return (
    <DesktopAuthStatusPage
      title="Zero Computer Use is signed in."
      description="You can close this browser window and return to the app."
      tone="success"
    />
  );
}

export function DesktopAuthCallbackClient() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [viewState, setViewState] = useState<ViewState>("signing_in");
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

    let cancelled = false;
    let pollTimeout: number | undefined;

    const pollHandoffStatus = (handoffId: string): void => {
      getDesktopAuthHandoffStatus(getToken, handoffId)
        .then((status) => {
          if (cancelled) {
            return;
          }
          if (status === "completed") {
            setViewState("completed");
            return;
          }
          pollTimeout = window.setTimeout(() => {
            pollHandoffStatus(handoffId);
          }, DESKTOP_AUTH_STATUS_POLL_MS);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(
              err instanceof Error ? err.message : "Desktop sign-in failed.",
            );
          }
        });
    };

    createDesktopAuthHandoff(getToken, callbackScheme)
      .then((handoff) => {
        if (cancelled) {
          return;
        }
        setViewState("waiting");
        window.location.href = handoff.callbackUrl;
        pollHandoffStatus(handoff.handoffId);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Desktop sign-in failed.",
          );
        }
      });

    return () => {
      cancelled = true;
      if (pollTimeout !== undefined) {
        window.clearTimeout(pollTimeout);
      }
    };
  }, [callbackScheme, getToken, isLoaded, isSignedIn]);

  if (error) {
    return (
      <DesktopAuthStatusPage
        title="Desktop sign-in failed"
        description={error}
        tone="error"
      />
    );
  }

  if (viewState === "completed") {
    return <CompletedStatus />;
  }

  if (viewState === "waiting") {
    return <WaitingStatus />;
  }

  return (
    <DesktopAuthStatusPage
      title="Signing in to Zero"
      description="Connecting this browser session to Zero Computer Use."
    />
  );
}
