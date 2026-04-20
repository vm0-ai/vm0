"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { linkIMessageAction } from "./actions";
import { useTheme } from "../../components/ThemeProvider";

type LinkState = "idle" | "loading" | "success" | "error";

export default function IMessageConnectPage(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [state, setState] = useState<LinkState>("idle");
  const [error, setError] = useState("");
  const [orgName, setOrgName] = useState("");
  const { theme, toggleTheme } = useTheme();

  const handle = searchParams.get("handle") ?? "";
  const orgId = searchParams.get("org") ?? "";
  const timestamp = Number(searchParams.get("ts") ?? "0");
  const signature = searchParams.get("sig") ?? "";

  const isValid = handle && orgId && timestamp && signature;

  const handleLink = (): void => {
    if (!isValid) return;

    setState("loading");
    setError("");

    linkIMessageAction(handle, orgId, timestamp, signature)
      .then((result) => {
        if (result.success) {
          setState("success");
          setOrgName(result.orgName ?? "");
        } else {
          setError(result.error ?? "Failed to link account");
          setState("error");
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "An error occurred");
        setState("error");
      });
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.08)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.08)_1px,transparent_1px)] bg-[size:3rem_3rem]" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />

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
          <div className="flex items-center gap-2">
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

          {!isValid ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-lg font-medium text-foreground">
                Invalid Link
              </h1>
              <p className="text-sm text-muted-foreground">
                This connect link is invalid or incomplete. Please send a new
                message to get a fresh link.
              </p>
            </div>
          ) : state === "success" ? (
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
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
                  className="text-green-600 dark:text-green-400"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 className="text-lg font-medium text-foreground">
                Account Linked
              </h1>
              <p className="text-sm text-muted-foreground">
                Your iMessage account has been linked
                {orgName ? ` to ${orgName}` : ""}. You can now send messages
                directly to your agent.
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                You can close this page and return to iMessage.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 text-center">
              <h1 className="text-lg font-medium text-foreground">
                Link iMessage Account
              </h1>
              <p className="text-sm text-muted-foreground">
                Link your iMessage account <strong>{handle}</strong> to your VM0
                organization.
              </p>

              {state === "error" && (
                <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                  {error}
                </div>
              )}

              <button
                onClick={handleLink}
                disabled={state === "loading"}
                className="mt-2 h-9 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {state === "loading" ? "Linking..." : "Link Account"}
              </button>

              <p className="text-xs text-muted-foreground">
                After linking, all messages you send via iMessage will be
                handled by your organization&apos;s agent.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
