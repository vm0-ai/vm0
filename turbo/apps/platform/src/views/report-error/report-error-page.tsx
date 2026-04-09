import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { Button, Input } from "@vm0/ui";
import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  reportErrorRun$,
  reportState$,
  reportReference$,
  reportErrorMessage$,
  reportTitle$,
  reportDescription$,
  setReportTitle$,
  setReportDescription$,
  submitErrorReport$,
} from "../../signals/report-error/report-error-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ReportErrorPage() {
  const pageSignal = useGet(pageSignal$);
  const runLoadable = useLastLoadable(reportErrorRun$);
  const reportState = useGet(reportState$);
  const reference = useGet(reportReference$);
  const errorMessage = useGet(reportErrorMessage$);
  const doSubmit = useSet(submitErrorReport$);

  if (runLoadable.state === "hasError") {
    return <ErrorCard message="Failed to load run details" />;
  }

  if (runLoadable.state === "loading" || !runLoadable.data) {
    return <LoadingCard />;
  }

  const run = runLoadable.data;

  if (run.status !== "failed") {
    return <ErrorCard message="This run did not fail and cannot be reported" />;
  }

  if (reportState === "success" && reference) {
    return <SuccessCard reference={reference} />;
  }

  if (reportState === "error") {
    return (
      <ErrorCard
        message={errorMessage ?? "Failed to submit error report"}
        onRetry={() => {
          detach(doSubmit(pageSignal), Reason.DomCallback);
        }}
      />
    );
  }

  return (
    <ConfirmCard
      loading={reportState === "loading"}
      onSubmit={() => {
        detach(doSubmit(pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function LoadingCard() {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <IconLoader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

function ConfirmCard({
  loading,
  onSubmit,
}: {
  loading: boolean;
  onSubmit: () => void;
}) {
  const title = useGet(reportTitle$);
  const description = useGet(reportDescription$);
  const setTitle = useSet(setReportTitle$);
  const setDescription = useSet(setReportDescription$);

  const canSubmit = title.trim().length > 0;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-6 rounded-[20px] border border-border bg-background px-8 py-10">
        <IconAlertTriangle size={40} className="text-orange-500 opacity-70" />

        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Report error to developer
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Send diagnostic information for this failed run to the developer
            team. We will investigate and follow up shortly.
          </p>
        </div>

        <div className="w-full flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="report-title"
              className="text-xs font-medium text-muted-foreground"
            >
              Title
            </label>
            <Input
              id="report-title"
              placeholder="Brief summary of the issue"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="report-description"
              className="text-xs font-medium text-muted-foreground"
            >
              Description
            </label>
            <textarea
              id="report-description"
              className="flex w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-sm placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              rows={3}
              placeholder="What happened? What did you expect?"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              disabled={loading}
            />
          </div>
        </div>

        <div className="w-full rounded-lg border border-border bg-muted/40 px-4 py-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">
            What will be sent
          </p>
          <ul className="text-sm text-muted-foreground space-y-1">
            <li>Chat history and agent events</li>
            <li>Agent telemetry and run logs</li>
            <li>Network request logs</li>
            <li>Run context and environment</li>
            <li>Agent configuration</li>
            <li>Connected services (no credentials)</li>
          </ul>
        </div>

        <Button
          className="w-full"
          onClick={onSubmit}
          disabled={loading || !canSubmit}
        >
          {loading ? (
            <IconLoader2 size={16} className="animate-spin mr-2" />
          ) : null}
          {loading ? "Sending..." : "Send Report"}
        </Button>
      </div>
    </div>
  );
}

function SuccessCard({ reference }: { reference: string }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-6 rounded-[20px] border border-border bg-background px-8 py-10">
        <IconCheck size={40} className="text-green-600 opacity-70" />
        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Report sent
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Your error report has been sent to the developer team. They will
            investigate and follow up.
          </p>
        </div>
        <code className="text-xs text-muted-foreground">
          Reference: {reference}
        </code>
      </div>
    </div>
  );
}

function ErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[500px] max-w-[calc(100vw-96px)] flex-col items-center gap-6 rounded-[20px] border border-border bg-background px-8 py-10">
        <IconX size={40} className="text-destructive opacity-70" />
        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            Error
          </p>
          <p className="text-center text-sm text-muted-foreground">{message}</p>
        </div>
        {onRetry && (
          <Button className="w-full" onClick={onRetry}>
            Try Again
          </Button>
        )}
      </div>
    </div>
  );
}
