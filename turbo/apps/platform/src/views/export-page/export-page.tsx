import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconCircleCheck,
  IconDatabaseExport,
  IconDownload,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import type { UserExportStatusResponse } from "@vm0/api-contracts/contracts/user-export";
import { Button } from "@vm0/ui";
import { now } from "../../lib/time.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  startUserExport$,
  userExportStartError$,
  userExportStatus$,
} from "../../signals/export-page/export-page-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

type ExportViewState =
  | "loading"
  | "ready"
  | "in-progress"
  | "download"
  | "expired"
  | "failed"
  | "rate-limited";

const PRIMARY_ACTION_BUTTON_CLASS =
  "h-9 w-full gap-2 bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80";

function formatRelativeTime(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return "soon";
  }

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function deriveViewState(
  data: UserExportStatusResponse | null,
  loading: boolean,
): ExportViewState {
  if (loading) {
    return "loading";
  }

  const job = data?.job;
  if (!job) {
    return data?.canExport ? "ready" : "rate-limited";
  }

  if (job.status === "pending" || job.status === "running") {
    return "in-progress";
  }

  if (job.status === "failed") {
    return "failed";
  }

  if (job.status === "completed") {
    const expired =
      job.expiresAt !== null && new Date(job.expiresAt).getTime() <= now();
    if (expired) {
      return "expired";
    }
    if (job.downloadUrl) {
      return "download";
    }
  }

  return data?.canExport ? "ready" : "rate-limited";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load export";
}

function StatusIcon({ viewState }: { readonly viewState: ExportViewState }) {
  if (viewState === "loading" || viewState === "in-progress") {
    return <IconLoader2 size={22} className="animate-spin" stroke={1.8} />;
  }
  if (viewState === "download") {
    return <IconCircleCheck size={22} stroke={1.8} />;
  }
  if (viewState === "failed") {
    return <IconAlertCircle size={22} stroke={1.8} />;
  }
  return <IconDatabaseExport size={22} stroke={1.8} />;
}

function StatusText({
  viewState,
  data,
}: {
  readonly viewState: ExportViewState;
  readonly data: UserExportStatusResponse | null;
}) {
  if (viewState === "loading") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Checking export status
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Your latest export state will appear here.
        </p>
      </>
    );
  }

  if (viewState === "in-progress") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Preparing your export
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          This can take a few minutes. You can leave this page open.
        </p>
      </>
    );
  }

  if (viewState === "download") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Your export is ready
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {data?.job?.expiresAt
            ? `The download link expires in ${formatRelativeTime(data.job.expiresAt)}.`
            : "Download it before the link expires."}
        </p>
      </>
    );
  }

  if (viewState === "expired") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Previous export expired
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Start a new export to get a fresh download link.
        </p>
      </>
    );
  }

  if (viewState === "failed") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Export did not finish
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Try again, or contact support if this keeps happening.
        </p>
      </>
    );
  }

  if (viewState === "rate-limited") {
    return (
      <>
        <h2 className="text-base font-semibold text-foreground">
          Export recently requested
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          {data?.nextExportAt
            ? `You can start another export in ${formatRelativeTime(data.nextExportAt)}.`
            : "You can start another export after the cooldown ends."}
        </p>
      </>
    );
  }

  return (
    <>
      <h2 className="text-base font-semibold text-foreground">
        Ready to export
      </h2>
      <p className="text-sm leading-6 text-muted-foreground">
        Create a ZIP file with your workspace data.
      </p>
    </>
  );
}

