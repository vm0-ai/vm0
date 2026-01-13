"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { verifyDeviceAction } from "./actions";

export default function CliAuthPage(): React.JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const formatCode = (value: string): string => {
    // Remove non-alphanumeric characters
    const clean = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    // Add dash after 4 characters
    if (clean.length > 4) {
      return `${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
    }
    return clean;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const formatted = formatCode(e.target.value);
    setCode(formatted);
    setError("");
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();

    if (code.length !== 9) {
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-900">
          Authorize CLI Device
        </h1>

        <p className="mb-6 text-center text-gray-600">
          Enter the code displayed in your terminal to authorize the CLI.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="mb-6">
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={handleChange}
              placeholder="XXXX-XXXX"
              maxLength={9}
              className="w-full rounded-md border border-gray-300 px-4 py-3 text-center text-2xl font-mono tracking-widest focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loading}
            />
          </div>

          {error && (
            <div className="mb-4 rounded-md bg-red-50 p-3 text-center text-sm text-red-600">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || code.length !== 9}
            className="w-full rounded-md bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400"
          >
            {loading ? "Authorizing..." : "Authorize Device"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-500">
          This will grant the CLI access to your account for 90 days.
        </p>
      </div>
    </div>
  );
}
