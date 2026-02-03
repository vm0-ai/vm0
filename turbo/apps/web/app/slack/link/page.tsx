"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { useTheme } from "../../components/ThemeProvider";
import { linkSlackAccount, checkLinkStatus } from "./actions";

function SlackLinkContent(): React.JSX.Element {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [alreadyLinked, setAlreadyLinked] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { theme, toggleTheme } = useTheme();

  const slackUserId = searchParams.get("u");
  const workspaceId = searchParams.get("w");
  const channelId = searchParams.get("c");

  useEffect(() => {
    if (!slackUserId || !workspaceId) {
      setChecking(false);
      return;
    }

    checkLinkStatus(slackUserId, workspaceId)
      .then((status) => {
        if (status.isLinked) {
          setAlreadyLinked(true);
          setWorkspaceName(status.workspaceName ?? null);
        }
        setChecking(false);
      })
      .catch(() => {
        setChecking(false);
      });
  }, [slackUserId, workspaceId]);

  const handleLink = async (): Promise<void> => {
    if (!slackUserId || !workspaceId) {
      setError("Missing Slack user or workspace information");
      return;
    }

    setLoading(true);
    setError("");

    const result = await linkSlackAccount(slackUserId, workspaceId, channelId);

    if (result.success) {
      const params = new URLSearchParams({ linked: "true" });
      if (workspaceId) params.set("workspace_id", workspaceId);
      if (channelId) params.set("channel_id", channelId);
      router.push(`/slack/success?${params.toString()}`);
    } else {
      setError(result.error ?? "Failed to link account");
      setLoading(false);
    }
  };

  // Show error if required params are missing
  if (!slackUserId || !workspaceId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col items-center gap-6 p-10">
            <div className="rounded-md bg-destructive/10 p-4 text-center text-sm text-destructive">
              Invalid link. Missing required parameters.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.08)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.08)_1px,transparent_1px)] bg-[size:3rem_3rem]" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />
      <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-[#A6DEFF]/10 blur-3xl" />
      <div className="absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-[#FFE7A2]/15 blur-3xl" />

      {/* Theme Toggle Button */}
      <button
        onClick={toggleTheme}
        className="fixed right-6 top-6 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted"
        aria-label="Toggle theme"
      >
        {theme === "dark" ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        )}
      </button>

      <div className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center gap-8 p-10">
          {/* Header with Logo */}
          <div className="flex items-center gap-2">
            <Image
              src={
                theme === "dark"
                  ? "/assets/vm0-logo.svg"
                  : "/assets/vm0-logo-dark.svg"
              }
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
            <span className="text-2xl text-foreground">+ Slack</span>
          </div>

          {checking ? (
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">
                Checking link status...
              </p>
            </div>
          ) : alreadyLinked ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-500/10">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-lime-600"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-lg font-medium leading-7 text-foreground">
                  Already Linked
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Your Slack account is already connected to VM0
                  {workspaceName && ` in ${workspaceName}`}.
                </p>
              </div>
              <button
                onClick={() => {
                  const params = new URLSearchParams({ linked: "true" });
                  if (workspaceId) params.set("workspace_id", workspaceId);
                  if (channelId) params.set("channel_id", channelId);
                  router.push(`/slack/success?${params.toString()}`);
                }}
                className="mt-2 h-9 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Continue
              </button>
            </div>
          ) : (
            <>
              {/* Title and Description */}
              <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-lg font-medium leading-7 text-foreground">
                  Link Your Slack Account
                </h1>
                <p className="text-sm leading-5 text-muted-foreground">
                  Connect your Slack account to interact with VM0 agents
                  directly from Slack.
                </p>
              </div>

              {/* Error Message */}
              {error && (
                <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                  {error}
                </div>
              )}

              {/* Link Button */}
              <div className="w-full">
                <button
                  onClick={() => void handleLink()}
                  disabled={loading}
                  className="h-9 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {loading ? "Linking..." : "Link Slack Account"}
                </button>

                {/* Footer Text */}
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  This will allow VM0 to respond to your messages in Slack.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SlackLinkPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-col items-center gap-6 p-10">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          </div>
        </div>
      }
    >
      <SlackLinkContent />
    </Suspense>
  );
}
