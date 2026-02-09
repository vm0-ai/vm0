"use client";

import { SignIn } from "@clerk/nextjs";
import { useTheme } from "../../components/ThemeProvider";
import Image from "next/image";
import Link from "next/link";

export default function SignInPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <>
      <style suppressHydrationWarning>{`
        /* Remove shadows from Clerk components */
        .cl-card,
        .cl-rootBox,
        .cl-main,
        .cl-cardBox,
        [class*="cl-"] > div {
          box-shadow: none !important;
        }

        /* Card styles */
        .cl-card,
        .cl-rootBox > .cl-card,
        [class*="cl-card"] {
          background-color: hsl(var(--card)) !important;
          border: 1px solid hsl(var(--border)) !important;
          border-radius: 0.75rem !important;
          box-shadow: none !important;
        }

        /* Logo styles - height 24px */
        .cl-logoImage {
          height: 24px !important;
          width: auto !important;
        }

        /* Logo container - total height 32px */
        .cl-logoBox,
        .cl-card [class*="logoBox"] {
          height: 32px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          padding: 0 !important;
          margin-top: 10px !important;
        }

        /* Header title - Text-lg/Medium 18-28 */
        .cl-headerTitle,
        .cl-card h1,
        .cl-card [class*="headerTitle"],
        .cl-card [class*="Header"] h1,
        .cl-headerTitle * {
          font-size: 18px !important;
          line-height: 28px !important;
          font-weight: 500 !important;
          color: hsl(var(--foreground)) !important;
        }

        /* Subtitle - Sm-regular 14-20 */
        .cl-headerSubtitle,
        .cl-card [class*="headerSubtitle"] {
          font-size: 14px !important;
          line-height: 20px !important;
          font-weight: 400 !important;
          color: hsl(var(--muted-foreground)) !important;
        }

        /* Form field labels - 14/20 medium */
        .cl-formFieldLabel,
        .cl-card label,
        .cl-card [class*="formFieldLabel"],
        .cl-formFieldLabel * {
          font-size: 14px !important;
          line-height: 20px !important;
          font-weight: 500 !important;
          color: hsl(var(--foreground)) !important;
        }

        /* Input field styles */
        .cl-formFieldInput,
        .cl-formFieldInput input,
        .cl-card input[type="text"],
        .cl-card input[type="email"],
        .cl-card input[type="password"],
        .cl-card [class*="formFieldInput"],
        .cl-card [class*="formFieldInput"] input {
          height: 36px !important;
          background-color: transparent !important;
          border: 1px solid hsl(var(--border)) !important;
          border-radius: 0.5rem !important;
          color: hsl(var(--foreground)) !important;
          transition:
            border-color 0.2s,
            box-shadow 0.2s !important;
          box-shadow: none !important;
        }

        /* Remove inner/outer borders */
        .cl-formFieldInput > *,
        .cl-card [class*="formFieldInput"] > * {
          border: none !important;
        }

        /* Input focus state */
        .cl-formFieldInput:focus,
        .cl-formFieldInput input:focus,
        .cl-card input:focus,
        .cl-card [class*="formFieldInput"]:focus,
        .cl-card [class*="formFieldInput"] input:focus {
          border: 1px solid hsl(var(--primary)) !important;
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.1) !important;
          outline: none !important;
        }

        /* Placeholder color */
        .cl-formFieldInput::placeholder,
        .cl-formFieldInput input::placeholder,
        .cl-card input::placeholder {
          color: hsl(var(--muted-foreground)) !important;
        }

        /* Button styles - remove gradients and borders (exclude social buttons) */
        .cl-formButtonPrimary,
        button[type="submit"]:not(.cl-socialButtonsBlockButton),
        [data-localization-key="formButtonPrimary"],
        .cl-formButtonPrimary > * {
          background-image: none !important;
          background: hsl(var(--primary)) !important;
          border: none !important;
          box-shadow: none !important;
        }

        /* Button hover state (exclude social buttons) */
        .cl-formButtonPrimary:hover,
        button[type="submit"]:not(.cl-socialButtonsBlockButton):hover,
        [data-localization-key="formButtonPrimary"]:hover {
          background-image: none !important;
          background: hsl(var(--primary) / 0.9) !important;
          box-shadow: none !important;
        }

        /* Remove pseudo elements (exclude social buttons) */
        .cl-formButtonPrimary::before,
        .cl-formButtonPrimary::after,
        button[type="submit"]:not(.cl-socialButtonsBlockButton)::before,
        button[type="submit"]:not(.cl-socialButtonsBlockButton)::after {
          display: none !important;
          background-image: none !important;
        }

        /* Footer background - use card color */
        .cl-footer,
        .cl-footerAction,
        [class*="cl-footer"]:not(.cl-card):not(.cl-main):not(.cl-header),
        [class*="footerAction"] {
          background-color: hsl(var(--card)) !important;
          background: hsl(var(--card)) !important;
        }

        /* Footer action text - muted foreground */
        .cl-footerActionText,
        [class*="footerActionText"] {
          color: hsl(var(--muted-foreground)) !important;
        }

        /* Footer action link - primary color */
        .cl-footerActionLink,
        [class*="footerActionLink"] {
          color: hsl(var(--primary)) !important;
        }

        .cl-footerActionLink:hover,
        [class*="footerActionLink"]:hover {
          color: hsl(var(--primary) / 0.9) !important;
        }

        /* Social buttons (Google login) - add border and set text color */
        button[class*="socialButtonsBlockButton"],
        button[class*="cl-socialButtons"],
        .cl-socialButtonsBlockButton,
        div[class*="socialButtons"] button {
          height: 36px !important;
          background-color: transparent !important;
          background-image: none !important;
          border-width: 1px !important;
          border-style: solid !important;
          border-color: var(--color-border) !important;
          border-radius: 0.5rem !important;
          color: var(--color-foreground) !important;
          box-shadow: none !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          gap: 0.5rem !important;
          transition: background-color 0.2s !important;
        }

        /* Social buttons hover state */
        button[class*="socialButtonsBlockButton"]:hover,
        .cl-socialButtonsBlockButton:hover {
          background-color: var(--color-muted) !important;
        }

        /* Force remove all backgrounds from inner elements at all times */
        button[class*="socialButtonsBlockButton"] *,
        .cl-socialButtonsBlockButton *,
        button[class*="socialButtonsBlockButton"] > *,
        button[class*="socialButtonsBlockButton"] span,
        button[class*="socialButtonsBlockButton"] div,
        .cl-socialButtonsBlockButton > *,
        .cl-socialButtonsBlockButton span,
        .cl-socialButtonsBlockButton div,
        [class*="socialButtonsBlockButton"] [class*="internal"],
        [class*="socialButtonsBlockButton"] [class*="text"],
        [class*="socialButtonsBlockButton"] [class*="icon"],
        [class*="socialButtonsBlockButton"] [class*="cl-internal"],
        button[class*="socialButtonsBlockButton"] [class*="cl-internal"],
        .cl-internal-2iusy0 {
          background: none !important;
          background-color: transparent !important;
          background-image: none !important;
          border: none !important;
        }

        /* Force remove all backgrounds from inner elements on hover */
        button[class*="socialButtonsBlockButton"]:hover *,
        .cl-socialButtonsBlockButton:hover *,
        button[class*="socialButtonsBlockButton"] *:hover,
        .cl-socialButtonsBlockButton *:hover,
        button[class*="socialButtonsBlockButton"]:hover > *,
        button[class*="socialButtonsBlockButton"]:hover span,
        button[class*="socialButtonsBlockButton"]:hover div,
        button[class*="socialButtonsBlockButton"] span:hover,
        button[class*="socialButtonsBlockButton"] div:hover,
        [class*="socialButtonsBlockButton"]:hover [class*="internal"],
        [class*="socialButtonsBlockButton"]:hover [class*="text"],
        [class*="socialButtonsBlockButton"]:hover [class*="icon"],
        [class*="socialButtonsBlockButton"] [class*="internal"]:hover,
        [class*="socialButtonsBlockButton"] [class*="text"]:hover,
        [class*="socialButtonsBlockButton"] [class*="icon"]:hover,
        [class*="socialButtonsBlockButton"]:hover [class*="cl-internal"],
        [class*="socialButtonsBlockButton"] [class*="cl-internal"]:hover,
        button[class*="socialButtonsBlockButton"]:hover [class*="cl-internal"],
        button[class*="socialButtonsBlockButton"] [class*="cl-internal"]:hover,
        .cl-internal-2iusy0:hover,
        button:hover .cl-internal-2iusy0 {
          background: none !important;
          background-color: transparent !important;
          background-image: none !important;
        }

        /* Social button text color */
        button[class*="socialButtonsBlockButton"] *,
        .cl-socialButtonsBlockButton *,
        .cl-socialButtonsBlockButton span,
        button[class*="socialButtons"] span {
          color: var(--color-foreground) !important;
          background: none !important;
          background-color: transparent !important;
          background-image: none !important;
        }
      `}</style>
      <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
        {/* Background grid pattern - medium grid with subtle visibility */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.06)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.06)_1px,transparent_1px)] bg-[size:3rem_3rem]" />

        {/* Gradient glow overlay - using the palette colors */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />

        {/* Radial glow - peach tone left */}
        <div className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />

        {/* Radial glow - blue tone center */}
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-[#A6DEFF]/10 blur-3xl" />

        {/* Radial glow - yellow tone right */}
        <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-[#FFE7A2]/15 blur-3xl" />

        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          className="fixed right-6 top-6 z-50 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-muted"
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

        {/* Logo Header */}
        <Link
          href="/"
          className="absolute left-6 top-6 flex items-center gap-2"
        >
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
        </Link>

        <SignIn
          appearance={{
            layout: {
              logoImageUrl:
                theme === "dark"
                  ? "/assets/vm0-logo.svg"
                  : "/assets/vm0-logo-dark.svg",
              logoPlacement: "inside",
            },
            elements: {
              rootBox: {
                margin: "0 auto",
              },
              card: {
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "0.75rem",
                boxShadow: "none",
              },
              headerTitle: "text-foreground font-medium",
              headerSubtitle: "text-muted-foreground",
              socialButtonsBlockButton:
                "h-9 bg-transparent border border-border rounded-lg text-foreground flex items-center justify-center gap-2",
              socialButtonsBlockButtonText: "text-foreground",
              formButtonPrimary:
                "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-xs font-medium h-9 rounded-md",
              formFieldInput: "text-foreground rounded-lg transition-colors",
              formFieldLabel: "text-foreground",
              footerActionLink: "text-primary hover:text-primary/90",
              identityPreviewText: "text-foreground",
              identityPreviewEditButton: "text-muted-foreground",
              formFieldInputShowPasswordButton: "text-muted-foreground",
              otpCodeFieldInput: "text-foreground rounded-lg",
              formResendCodeLink: "text-primary",
              footer: "hidden",
            },
          }}
        />
      </div>
    </>
  );
}
