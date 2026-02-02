"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import { useTheme } from "../../components/ThemeProvider";
import { IconAlertCircle, IconChevronDown } from "@tabler/icons-react";

function SlackFailedContent(): React.JSX.Element {
  const searchParams = useSearchParams();
  const { theme, toggleTheme } = useTheme();
  const [showDetails, setShowDetails] = useState(false);

  const error = searchParams.get("error");

  const getErrorInfo = (
    errorCode: string | null,
  ): { title: string; message: string; isRecoverable: boolean } => {
    if (!errorCode) {
      return {
        title: "Something went wrong",
        message: "An unexpected error occurred. Please try again.",
        isRecoverable: true,
      };
    }

    if (errorCode === "access_denied") {
      return {
        title: "Installation Cancelled",
        message: "You cancelled the Slack app installation.",
        isRecoverable: true,
      };
    }

    if (errorCode.includes("invalid_code") || errorCode.includes("expired")) {
      return {
        title: "Authorization Expired",
        message:
          "The authorization link has expired or was already used. Please start the installation again.",
        isRecoverable: true,
      };
    }

    if (errorCode.includes("query") || errorCode.includes("database")) {
      return {
        title: "Server Error",
        message:
          "We encountered a problem saving your installation. Please try again in a few moments.",
        isRecoverable: true,
      };
    }

    return {
      title: "Installation Failed",
      message: "Something went wrong during the installation process.",
      isRecoverable: true,
    };
  };

  const errorInfo = getErrorInfo(error);
  const hasDetailedError = error && error.length > 50;

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

      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
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
            <span className="text-2xl text-foreground">+ Slack</span>
          </div>

          {/* Content */}
          <div className="flex flex-col items-center gap-4 w-full">
            {/* Icon */}
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <IconAlertCircle
                size={24}
                className="text-destructive"
                stroke={1.5}
              />
            </div>

            {/* Title and Description */}
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                {errorInfo.title}
              </h1>
              <p className="text-sm leading-5 text-muted-foreground">
                {errorInfo.message}
              </p>
            </div>

            {/* Error Details (collapsible) */}
            {hasDetailedError && (
              <div className="w-full">
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <span>Technical details</span>
                  <IconChevronDown
                    size={14}
                    className={`transition-transform ${showDetails ? "rotate-180" : ""}`}
                  />
                </button>
                {showDetails && (
                  <div className="mt-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground break-all max-h-32 overflow-y-auto">
                    {decodeURIComponent(error ?? "")}
                  </div>
                )}
              </div>
            )}

            {/* Retry Button */}
            {errorInfo.isRecoverable && (
              <button
                onClick={() => {
                  window.location.href = "/api/slack/oauth/install";
                }}
                className="mt-2 flex h-9 w-full items-center justify-center rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SlackFailedPage(): React.JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-col items-center p-10">
              <div className="animate-pulse">Loading...</div>
            </div>
          </div>
        </div>
      }
    >
      <SlackFailedContent />
    </Suspense>
  );
}
