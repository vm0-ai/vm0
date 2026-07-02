import { useEffect, useState, type ReactNode } from "react";
import {
  IconActivityHeartbeat,
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconHistory,
  IconMaximize,
  IconPhoto,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { DesktopComputerUseState } from "../../computer-use-types";
import {
  refreshComputerUse$,
  setKeepAwakeEnabled$,
  startComputerUse$,
  stopComputerUse$,
} from "../computer-use-state";
import {
  CheckboxRow,
  IconButton,
  KeyValueList,
  Panel,
  RECOVERY_PHASE_LABELS,
  StatusBadge,
} from "../components";
import {
  formatDuration,
  formatJson,
  formatRecoveryDelay,
  formatTimestamp,
} from "../format";
import { RuntimeErrorDetailsModal } from "../modals";
import {
  jsonDisplayValue,
  recordStringValue,
  resultSummaryRecord,
  screenshotMeta,
} from "./json";

type CommandLogEntry =
  DesktopComputerUseState["host"]["localCommandLog"][number];

interface ScreenshotPreview {
  readonly src: string;
  readonly title: string;
  readonly meta: string;
}

const COMMAND_STATUS_LABELS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
} as const satisfies Record<CommandLogEntry["status"], string>;

export function RuntimePanel({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const [startLoadable, start] = useLoadableSet(startComputerUse$);
  const [stopLoadable, stop] = useLoadableSet(stopComputerUse$);
  const [refreshLoadable, refresh] = useLoadableSet(refreshComputerUse$);
  const [keepAwakeLoadable, setKeepAwakeEnabled] =
    useLoadableSet(setKeepAwakeEnabled$);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const startDisabled =
    state.host.status === "connecting" ||
    state.host.status === "online" ||
    state.host.status === "recovering" ||
    startLoadable.state === "loading";
  const stopDisabled =
    (state.host.status !== "online" && state.host.status !== "recovering") ||
    stopLoadable.state === "loading";
  const hasErrorDetails =
    (state.host.status === "error" || state.host.status === "recovering") &&
    (state.host.lastError !== null || state.host.errorLog.length > 0);

  return (
    <Panel title="Runtime" icon={<IconActivityHeartbeat size={18} />}>
      <div className="runtime-grid">
        <div>
          <span>Status</span>
          <strong className="runtime-status-value">
            <StatusBadge status={state.host.status} />
            {hasErrorDetails && (
              <button
                type="button"
                className="status-error-button"
                aria-label="Show error details"
                title="Show error details"
                onClick={() => {
                  setErrorDetailsOpen(true);
                }}
              >
                <IconAlertCircle size={15} />
              </button>
            )}
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
      {state.host.recovery && <RuntimeRecoveryAlert state={state} />}
      <CheckboxRow
        title="Keep Mac awake"
        subtitle="Prevents automatic system sleep and display sleep."
        meta={state.keepAwake.active ? "Active" : "Off"}
        checked={state.keepAwake.enabled}
        disabled={keepAwakeLoadable.state === "loading"}
        onChange={(enabled) => {
          void setKeepAwakeEnabled(enabled);
        }}
      />
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
          tone="danger"
          icon={<IconPlayerStop size={15} />}
          onClick={() => {
            void stop();
          }}
          disabled={stopDisabled}
        >
          Stop
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
      </div>
      {errorDetailsOpen && hasErrorDetails && (
        <RuntimeErrorDetailsModal
          state={state}
          onClose={() => {
            setErrorDetailsOpen(false);
          }}
        />
      )}
    </Panel>
  );
}

function RuntimeRecoveryAlert({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const recovery = state.host.recovery;
  if (!recovery) {
    return null;
  }
  return (
    <div className="inline-alert">
      <IconRefresh size={16} />
      <span>
        {`${RECOVERY_PHASE_LABELS[recovery.phase]} retry attempt ${
          recovery.attempt
        }; next retry in ${formatRecoveryDelay(recovery.retryDelayMs)}.`}
      </span>
    </div>
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
  const resultAppState = recordStringValue(entry.result, "appState");
  const screenshot = recordStringValue(entry.result, "screenshot");
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
          {resultAppState && (
            <CommandLogSection title="App State" icon={<IconCode size={15} />}>
              <pre className="agent-state-block">{resultAppState}</pre>
            </CommandLogSection>
          )}
          {screenshot && (
            <ScreenshotBlock
              entry={entry}
              screenshot={screenshot}
              onPreview={onPreviewScreenshot}
            />
          )}
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

export function CommandLogPanel({
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
