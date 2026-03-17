"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useTheme } from "../components/ThemeProvider";

interface ExportJob {
  id: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
  error: string | null;
}

interface ExportStatusResponse {
  job: ExportJob | null;
  canExport: boolean;
  nextExportAt: string | null;
}

const POLL_INTERVAL_MS = 5000;

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function formatRelativeTime(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "soon";
}

function ExportButton({
  onClick,
  disabled,
  label,
  variant = "primary",
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  variant?: "primary" | "secondary";
}) {
  const base =
    variant === "primary"
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "border border-border bg-card text-foreground hover:bg-muted";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-9 w-full rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${base}`}
    >
      {disabled ? "Starting..." : label}
    </button>
  );
}

function InProgressState() {
  return (
    <>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Your export is being prepared...
      </div>
      <p className="text-xs text-muted-foreground">
        This may take a few minutes. You&apos;ll also receive an email when
        it&apos;s ready.
      </p>
    </>
  );
}

function DownloadState({
  job,
  canExport,
  triggering,
  onTrigger,
}: {
  job: ExportJob;
  canExport: boolean;
  triggering: boolean;
  onTrigger: () => void;
}) {
  return (
    <>
      <a
        href={job.downloadUrl ?? undefined}
        download
        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Download Export
      </a>
      {job.expiresAt && (
        <p className="text-xs text-muted-foreground">
          Download expires in {formatRelativeTime(job.expiresAt)}
        </p>
      )}
      {canExport && (
        <ExportButton
          onClick={onTrigger}
          disabled={triggering}
          label="Export Again"
          variant="secondary"
        />
      )}
    </>
  );
}

function ExpiredState({
  canExport,
  triggering,
  onTrigger,
}: {
  canExport: boolean;
  triggering: boolean;
  onTrigger: () => void;
}) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Your previous export has expired.
      </p>
      {canExport && (
        <ExportButton
          onClick={onTrigger}
          disabled={triggering}
          label="Export My Data"
        />
      )}
    </>
  );
}

function FailedState({
  error,
  canExport,
  triggering,
  onTrigger,
}: {
  error: string | null;
  canExport: boolean;
  triggering: boolean;
  onTrigger: () => void;
}) {
  return (
    <>
      <div className="w-full rounded-md bg-destructive/10 p-3 text-center text-sm text-destructive">
        {error ?? "Export failed. Please try again."}
      </div>
      {canExport && (
        <ExportButton
          onClick={onTrigger}
          disabled={triggering}
          label="Try Again"
        />
      )}
    </>
  );
}

type ExportViewState =
  | "loading"
  | "in-progress"
  | "download"
  | "expired"
  | "failed"
  | "ready"
  | "rate-limited";

function deriveViewState(
  data: ExportStatusResponse | null,
  loading: boolean,
): ExportViewState {
  if (loading) return "loading";
  const job = data?.job;
  if (!job) return data?.canExport ? "ready" : "rate-limited";
  if (job.status === "pending" || job.status === "running")
    return "in-progress";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") {
    const expired = job.expiresAt && new Date(job.expiresAt) <= new Date();
    if (expired) return "expired";
    if (job.downloadUrl) return "download";
  }
  return data?.canExport ? "ready" : "rate-limited";
}

function ExportStateView({
  viewState,
  data,
  triggering,
  onTrigger,
}: {
  viewState: ExportViewState;
  data: ExportStatusResponse | null;
  triggering: boolean;
  onTrigger: () => void;
}) {
  const job = data?.job;
  const canExport = data?.canExport ?? false;

  switch (viewState) {
    case "loading":
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Loading...
        </div>
      );
    case "in-progress":
      return <InProgressState />;
    case "download":
      return job ? (
        <DownloadState
          job={job}
          canExport={canExport}
          triggering={triggering}
          onTrigger={onTrigger}
        />
      ) : null;
    case "expired":
      return (
        <ExpiredState
          canExport={canExport}
          triggering={triggering}
          onTrigger={onTrigger}
        />
      );
    case "failed":
      return (
        <FailedState
          error={job?.error ?? null}
          canExport={canExport}
          triggering={triggering}
          onTrigger={onTrigger}
        />
      );
    case "ready":
      return (
        <ExportButton
          onClick={onTrigger}
          disabled={triggering}
          label="Export My Data"
        />
      );
    case "rate-limited":
      return data?.nextExportAt ? (
        <p className="text-xs text-muted-foreground">
          Next export available in {formatRelativeTime(data.nextExportAt)}
        </p>
      ) : null;
  }
}

function ExportContent({
  data,
  loading,
  error,
  triggering,
  onTrigger,
}: {
  data: ExportStatusResponse | null;
  loading: boolean;
  error: string | null;
  triggering: boolean;
  onTrigger: () => void;
}) {
  const viewState = deriveViewState(data, loading);

  return (
    <>
      {error && (
        <div className="w-full rounded-md bg-destructive/10 p-3 text-center text-sm text-destructive">
          {error}
        </div>
      )}

      <ExportStateView
        viewState={viewState}
        data={data}
        triggering={triggering}
        onTrigger={onTrigger}
      />

      <p className="text-center text-xs text-muted-foreground">
        Your export will include agents, chat history, artifacts, and settings.
        A download link will also be sent to your email.
      </p>
    </>
  );
}

async function fetchExportStatus(
  getToken: () => Promise<string | null>,
): Promise<ExportStatusResponse | null> {
  const token = await getToken();
  if (!token) return null;

  const res = await fetch("/api/user/export", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ExportStatusResponse;
}

async function triggerExportRequest(
  getToken: () => Promise<string | null>,
): Promise<{ ok: boolean; rateLimited: boolean }> {
  const token = await getToken();
  if (!token) return { ok: false, rateLimited: false };

  const res = await fetch("/api/user/export", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) return { ok: false, rateLimited: true };
  return { ok: res.ok, rateLimited: false };
}

function useExportStatus() {
  const { getToken, isSignedIn, isLoaded } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<ExportStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetchExportStatus(getToken)
      .then((result) => {
        if (!result) {
          setError("Failed to load export status");
        } else {
          setData(result);
          setError(null);
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load export status");
        setLoading(false);
      });
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.push("/sign-in");
      return;
    }
    refresh();
  }, [isLoaded, isSignedIn, router, refresh]);

  useEffect(() => {
    const isInProgress =
      data?.job?.status === "pending" || data?.job?.status === "running";
    if (!isInProgress) return;

    const interval = setInterval(refresh, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [data?.job?.status, refresh]);

  const handleTrigger = useCallback(() => {
    setTriggering(true);
    triggerExportRequest(getToken)
      .then((result) => {
        if (result.rateLimited) {
          setError("You can only export once every 24 hours.");
        } else if (!result.ok) {
          setError("Failed to start export");
        } else {
          setError(null);
          refresh();
        }
        setTriggering(false);
      })
      .catch(() => {
        setError("Failed to start export");
        setTriggering(false);
      });
  }, [getToken, refresh]);

  return { data, loading, triggering, error, handleTrigger };
}

export default function ExportPage(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const { data, loading, triggering, error, handleTrigger } = useExportStatus();

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-6 overflow-hidden">
      {/* Background grid pattern */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.08)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.08)_1px,transparent_1px)] bg-[size:3rem_3rem]" />

      {/* Gradient glow overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-[#FFC8B0]/20 via-[#A6DEFF]/15 to-[#FFE7A2]/20 blur-3xl" />

      {/* Radial glows */}
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
            <span className="text-2xl text-foreground">Platform</span>
          </div>

          {/* Title */}
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-lg font-medium leading-7 text-foreground">
              Export Your Data
            </h1>
            <p className="text-sm leading-5 text-muted-foreground">
              Download a copy of all your data stored on VM0 Platform
            </p>
          </div>

          {/* Content */}
          <div className="flex w-full flex-col items-center gap-4">
            <ExportContent
              data={data}
              loading={loading}
              error={error}
              triggering={triggering}
              onTrigger={handleTrigger}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
