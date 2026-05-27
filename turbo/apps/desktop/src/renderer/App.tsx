import { useEffect, useState, type ReactNode } from "react";
import {
  IconActivityHeartbeat,
  IconAlertCircle,
  IconBuilding,
  IconChevronDown,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconExternalLink,
  IconHistory,
  IconMaximize,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconShieldCheck,
  IconUserCircle,
  IconX,
} from "@tabler/icons-react";
import { useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { DesktopAuthState } from "../desktop-bridge";
import type { DesktopComputerUseState } from "../computer-use-types";
import {
  computerUseData$,
  desktopAuthData$,
  hasDesktopAuthBridge,
  hasDesktopComputerUseBridge,
  maybeAutoStartComputerUse$,
  openAccessibilitySettings$,
  openDesktopOrgSelection$,
  openDesktopSignIn$,
  openScreenRecordingSettings$,
  refreshComputerUse$,
  requestAccessibilityPermission$,
  requestScreenRecordingPermission$,
  setupComputerUseBridge$,
  startComputerUse$,
} from "./computer-use-state";

type HostStatus = DesktopComputerUseState["host"]["status"];
type CommandLogEntry =
  DesktopComputerUseState["host"]["localCommandLog"][number];

interface ScreenshotPreview {
  readonly src: string;
  readonly title: string;
  readonly meta: string;
}

const STATUS_LABELS = {
  idle: "Idle",
  connecting: "Connecting",
  online: "Online",
  unauthenticated: "Signed out",
  needs_organization: "Select workspace",
  disabled: "Disabled",
  error: "Error",
} as const satisfies Record<HostStatus, string>;

const COMMAND_STATUS_LABELS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
} as const satisfies Record<CommandLogEntry["status"], string>;

const RESULT_SUMMARY_KEYS_TO_SKIP = new Set([
  "elements",
  "screenshot",
  "text",
  "visibleElements",
]);
const RESULT_TEXT_PREVIEW_LABEL = "[shown in App State]";

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

