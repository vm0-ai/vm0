"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import { IconCheck } from "@tabler/icons-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";

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

function StatusCard({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          <div className="mb-8 flex items-center gap-2">
            <Image
              src="/assets/vm0-logo-dark.svg"
              alt="VM0"
              width={82}
              height={20}
              priority
              className="dark:hidden"
            />
            <Image
              src="/assets/vm0-logo.svg"
              alt="VM0"
              width={82}
              height={20}
              priority
              className="hidden dark:block"
            />
            <span className="text-2xl text-foreground">Platform</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function WaitingStatus(): React.JSX.Element {
  return (
    <StatusCard>
      <div className="mt-4 flex flex-col items-center gap-2 text-center">
        <h1 className="text-lg font-medium leading-7 text-foreground">
          Waiting for Zero Computer Use
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          This page will update when desktop sign-in completes.
        </p>
      </div>
    </StatusCard>
  );
}

function CompletedStatus(): React.JSX.Element {
  return (
    <StatusCard>
      <div className="mt-4 flex flex-col items-center gap-4">
        <IconCheck size={40} className="text-lime-600" stroke={1} />
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-lg font-medium leading-7 text-foreground">
            Zero Computer Use is signed in.
          </h1>
          <p className="text-sm leading-5 text-muted-foreground">
            You can close this browser window and return to the app.
          </p>
        </div>
      </div>
    </StatusCard>
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
      <p style={{ padding: "2rem", fontFamily: "monospace" }}>Error: {error}</p>
    );
  }

  if (viewState === "completed") {
    return <CompletedStatus />;
  }

  if (viewState === "waiting") {
    return <WaitingStatus />;
  }

  return (
    <p style={{ padding: "2rem", fontFamily: "monospace" }}>Signing in...</p>
  );
}
