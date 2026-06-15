"use client";

import { useTheme } from "../../components/ThemeProvider";
import Image from "next/image";
import { IconCheck } from "@tabler/icons-react";

export default function CliAuthSuccessPage(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();

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
            <span className="text-2xl text-foreground">Platform</span>
          </div>

          {/* Success Content - gap-4 between elements */}
          <div className="mt-4 flex flex-col items-center gap-4">
            {/* Success Icon */}
            <IconCheck size={40} className="text-lime-600" stroke={1} />

            {/* Title and Description */}
            <div className="flex flex-col items-center gap-2 text-center">
              <h1 className="text-lg font-medium leading-7 text-foreground">
                Your CLI is authorized and connected.
              </h1>
              <p className="text-sm leading-5 text-muted-foreground">
                Close this window and return to your terminal to complete login
                automatically.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