function formatDuration(value: number | null): string {
  if (value === null) {
    return "In progress";
  }
  if (value < 1_000) {
    return `${value} ms`;
  }
  return `${(value / 1_000).toFixed(1)} s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordStringValue(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordNumberValue(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return formatJson(value);
}

function visibleElementRecords(
  result: Record<string, unknown> | null,
): readonly Record<string, unknown>[] {
  const value = result?.visibleElements;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function jsonDisplayRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      key === "screenshot" &&
      typeof entry === "string" &&
      entry.startsWith("data:image/")
    ) {
      next[key] = `[image data URL, ${entry.length} characters]`;
    } else {
      next[key] = jsonDisplayValue(entry);
    }
  }
  return next;
}

function jsonDisplayValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      return jsonDisplayValue(entry);
    });
  }
  if (isRecord(value)) {
    return jsonDisplayRecord(value);
  }
  return value;
}

function resultSummaryRecord(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (!RESULT_SUMMARY_KEYS_TO_SKIP.has(key)) {
      summary[key] = jsonDisplayValue(value);
    }
  }
  if (recordStringValue(result, "text")) {
    summary.text = RESULT_TEXT_PREVIEW_LABEL;
  }
  if (recordStringValue(result, "screenshot")) {
    summary.screenshot = "[shown as image]";
  }
  const elements = result.elements;
  if (Array.isArray(elements)) {
    summary.elements = `${elements.length} elements`;
  }
  const visibleElements = result.visibleElements;
  if (Array.isArray(visibleElements)) {
    summary.visibleElements = `${visibleElements.length} visible elements`;
  }
  return summary;
}

function screenshotMeta(result: Record<string, unknown> | null): string {
  const sourceName = recordStringValue(result, "screenshotSourceName");
  const width = recordNumberValue(result, "screenshotWidth");
  const height = recordNumberValue(result, "screenshotHeight");
  const dimensions =
    width !== null && height !== null ? `${width}x${height}` : null;
  return [sourceName, dimensions].filter(Boolean).join(" - ");
}

function KeyValueList({
  emptyLabel,
  value,
}: {
  readonly emptyLabel: string;
  readonly value: Record<string, unknown>;
}) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return <div className="compact-empty">{emptyLabel}</div>;
  }
  return (
    <dl className="key-value-list">
      {entries.map(([key, entry]) => {
        return (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{previewValue(entry)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function PermissionsPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const [requestLoadable, requestPermission] = useLoadableSet(
    requestAccessibilityPermission$,
  );
  const [screenRecordingRequestLoadable, requestScreenRecording] =
    useLoadableSet(requestScreenRecordingPermission$);
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
              <>
                <IconButton
                  icon={<IconShieldCheck size={15} />}
                  onClick={() => {
                    void requestScreenRecording();
                  }}
                  disabled={screenRecordingRequestLoadable.state === "loading"}
                >
                  Request
                </IconButton>
                <IconButton
                  icon={<IconExternalLink size={15} />}
                  onClick={() => {
                    void openScreenRecording();
                  }}
                >
                  Settings
                </IconButton>
              </>
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
  const [orgSelectionLoadable, selectOrg] = useLoadableSet(
    openDesktopOrgSelection$,
  );
  const missingPermissions =
    !state.permissions.accessibility || !state.permissions.screenRecording;
  const startDisabled =
    missingPermissions ||
    state.host.status === "connecting" ||
    state.host.status === "online" ||
    state.host.status === "needs_organization" ||
    startLoadable.state === "loading";

  return (
    <Panel title="Runtime" icon={<IconActivityHeartbeat size={18} />}>
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
        {state.host.status === "needs_organization" &&
          hasDesktopAuthBridge() && (
            <IconButton
              icon={<IconBuilding size={15} />}
              onClick={() => {
                void selectOrg();
              }}
              disabled={orgSelectionLoadable.state === "loading"}
            >
              Select workspace
            </IconButton>
          )}
      </div>
    </Panel>
  );
}

function CommandStatusBadge({
  status,
}: {
  readonly status: CommandLogEntry["status"];
}) {
  return (
    <span className={`command-status command-status-${status}`}>
      {COMMAND_STATUS_LABELS[status]}
    </span>
  );
}

function CommandLogSection({
  children,
  collapsible = false,
  icon,
  title,
}: {
  readonly children: ReactNode;
  readonly collapsible?: boolean;
  readonly icon: ReactNode;
  readonly title: string;
}) {
  const titleContent = (
    <>
      {collapsible && (
        <span className="command-log-section-disclosure">
          <IconChevronRight size={14} />
        </span>
      )}
      {icon}
      <h3>{title}</h3>
    </>
  );

  if (collapsible) {
    return (
      <details className="command-log-section command-log-section-details">
        <summary className="command-log-section-title">{titleContent}</summary>
        {children}
      </details>
    );
  }

  return (
    <section className="command-log-section">
      <div className="command-log-section-title">{titleContent}</div>
      {children}
    </section>
  );
}

function VisibleElements({
  elements,
}: {
  readonly elements: readonly Record<string, unknown>[];
}) {
  if (elements.length === 0) {
    return null;
  }
  const preview = elements.slice(0, 8);
  return (
    <CommandLogSection title="Visible Elements" icon={<IconCode size={15} />}>
      <div className="visible-elements-list">
        {preview.map((element, index) => {
          const label =
            recordStringValue(element, "text") ??
            recordStringValue(element, "elementId") ??
            `Element ${index + 1}`;
          const elementIndex = recordNumberValue(element, "elementIndex");
          const role = recordStringValue(element, "role");
          const meta = [
            elementIndex !== null ? `#${elementIndex.toString()}` : null,
            role,
          ]
            .filter((value): value is string => {
              return value !== null;
            })
            .join(" - ");
          return (
            <div
              className="visible-element-row"
              key={`${label}-${index.toString()}`}
            >
              <span>{label}</span>
              {meta && <code>{meta}</code>}
            </div>
          );
        })}
      </div>
      {elements.length > preview.length && (
        <div className="compact-empty">
          {elements.length - preview.length} more elements in raw result
        </div>
      )}
    </CommandLogSection>
  );
}