function ExportActions({
  viewState,
  data,
  triggering,
  onTrigger,
}: {
  readonly viewState: ExportViewState;
  readonly data: UserExportStatusResponse | null;
  readonly triggering: boolean;
  readonly onTrigger: () => void;
}) {
  const canExport = data?.canExport ?? false;
  const downloadUrl = data?.job?.downloadUrl;

  if (viewState === "download" && downloadUrl) {
    return (
      <div className="flex w-full flex-col gap-2">
        <Button asChild className={PRIMARY_ACTION_BUTTON_CLASS}>
          <a href={downloadUrl} download>
            <IconDownload size={16} stroke={1.8} />
            Download export
          </a>
        </Button>
        {canExport && (
          <Button
            type="button"
            variant="outline"
            className="zero-btn-morandi h-9 w-full gap-2 rounded-lg border"
            disabled={triggering}
            onClick={onTrigger}
          >
            {triggering ? (
              <IconLoader2 size={16} className="animate-spin" stroke={1.8} />
            ) : (
              <IconRefresh size={16} stroke={1.8} />
            )}
            Export again
          </Button>
        )}
      </div>
    );
  }

  if (viewState === "loading" || viewState === "in-progress") {
    return null;
  }

  if (!canExport) {
    return null;
  }

  return (
    <Button
      type="button"
      className={PRIMARY_ACTION_BUTTON_CLASS}
      disabled={triggering}
      onClick={onTrigger}
    >
      {triggering ? (
        <IconLoader2 size={16} className="animate-spin" stroke={1.8} />
      ) : (
        <IconDatabaseExport size={16} stroke={1.8} />
      )}
      {triggering ? "Starting export" : "Export my data"}
    </Button>
  );
}

function ExportScopeList() {
  const items = [
    "Agent instruction documents",
    "Workflow SKILL.md instructions and files",
    "Memory files",
    "User and assistant text chat messages",
  ];

  return (
    <div className="grid gap-2 rounded-xl border border-border/70 bg-gray-50 p-3 text-sm dark:bg-gray-900/30">
      {items.map((item) => {
        return (
          <div key={item} className="flex items-center gap-2 text-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
            <span>{item}</span>
          </div>
        );
      })}
      <p className="pt-1 text-xs leading-5 text-muted-foreground">
        Artifacts are not included in this export.
      </p>
    </div>
  );
}

function iconTone(viewState: ExportViewState): string {
  if (viewState === "failed") {
    return "bg-destructive/10 text-destructive";
  }
  if (viewState === "download") {
    return "bg-emerald-500/10 text-emerald-600";
  }
  return "bg-gray-50 text-muted-foreground";
}

export function ExportPage() {
  const statusLoadable = useLoadable(userExportStatus$);
  const data = statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const loading = statusLoadable.state === "loading";
  const loadError =
    statusLoadable.state === "hasError"
      ? errorMessage(statusLoadable.error)
      : null;
  const startError = useGet(userExportStartError$);
  const [startLoadable, startExport] = useLoadableSet(startUserExport$);
  const pageSignal = useGet(pageSignal$);
  const triggering = startLoadable.state === "loading";
  const startActionError =
    startLoadable.state === "hasError"
      ? errorMessage(startLoadable.error)
      : null;
  const error = startError ?? startActionError ?? loadError;
  const viewState = deriveViewState(data, loading);
  const handleTrigger = () => {
    detach(startExport(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="zero-app zero-viewport-shell flex w-full bg-background zero-workspace-bg">
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4 py-8">
        <section className="zero-card w-full max-w-[440px] p-5 sm:p-7">
          <div className="mb-6 flex items-center justify-between gap-4">
            <Link
              pathname="/"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              <IconArrowLeft size={14} stroke={1.8} />
              Back to Zero
            </Link>
            <img
              src="/assets/vm0-logo-dark.svg"
              alt="VM0"
              className="h-4 w-auto dark:hidden"
            />
            <img
              src="/assets/vm0-logo.svg"
              alt="VM0"
              className="hidden h-4 w-auto dark:block"
            />
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Export data
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Download the files and text records you created in Zero.
              </p>
            </div>

            <ExportScopeList />

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <div
                className="flex items-start gap-3"
                aria-live={viewState === "in-progress" ? "polite" : undefined}
              >
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${iconTone(
                    viewState,
                  )}`}
                >
                  <StatusIcon viewState={viewState} />
                </div>
                <div className="min-w-0 flex-1">
                  <StatusText viewState={viewState} data={data} />
                </div>
              </div>

              {error ? (
                <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <div className="mt-4">
                <ExportActions
                  viewState={viewState}
                  data={data}
                  triggering={triggering}
                  onTrigger={handleTrigger}
                />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
