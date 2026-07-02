import { useEffect } from "react";
import { IconX } from "@tabler/icons-react";
import type { DesktopComputerUseState } from "../../computer-use-types";
import {
  KeyValueList,
  RECOVERY_PHASE_LABELS,
  STATUS_LABELS,
} from "../components";
import { formatJson, formatTimestamp } from "../format";

type RuntimeErrorEntry = DesktopComputerUseState["host"]["errorLog"][number];

const RUNTIME_ERROR_SOURCE_LABELS = {
  start: "Start",
  stop: "Stop",
  heartbeat: "Heartbeat",
  command_poll: "Command poll",
} as const satisfies Record<RuntimeErrorEntry["source"], string>;

export function RuntimeErrorDetailsModal({
  onClose,
  state,
}: {
  readonly onClose: () => void;
  readonly state: DesktopComputerUseState;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const latestError =
    state.host.lastError ?? state.host.errorLog[0]?.message ?? "Unknown error";
  const rawDiagnostics = {
    status: state.host.status,
    hostId: state.host.hostId,
    lastHeartbeatAt: state.host.lastHeartbeatAt,
    lastCommandAt: state.host.lastCommandAt,
    lastError: state.host.lastError,
    recovery: state.host.recovery,
    errorLog: state.host.errorLog,
  };

  return (
    <div className="runtime-error-modal" role="presentation" onClick={onClose}>
      <div
        className="runtime-error-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Error details"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="runtime-error-header">
          <div>
            <strong>Error details</strong>
            <span>Local Computer Use runtime logs</span>
          </div>
          <button
            type="button"
            className="icon-only-button"
            aria-label="Close error details"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="runtime-error-body">
          <section className="runtime-error-section">
            <h3>Summary</h3>
            <KeyValueList
              emptyLabel="No runtime summary available."
              value={{
                Status: STATUS_LABELS[state.host.status],
                "Host ID": state.host.hostId ?? "Not registered",
                "Last heartbeat": formatTimestamp(state.host.lastHeartbeatAt),
                "Last command": formatTimestamp(state.host.lastCommandAt),
                Recovery: state.host.recovery
                  ? `${RECOVERY_PHASE_LABELS[state.host.recovery.phase]} attempt ${
                      state.host.recovery.attempt
                    }`
                  : "None",
                "Captured errors": state.host.errorLog.length,
              }}
            />
          </section>
          <section className="runtime-error-section">
            <h3>Latest error</h3>
            <div className="runtime-error-message">{latestError}</div>
          </section>
          <section className="runtime-error-section">
            <h3>Recent error log</h3>
            {state.host.errorLog.length === 0 ? (
              <div className="compact-empty">
                No local error log entries were captured.
              </div>
            ) : (
              <div className="runtime-error-log-list">
                {state.host.errorLog.map((entry) => {
                  return <RuntimeErrorLogRow key={entry.id} entry={entry} />;
                })}
              </div>
            )}
          </section>
          <details className="raw-log-details">
            <summary>Raw diagnostics</summary>
            <pre className="json-block">{formatJson(rawDiagnostics)}</pre>
          </details>
        </div>
      </div>
    </div>
  );
}

function RuntimeErrorLogRow({ entry }: { readonly entry: RuntimeErrorEntry }) {
  return (
    <div className="runtime-error-log-row">
      <div>
        <strong>{RUNTIME_ERROR_SOURCE_LABELS[entry.source]}</strong>
        <span>
          {formatTimestamp(entry.occurredAt)} - {entry.hostId ?? "No host id"}
        </span>
      </div>
      <p>{entry.message}</p>
    </div>
  );
}
