"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { verifyDeviceAction } from "./actions";

const CODE_LENGTH = 8;

export default function CliAuthPage(): React.JSX.Element {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const router = useRouter();

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

    verifyDeviceAction(code)
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
    <div className="flex min-h-screen items-center justify-center bg-sidebar p-6">
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-card shadow-[0px_0px_0px_1px_rgba(0,0,0,0.06),0px_1px_2px_0px_rgba(0,0,0,0.06),0px_0px_2px_0px_rgba(0,0,0,0.08)]">
        <div className="flex flex-col items-center gap-8 p-10">
          {/* Header with Logo */}
          <div className="flex items-center gap-2.5">
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
                    className="h-9 w-9 rounded-lg border border-border bg-card text-center text-base font-medium uppercase text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
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
                    className="h-9 w-9 rounded-lg border border-border bg-card text-center text-base font-medium uppercase text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
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
                className="mt-4 h-9 w-full rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
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
