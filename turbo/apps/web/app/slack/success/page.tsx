"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { Button } from "@vm0/ui";
import { useTheme } from "../../components/ThemeProvider";
import { IconCheck } from "@tabler/icons-react";

function SlackSuccessContent(): React.JSX.Element {
  const searchParams = useSearchParams();
  const { theme, toggleTheme } = useTheme();

  const workspace = searchParams.get("workspace");
  const workspaceId = searchParams.get("workspace_id");
  const channelId = searchParams.get("channel_id");
  const linked = searchParams.get("linked");

  const isLinked = linked === "true";

  // Build Slack deep link to open the channel
  const slackDeepLink =
    workspaceId && channelId
      ? `slack://channel?team=${workspaceId}&id=${channelId}`
      : "slack://open";

  // Auto-open Slack on page load
  useEffect(() => {
    window.location.href = slackDeepLink;
  }, [slackDeepLink]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
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

      <div className="w-full max-w-[400px] min-h-[380px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-col items-center p-10">
          {/* Header with Logo */}
          <div className="flex items-center gap-2 mb-8">
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
            <span className="text-2xl font-medium text-foreground">
              + Slack
            </span>
          </div>

          {/* Content */}
          <div className="mt-4 flex flex-col items-center gap-4">
            {/* Icon */}
            <IconCheck size={40} className="text-lime-600" stroke={1} />

            {/* Title and Description */}
            <div className="flex flex-col items-center gap-2 text-center">
              {isLinked ? (
                <>
                  <h1 className="text-lg font-medium leading-7 text-foreground">
                    Account Linked Successfully
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    Your Slack account is now connected to VM0. You can now
                    interact with agents by mentioning @VM0 in Slack.
                  </p>
                </>
              ) : (
                <>
                  <h1 className="text-lg font-medium leading-7 text-foreground">
                    Slack App Installed
                  </h1>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {workspace
                      ? `VM0 has been installed to ${workspace}. `
                      : "VM0 has been installed to your workspace. "}
                    You can now close this window and use @VM0 in Slack.
                  </p>
                </>
              )}
            </div>

            {/* Open Slack Button */}
            <Button asChild className="mt-4 w-full">
              <a href={slackDeepLink} className="!text-primary-foreground">
                Open Slack
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.52 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.166 0a2.528 2.528 0 0 1 2.521 2.522v6.312zm-2.521 10.124a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.166 24a2.528 2.528 0 0 1-2.521-2.52v-2.522h2.521zm0-1.271a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.312A2.528 2.528 0 0 1 24 15.166a2.528 2.528 0 0 1-2.52 2.521h-6.313z" />
                </svg>
              </a>
            </Button>

            {/* Instructions */}
            <div className="mt-4 w-full rounded-lg bg-muted/50 p-4">
              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">Next steps:</strong>
              </p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                <li>
                  • Use{" "}
                  <code className="rounded bg-muted px-1">/vm0 agent add</code>{" "}
                  to add an agent
                </li>
                <li>
                  • Mention <code className="rounded bg-muted px-1">@VM0</code>{" "}
                  to chat with your agents
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SlackSuccessPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="w-full max-w-[400px] min-h-[380px] overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-col items-center p-10">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="mt-4 text-sm text-muted-foreground">Loading...</p>
            </div>
          </div>
        </div>
      }
    >
      <SlackSuccessContent />
    </Suspense>
  );
}
