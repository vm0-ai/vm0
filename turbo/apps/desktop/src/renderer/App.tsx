import { useEffect, type ReactNode } from "react";
import {
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconHistory,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "../computer-use-types";
import {
  computerUseData$,
  decideComputerUseCommand$,
  hasDesktopAuthBridge,
  hasDesktopComputerUseBridge,
  maybeAutoStartComputerUse$,
  openAccessibilitySettings$,
  openDesktopSignIn$,
  openScreenRecordingSettings$,
  refreshComputerUse$,
  requestAccessibilityPermission$,
  setupComputerUseBridge$,
  startComputerUse$,
} from "./computer-use-state";

type HostStatus = DesktopComputerUseState["host"]["status"];

const STATUS_LABELS = {
  idle: "Idle",
  connecting: "Connecting",
  online: "Online",
  unauthenticated: "Signed out",
  disabled: "Disabled",
  error: "Error",
} as const satisfies Record<HostStatus, string>;

function BridgeSubscription() {
  const setupBridge = useSet(setupComputerUseBridge$);
  useEffect(() => {
    if (!hasDesktopComputerUseBridge()) {
      return undefined;
    }
    const controller = new AbortController();
    setupBridge(controller.signal);
    return () => {
      controller.abort();
    };
  }, [setupBridge]);
  return null;
}

function AutoStartRuntime({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const maybeAutoStart = useSet(maybeAutoStartComputerUse$);
  useEffect(() => {
    void maybeAutoStart(state);
  }, [maybeAutoStart, state]);
  return null;
}

function IconButton({
  children,
  disabled,
  icon,
  onClick,
  tone = "secondary",
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly onClick: () => void;
  readonly tone?: "primary" | "secondary" | "danger";
}) {
  return (
    <button
      type="button"
      className={`button button-${tone}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function Panel({
  children,
  title,
  icon,
}: {
  readonly children: ReactNode;
  readonly title: string;
  readonly icon?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        {icon}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function StatusBadge({ status }: { readonly status: HostStatus }) {
  return (
    <span className={`status-badge status-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function PermissionsPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const [requestLoadable, requestPermission] = useLoadableSet(
    requestAccessibilityPermission$,
  );
  const [, openAccessibility] = useLoadableSet(openAccessibilitySettings$);
  const [, openScreenRecording] = useLoadableSet(openScreenRecordingSettings$);
  const accessibilityGranted = state.permissions.accessibility;
  const screenRecordingGranted = state.permissions.screenRecording;

  return (
    <Panel title="Permissions" icon={<IconShieldCheck size={18} />}>
      <div className="permission-list">
        <div className="permission-row">
          <div>
            <div className="row-title">Accessibility</div>
            <div className="row-meta">
              {accessibilityGranted ? "Granted" : "Required for UI control"}
            </div>
          </div>
          <div className="row-actions">
            {accessibilityGranted ? (
              <span className="check-pill">
                <IconCheck size={14} />
                Ready
              </span>
            ) : (
              <>
                <IconButton
                  icon={<IconShieldCheck size={15} />}
                  onClick={() => {
                    void requestPermission();
                  }}
                  disabled={requestLoadable.state === "loading"}
                >
                  Request
                </IconButton>
                <IconButton
                  icon={<IconExternalLink size={15} />}
                  onClick={() => {
                    void openAccessibility();
                  }}
                >
                  Settings
                </IconButton>
              </>
            )}
          </div>
        </div>
        <div className="permission-row">
          <div>
            <div className="row-title">Screen Recording</div>
            <div className="row-meta">
              {screenRecordingGranted ? "Granted" : "Required for screenshots"}
            </div>
          </div>
          <div className="row-actions">
            {screenRecordingGranted ? (
              <span className="check-pill">
                <IconCheck size={14} />
                Ready
              </span>
            ) : (
              <IconButton
                icon={<IconExternalLink size={15} />}
                onClick={() => {
                  void openScreenRecording();
                }}
              >
                Settings
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function RuntimePanel({ state }: { readonly state: DesktopComputerUseState }) {
  const [startLoadable, start] = useLoadableSet(startComputerUse$);
  const [refreshLoadable, refresh] = useLoadableSet(refreshComputerUse$);
  const [signInLoadable, signIn] = useLoadableSet(openDesktopSignIn$);
  const missingPermissions =
    !state.permissions.accessibility || !state.permissions.screenRecording;
  const startDisabled =
    missingPermissions ||
    state.host.status === "connecting" ||
    state.host.status === "online" ||
    startLoadable.state === "loading";

  return (
    <Panel title="Runtime">
      <div className="runtime-grid">
        <div>
          <span>Status</span>
          <strong>
            <StatusBadge status={state.host.status} />
          </strong>
        </div>
        <div>
          <span>Host ID</span>
          <strong>{state.host.hostId ?? "Not registered"}</strong>
        </div>
        <div>
          <span>Last heartbeat</span>
          <strong>{formatTimestamp(state.host.lastHeartbeatAt)}</strong>
        </div>
        <div>
          <span>Last command</span>
          <strong>{formatTimestamp(state.host.lastCommandAt)}</strong>
        </div>
      </div>
      {state.host.lastError && (
        <div className="inline-alert">
          <IconAlertCircle size={16} />
          <span>{state.host.lastError}</span>
        </div>
      )}
      <div className="panel-actions">
        <IconButton
          tone="primary"
          icon={<IconPlayerPlay size={15} />}
          onClick={() => {
            void start();
          }}
          disabled={startDisabled}
        >
          Start
        </IconButton>
        <IconButton
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void refresh();
          }}
          disabled={refreshLoadable.state === "loading"}
        >
          Refresh
        </IconButton>
        {state.host.status === "unauthenticated" && hasDesktopAuthBridge() && (
          <IconButton
            icon={<IconExternalLink size={15} />}
            onClick={() => {
              void signIn();
            }}
            disabled={signInLoadable.state === "loading"}
          >
            Sign in
          </IconButton>
        )}
      </div>
    </Panel>
  );
}

function PendingApprovalRow({
  action,
}: {
  readonly action: DesktopComputerUseState["host"]["pendingApprovals"][number];
}) {
  const [decisionLoadable, decide] = useLoadableSet(decideComputerUseCommand$);
  const disabled = decisionLoadable.state === "loading";
  const decideWith = (decision: ComputerUseApprovalAction["decision"]) => {
    void decide({ commandId: action.commandId, decision });
  };

  return (
    <div className="approval-row">
      <div>
        <div className="row-title">{action.kind}</div>
        <div className="row-meta">
          {action.app ?? "No target app"} - {formatTimestamp(action.createdAt)}
        </div>
      </div>
      <div className="row-actions">
        <IconButton
          tone="primary"
          icon={<IconCheck size={15} />}
          onClick={() => {
            decideWith("approve");
          }}
          disabled={disabled}
        >
          Approve
        </IconButton>
        <IconButton
          tone="danger"
          icon={<IconX size={15} />}
          onClick={() => {
            decideWith("deny");
          }}
          disabled={disabled}
        >
          Deny
        </IconButton>
      </div>
    </div>
  );
}

function PendingApprovalsPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const approvals = state.host.pendingApprovals;
  return (
    <Panel title="Pending Approvals" icon={<IconClock size={18} />}>
      {approvals.length === 0 ? (
        <div className="empty-state">No commands are waiting.</div>
      ) : (
        <div className="approval-list">
          {approvals.map((action) => {
            return (
              <PendingApprovalRow key={action.commandId} action={action} />
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function HistoryPanel({ state }: { readonly state: DesktopComputerUseState }) {
  const events = state.host.recentAuditEvents;
  return (
    <Panel title="Recent History" icon={<IconHistory size={18} />}>
      {events.length === 0 ? (
        <div className="empty-state">No recent command events.</div>
      ) : (
        <div className="history-list">
          {events.map((event) => {
            return (
              <div
                className="history-row"
                key={`${event.commandId}-${event.event}-${event.createdAt}`}
              >
                <div>
                  <div className="row-title">
                    {event.kind} - {event.event}
                  </div>
                  <div className="row-meta">
                    {event.app ?? "No target app"} -{" "}
                    {formatTimestamp(event.createdAt)}
                  </div>
                </div>
                {event.approvalOutcome && (
                  <span className={`outcome outcome-${event.approvalOutcome}`}>
                    {event.approvalOutcome}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function UnsupportedPanel({ platform }: { readonly platform: string }) {
  return (
    <Panel title="Unsupported Platform" icon={<IconAlertCircle size={18} />}>
      <div className="empty-state">
        Computer Use is available on macOS. Current platform: {platform}.
      </div>
    </Panel>
  );
}

function ComputerUseContent({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  return (
    <>
      <AutoStartRuntime state={state} />
      <div className="summary-bar">
        <div>
          <span>Platform</span>
          <strong>{state.platform}</strong>
        </div>
        <div>
          <span>Accessibility</span>
          <strong>
            {state.permissions.accessibility ? "Granted" : "Missing"}
          </strong>
        </div>
        <div>
          <span>Screen Recording</span>
          <strong>
            {state.permissions.screenRecording ? "Granted" : "Missing"}
          </strong>
        </div>
      </div>
      {!state.supported ? (
        <UnsupportedPanel platform={state.platform} />
      ) : (
        <>
          <PermissionsPanel state={state} />
          <RuntimePanel state={state} />
          <PendingApprovalsPanel state={state} />
          <HistoryPanel state={state} />
        </>
      )}
    </>
  );
}

function ComputerUsePage() {
  const loadable = useLastLoadable(computerUseData$);

  if (!hasDesktopComputerUseBridge()) {
    return (
      <Panel title="Desktop Bridge" icon={<IconAlertCircle size={18} />}>
        <div className="empty-state">Desktop bridge unavailable.</div>
      </Panel>
    );
  }

  if (loadable.state === "hasData") {
    return <ComputerUseContent state={loadable.data} />;
  }

  if (loadable.state === "hasError") {
    return (
      <Panel title="Computer Use" icon={<IconAlertCircle size={18} />}>
        <div className="inline-alert">
          <IconAlertCircle size={16} />
          <span>
            {loadable.error instanceof Error
              ? loadable.error.message
              : String(loadable.error)}
          </span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Computer Use">
      <div className="empty-state">Loading...</div>
    </Panel>
  );
}

function Header() {
  const [signInLoadable, signIn] = useLoadableSet(openDesktopSignIn$);
  const [refreshLoadable, refresh] = useLoadableSet(refreshComputerUse$);
  return (
    <header className="app-header">
      <div>
        <p className="eyebrow">Zero Desktop</p>
        <h1>Computer Use</h1>
      </div>
      <div className="header-actions">
        {hasDesktopAuthBridge() && (
          <IconButton
            icon={<IconExternalLink size={15} />}
            onClick={() => {
              void signIn();
            }}
            disabled={signInLoadable.state === "loading"}
          >
            Sign in
          </IconButton>
        )}
        <IconButton
          icon={<IconRefresh size={15} />}
          onClick={() => {
            void refresh();
          }}
          disabled={refreshLoadable.state === "loading"}
        >
          Refresh
        </IconButton>
      </div>
    </header>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <BridgeSubscription />
      <Header />
      <main className="content">
        <ComputerUsePage />
      </main>
    </div>
  );
}