function ScreenshotBlock({
  entry,
  onPreview,
  screenshot,
}: {
  readonly entry: CommandLogEntry;
  readonly onPreview: (preview: ScreenshotPreview) => void;
  readonly screenshot: string;
}) {
  const meta = screenshotMeta(entry.result);
  return (
    <CommandLogSection title="Screenshot" icon={<IconPhoto size={15} />}>
      <button
        type="button"
        className="screenshot-thumbnail"
        onClick={() => {
          onPreview({
            src: screenshot,
            title: `${entry.kind} screenshot`,
            meta,
          });
        }}
      >
        <img src={screenshot} alt={`${entry.kind} screenshot`} />
        <span>
          <IconMaximize size={14} />
          Open
        </span>
      </button>
      {meta && <div className="row-meta">{meta}</div>}
    </CommandLogSection>
  );
}

function CommandLogRow({
  entry,
  expanded,
  onPreviewScreenshot,
  onToggle,
}: {
  readonly entry: CommandLogEntry;
  readonly expanded: boolean;
  readonly onPreviewScreenshot: (preview: ScreenshotPreview) => void;
  readonly onToggle: () => void;
}) {
  const resultText = recordStringValue(entry.result, "text");
  const screenshot = recordStringValue(entry.result, "screenshot");
  const visibleElements = visibleElementRecords(entry.result);
  const completedAt = entry.completedAt ?? entry.startedAt;
  return (
    <article className="command-log-row">
      <button
        type="button"
        className="command-log-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="command-log-chevron">
          {expanded ? (
            <IconChevronDown size={16} />
          ) : (
            <IconChevronRight size={16} />
          )}
        </span>
        <span className="command-log-main">
          <span className="row-title">{entry.kind}</span>
          <span className="row-meta">
            {entry.app ?? "No target app"} - {formatTimestamp(completedAt)} -{" "}
            {formatDuration(entry.durationMs)}
          </span>
        </span>
        <CommandStatusBadge status={entry.status} />
      </button>
      {expanded && (
        <div className="command-log-details">
          <CommandLogSection title="Parameters" icon={<IconCode size={15} />}>
            <KeyValueList
              value={entry.payload}
              emptyLabel="No parameters were sent."
            />
          </CommandLogSection>
          {entry.error && (
            <CommandLogSection
              title="Error"
              icon={<IconAlertCircle size={15} />}
            >
              <pre className="json-block">{formatJson(entry.error)}</pre>
            </CommandLogSection>
          )}
          {entry.result && (
            <CommandLogSection
              title="Result"
              icon={<IconCheck size={15} />}
              collapsible
            >
              <KeyValueList
                value={resultSummaryRecord(entry.result)}
                emptyLabel="No result fields were returned."
              />
            </CommandLogSection>
          )}
          {resultText && (
            <CommandLogSection title="App State" icon={<IconCode size={15} />}>
              <pre className="agent-state-block">{resultText}</pre>
            </CommandLogSection>
          )}
          {screenshot && (
            <ScreenshotBlock
              entry={entry}
              screenshot={screenshot}
              onPreview={onPreviewScreenshot}
            />
          )}
          <VisibleElements elements={visibleElements} />
          <details className="raw-log-details">
            <summary>Raw Log Entry</summary>
            <pre className="json-block">
              {formatJson(jsonDisplayValue(entry))}
            </pre>
          </details>
        </div>
      )}
    </article>
  );
}

function ScreenshotLightbox({
  onClose,
  preview,
}: {
  readonly onClose: () => void;
  readonly preview: ScreenshotPreview | null;
}) {
  useEffect(() => {
    if (!preview) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, preview]);

  if (!preview) {
    return null;
  }

  return (
    <div className="screenshot-lightbox" role="presentation" onClick={onClose}>
      <div
        className="screenshot-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={preview.title}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="screenshot-lightbox-header">
          <div>
            <strong>{preview.title}</strong>
            {preview.meta && <span>{preview.meta}</span>}
          </div>
          <button type="button" className="icon-only-button" onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>
        <img src={preview.src} alt={preview.title} />
      </div>
    </div>
  );
}

function CommandLogPanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const entries = state.host.localCommandLog;
  const [expandedCommandIds, setExpandedCommandIds] = useState<
    readonly string[]
  >([]);
  const [screenshotPreview, setScreenshotPreview] =
    useState<ScreenshotPreview | null>(null);
  const toggleCommand = (commandId: string) => {
    setExpandedCommandIds((current) => {
      if (current.includes(commandId)) {
        return current.filter((candidate) => {
          return candidate !== commandId;
        });
      }
      return [commandId, ...current];
    });
  };

  return (
    <Panel title="Command Log" icon={<IconHistory size={18} />}>
      {entries.length === 0 ? (
        <div className="empty-state">No local native commands have run.</div>
      ) : (
        <div className="command-log-list">
          {entries.map((entry) => {
            return (
              <CommandLogRow
                key={entry.commandId}
                entry={entry}
                expanded={expandedCommandIds.includes(entry.commandId)}
                onPreviewScreenshot={setScreenshotPreview}
                onToggle={() => {
                  toggleCommand(entry.commandId);
                }}
              />
            );
          })}
        </div>
      )}
      <ScreenshotLightbox
        preview={screenshotPreview}
        onClose={() => {
          setScreenshotPreview(null);
        }}
      />
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
      {!state.supported ? (
        <UnsupportedPanel platform={state.platform} />
      ) : (
        <>
          <PermissionsPanel state={state} />
          <RuntimePanel state={state} />
          <CommandLogPanel state={state} />
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

function AccountMenu({
  authState,
  loading,
  onSelectOrg,
  onSignIn,
  orgSelectionLoading,
  signInLoading,
}: {
  readonly authState: DesktopAuthState | null;
  readonly loading: boolean;
  readonly onSelectOrg: () => void;
  readonly onSignIn: () => void;
  readonly orgSelectionLoading: boolean;
  readonly signInLoading: boolean;
}) {
  if (!authState || authState.status === "signed_out") {
    return (
      <IconButton
        icon={<IconExternalLink size={15} />}
        onClick={onSignIn}
        disabled={loading || signInLoading}
      >
        {loading ? "Checking" : "Sign in"}
      </IconButton>
    );
  }

  const workspaceLabel = authState.organization?.name ?? "Select workspace";

  return (
    <details className="account-menu">
      <summary className="account-summary">
        <IconUserCircle size={17} />
        <span className="account-copy">
          <span className="account-email">{authState.user.email}</span>
        </span>
        <IconChevronDown size={14} />
      </summary>
      <div className="account-popover">
        <div className="account-popover-heading">
          <span>Signed in as</span>
          <strong>{authState.user.email}</strong>
        </div>
        <div className="account-popover-heading">
          <span>Workspace</span>
          <strong>{workspaceLabel}</strong>
        </div>
        <button
          type="button"
          className="account-menu-item"
          onClick={onSelectOrg}
          disabled={orgSelectionLoading}
        >
          <IconBuilding size={15} />
          <span>
            {authState.organization ? "Switch workspace" : "Select workspace"}
          </span>
        </button>
        <button
          type="button"
          className="account-menu-item"
          onClick={onSignIn}
          disabled={signInLoading}
        >
          <IconExternalLink size={15} />
          <span>Sign in again</span>
        </button>
      </div>
    </details>
  );
}

function Header() {
  const authLoadable = useLastLoadable(desktopAuthData$);
  const [signInLoadable, signIn] = useLoadableSet(openDesktopSignIn$);
  const [orgSelectionLoadable, selectOrg] = useLoadableSet(
    openDesktopOrgSelection$,
  );
  const authState = authLoadable.state === "hasData" ? authLoadable.data : null;
  const authLoading = authLoadable.state === "loading";
  return (
    <header className="app-header">
      <div className="titlebar-title">
        <h1>Zero Computer Use</h1>
      </div>
      <div className="header-actions">
        {hasDesktopAuthBridge() && (
          <AccountMenu
            authState={authState}
            loading={authLoading}
            onSignIn={() => {
              void signIn();
            }}
            onSelectOrg={() => {
              void selectOrg();
            }}
            orgSelectionLoading={orgSelectionLoadable.state === "loading"}
            signInLoading={signInLoadable.state === "loading"}
          />
        )}
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
