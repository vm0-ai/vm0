import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconAlertCircle,
  IconCircleCheck,
  IconDeviceDesktop,
  IconExternalLink,
  IconLoader2,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  decideDesktopComputerUseCommand$,
  desktopComputerUseData$,
  openDesktopComputerUseAccessibilitySettings$,
  openDesktopComputerUseScreenRecordingSettings$,
  refreshDesktopComputerUse$,
  requestDesktopComputerUseAccessibilityPermission$,
  startDesktopComputerUse$,
  type DesktopComputerUseState,
} from "../../signals/desktop-computer-use-page/desktop-computer-use-signals.ts";

type PermissionKind = "accessibility" | "screenRecording";

function formatDateTime(iso: string | null): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString();
}

function statusClassName(status: string): string {
  if (status === "online" || status === "granted") {
    return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "error" || status === "missing") {
    return "bg-destructive/10 text-destructive";
  }
  if (
    status === "connecting" ||
    status === "unauthenticated" ||
    status === "disabled"
  ) {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

function StatusBadge({
  status,
  title,
}: {
  readonly status: string;
  readonly title?: string | null;
}) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-medium ${statusClassName(status)}`}
      title={title ?? undefined}
    >
      {status}
    </span>
  );
}

function PermissionPanel({
  state,
  kind,
}: {
  readonly state: DesktopComputerUseState;
  readonly kind: PermissionKind;
}) {
  const pageSignal = useGet(pageSignal$);
  const [requestLoadable, requestAccessibility] = useLoadableSet(
    requestDesktopComputerUseAccessibilityPermission$,
  );
  const [openAccessibilityLoadable, openAccessibilitySettings] = useLoadableSet(
    openDesktopComputerUseAccessibilitySettings$,
  );
  const [openScreenLoadable, openScreenSettings] = useLoadableSet(
    openDesktopComputerUseScreenRecordingSettings$,
  );
  const granted = state.permissions[kind];
  const title = kind === "accessibility" ? "Accessibility" : "Screen Recording";
  const body =
    kind === "accessibility"
      ? "Allows Zero Desktop to read macOS UI elements and execute targeted actions."
      : "Allows Zero Desktop to capture screenshots for visual app state.";
  const pending =
    requestLoadable.state === "loading" ||
    openAccessibilityLoadable.state === "loading" ||
    openScreenLoadable.state === "loading";

  return (
    <section className="zero-border bg-card rounded-xl px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {granted ? (
              <IconCircleCheck size={18} className="text-emerald-600" />
            ) : (
              <IconAlertCircle size={18} className="text-amber-600" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <StatusBadge status={granted ? "granted" : "missing"} />
            </div>
            <p className="mt-1 max-w-[620px] text-sm text-muted-foreground">
              {body}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {kind === "accessibility" ? (
            <Button
              variant={granted ? "outline" : "default"}
              size="sm"
              disabled={pending}
              onClick={() => {
                detach(requestAccessibility(pageSignal), Reason.DomCallback);
              }}
            >
              {requestLoadable.state === "loading" ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconShieldCheck size={15} />
              )}
              Request access
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              const action =
                kind === "accessibility"
                  ? openAccessibilitySettings
                  : openScreenSettings;
              detach(action(pageSignal), Reason.DomCallback);
            }}
          >
            {openAccessibilityLoadable.state === "loading" ||
            openScreenLoadable.state === "loading" ? (
              <IconLoader2 size={15} className="animate-spin" />
            ) : (
              <IconExternalLink size={15} />
            )}
            Open settings
          </Button>
        </div>
      </div>
    </section>
  );
}

function RuntimePanel({ state }: { readonly state: DesktopComputerUseState }) {
  const pageSignal = useGet(pageSignal$);
  const [startLoadable, startComputerUse] = useLoadableSet(
    startDesktopComputerUse$,
  );
  const canStart =
    state.supported &&
    (state.host.status === "idle" ||
      state.host.status === "unauthenticated" ||
      state.host.status === "error");
  const startPending =
    startLoadable.state === "loading" || state.host.status === "connecting";
  const statusCopy =
    state.host.status === "idle"
      ? "Host is not connected."
      : state.host.status === "connecting"
        ? "Connecting this desktop to the Computer Use command queue."
        : state.host.status === "online"
          ? "Host is connected and polling for Computer Use commands."
          : state.host.status === "unauthenticated"
            ? "Desktop host could not authenticate with the API session. Sign in to Zero Desktop, then retry."
            : state.host.status === "disabled"
              ? "Computer Use is disabled for this account."
              : "Host connection failed. Retry when the desktop session is available.";
  const rows = [
    ["Host", state.host.hostId ?? "-"],
    ["Last heartbeat", formatDateTime(state.host.lastHeartbeatAt)],
    ["Last command", formatDateTime(state.host.lastCommandAt)],
    ["Last error", state.host.lastError ?? "-"],
  ] as const;
  return (
    <section className="zero-border bg-card rounded-xl overflow-hidden">
      <div className="flex flex-col gap-4 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Runtime</h2>
          <p className="mt-1 max-w-[640px] text-sm text-muted-foreground">
            {statusCopy}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canStart ? (
            <Button
              size="sm"
              disabled={startPending}
              onClick={() => {
                detach(startComputerUse(pageSignal), Reason.DomCallback);
              }}
            >
              {startPending ? (
                <IconLoader2 size={15} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={15} />
              )}
              {state.host.status === "idle"
                ? "Start Computer Use"
                : "Retry connection"}
            </Button>
          ) : null}
          <StatusBadge
            status={state.host.status}
            title={state.host.lastError}
          />
        </div>
      </div>
      <dl className="grid grid-cols-1 divide-y text-sm sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        {rows.map(([label, value]) => {
          return (
            <div key={label} className="px-5 py-4">
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-1 [overflow-wrap:anywhere] text-foreground">
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function ApprovalsPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const pageSignal = useGet(pageSignal$);
  const [decisionLoadable, decideCommand] = useLoadableSet(
    decideDesktopComputerUseCommand$,
  );
  const pending = decisionLoadable.state === "loading";
  return (
    <section className="zero-border bg-card rounded-xl overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Pending approvals
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Write commands wait for a local decision before execution.
          </p>
        </div>
        <StatusBadge
          status={`${state.host.pendingApprovals.length.toString()} pending`}
        />
      </div>
      {state.host.pendingApprovals.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted-foreground">
          No pending approvals.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Command</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[170px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.host.pendingApprovals.map((approval) => {
              return (
                <TableRow key={approval.commandId}>
                  <TableCell className="font-medium">{approval.kind}</TableCell>
                  <TableCell>{approval.app ?? "-"}</TableCell>
                  <TableCell>{formatDateTime(approval.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          detach(
                            decideCommand(
                              {
                                commandId: approval.commandId,
                                decision: "deny",
                              },
                              pageSignal,
                            ),
                            Reason.DomCallback,
                          );
                        }}
                      >
                        Deny
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          detach(
                            decideCommand(
                              {
                                commandId: approval.commandId,
                                decision: "approve",
                              },
                              pageSignal,
                            ),
                            Reason.DomCallback,
                          );
                        }}
                      >
                        Approve
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function HistoryPanel({ state }: { readonly state: DesktopComputerUseState }) {
  return (
    <section className="zero-border bg-card rounded-xl overflow-hidden">
      <div className="border-b px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">
          Recent command history
        </h2>
      </div>
      {state.host.recentAuditEvents.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-muted-foreground">
          No command history.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Command</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.host.recentAuditEvents.map((event) => {
              return (
                <TableRow key={`${event.commandId}-${event.event}`}>
                  <TableCell className="font-medium">{event.kind}</TableCell>
                  <TableCell>{event.app ?? "-"}</TableCell>
                  <TableCell>
                    {event.event}
                    {event.approvalOutcome ? ` / ${event.approvalOutcome}` : ""}
                  </TableCell>
                  <TableCell>{formatDateTime(event.createdAt)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function UnsupportedPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  if (state.supported) {
    return null;
  }
  return (
    <section className="zero-border rounded-xl border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-800 dark:text-amber-200">
      Desktop Computer Use is currently implemented for macOS.
    </section>
  );
}

function DesktopComputerUseHeader() {
  const [refreshLoadable, refresh] = useLoadableSet(refreshDesktopComputerUse$);
  return (
    <header className="hidden shrink-0 bg-transparent px-4 pb-4 pt-10 md:block sm:px-6">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
            <IconDeviceDesktop size={20} stroke={1.5} />
            Computer Use
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Desktop host setup, permissions, and command approvals
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            detach(refresh(), Reason.DomCallback);
          }}
          disabled={refreshLoadable.state === "loading"}
        >
          {refreshLoadable.state === "loading" ? (
            <IconLoader2 size={16} className="animate-spin" />
          ) : (
            <IconRefresh size={16} />
          )}
          Refresh
        </Button>
      </div>
    </header>
  );
}

function DesktopComputerUsePageBody() {
  const dataLoadable = useLoadable(desktopComputerUseData$);
  return (
    <main className="shrink-0 px-4 pb-16 pt-3 sm:px-6">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
        {dataLoadable.state === "loading" ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <IconLoader2 size={20} className="animate-spin" />
          </div>
        ) : dataLoadable.state === "hasError" ? (
          <div className="zero-border bg-card rounded-xl px-6 py-10 text-center text-sm text-destructive">
            Failed to load Computer Use.
          </div>
        ) : (
          <>
            <UnsupportedPanel state={dataLoadable.data} />
            <div className="grid gap-4 lg:grid-cols-2">
              <PermissionPanel state={dataLoadable.data} kind="accessibility" />
              <PermissionPanel
                state={dataLoadable.data}
                kind="screenRecording"
              />
            </div>
            <RuntimePanel state={dataLoadable.data} />
            <ApprovalsPanel state={dataLoadable.data} />
            <HistoryPanel state={dataLoadable.data} />
          </>
        )}
      </div>
    </main>
  );
}

export function ZeroDesktopComputerUsePage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <DesktopComputerUseHeader />
      <DesktopComputerUsePageBody />
    </div>
  );
}
