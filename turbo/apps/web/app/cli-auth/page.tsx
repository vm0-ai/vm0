"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { verifyDeviceAction } from "./actions";
import { useTheme } from "../components/ThemeProvider";

const CODE_LENGTH = 8;

export default function CliAuthPage(): React.JSX.Element {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const getCode = useCallback((): string => {
    const first = digits.slice(0, 4).join("");
    const second = digits.slice(4, 8).join("");
    return `${first}-${second}`;
  }, [digits]);

  const handleInputChange = (index: number, value: string): void => {
    const char = value.slice(-1).toUpperCase();
    if (char && !/^[A-Z0-9]$/.test(char)) return;

    const newDigits = [...digits];
    newDigits[index] = char;
    setDigits(newDigits);
    setError("");

    // Auto-focus next input
    if (char && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
    if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault();
    const pastedData = e.clipboardData
      .getData("text")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, CODE_LENGTH);

    if (pastedData) {
      const newDigits = [...digits];
      const chars = Array.from(pastedData);
      chars.forEach((char, i) => {
        newDigits[i] = char;
      });
      setDigits(newDigits);
      setError("");

      // Focus the next empty input or the last input
      const nextEmptyIndex = newDigits.findIndex((d) => !d);
      if (nextEmptyIndex !== -1) {
        inputRefs.current[nextEmptyIndex]?.focus();
      } else {
        inputRefs.current[CODE_LENGTH - 1]?.focus();
      }
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();

    const code = getCode();
    if (code.replace("-", "").length !== CODE_LENGTH) {
      setError("Please enter a valid 8-character code");
      return;
    }

    setLoading(true);
    setError("");

    // Detect browser timezone for auto-setting on first login
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    verifyDeviceAction(code, timezone)
      .then((result) => {
        if (result.success) {
          router.push("/cli-auth/success");
        } else {
          setError(result.error ?? "Failed to verify device code");
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "An error occurred");
        setLoading(false);
      });
  };

  const isComplete = digits.every((d) => d !== "");

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      {/* Background grid pattern - medium grid with balanced visibility */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.08)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.08)_1px,transparent_1px)] bg-[size:3rem_3rem]" />

      {/* Gradient glow overlay - using the palette colors */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />

      {/* Radial glow - peach tone left */}
      <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-[#FFC8B0]/15 blur-3xl" />

      {/* Radial glow - blue tone center */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[600px] w-[600px] rounded-full bg-[#A6DEFF]/10 blur-3xl" />

      {/* Radial glow - yellow tone right */}
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
            <span className="text-2xl text-foreground">Platform</span>
          </div>

          {/* Title and Description */}
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-lg font-medium leading-7 text-foreground">
              Authorize VM0 Platform CLI
            </h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Enter the code displayed in your terminal to authorize the CLI
            </p>
          </div>

          {/* Code Input Form */}
          <form onSubmit={handleSubmit} className="w-full">
            <div className="flex flex-col items-center gap-3">
              {/* Code Input Boxes */}
              <div className="flex items-center gap-1">
                {/* First 4 boxes */}
                {[0, 1, 2, 3].map((index) => (
                  <input
                    key={index}
                    ref={(el) => {
                      inputRefs.current[index] = el;
                    }}
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    value={digits[index]}
                    onChange={(e) => handleInputChange(index, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    onPaste={handlePaste}
                    disabled={loading}
                    className="h-9 w-9 rounded-lg border border-border bg-input text-center text-base font-medium uppercase text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                    maxLength={1}
                  />
                ))}

                {/* Dash separator */}
                <span className="px-1 text-sm text-muted-foreground">-</span>

                {/* Last 4 boxes */}
                {[4, 5, 6, 7].map((index) => (
                  <input
                    key={index}
                    ref={(el) => {
                      inputRefs.current[index] = el;
                    }}
                    type="text"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    value={digits[index]}
                    onChange={(e) => handleInputChange(index, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(index, e)}
                    onPaste={handlePaste}
                    disabled={loading}
                    className="h-9 w-9 rounded-lg border border-border bg-input text-center text-base font-medium uppercase text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                    maxLength={1}
                  />
                ))}
              </div>

              {/* Error Message */}
              {error && (
                <div className="w-full rounded-md bg-destructive/10 p-2 text-center text-xs text-destructive">
                  {error}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading || !isComplete}
                className="mt-4 h-9 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {loading ? "Verifying..." : "Verify"}
              </button>

              {/* Footer Text */}
              <p className="text-center text-xs text-muted-foreground">
                This will grant the CLI access to your account for 90 days.
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
