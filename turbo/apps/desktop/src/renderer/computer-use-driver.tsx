import { useLoadableSet } from "ccstate-react/experimental";
import { Play, RefreshCw, Square } from "lucide-react";
import type { DesktopComputerUseDriverState } from "../computer-use-types";
import {
  selectComputerUseDriver$,
  startComputerUse$,
  stopComputerUse$,
} from "./computer-use-state";
import { IconButton, Panel } from "./components";
import { detach, Reason } from "./async-action";

export function ComputerUseDriverControls({
  developerToolsEnabled,
  state,
}: {
  readonly developerToolsEnabled: boolean;
  readonly state: DesktopComputerUseDriverState;
}) {
  const [selection, select] = useLoadableSet(selectComputerUseDriver$);
  const [retry, start] = useLoadableSet(startComputerUse$);
  const [stopping, stop] = useLoadableSet(stopComputerUse$);
  const visible =
    developerToolsEnabled && state.developerAvailability === "available";
  const needsRecovery =
    state.phase === "blocked" ||
    state.phase === "error" ||
    state.error !== null ||
    state.cleanupPending;
  if (!visible && !needsRecovery) return null;

  const busy = selection.state === "loading";
  const recovery = (
    <>
      {state.cleanupPending && (
        <p className="inline-alert" role="status">
          Cleanup is still pending. Recovery waits for the previous driver to
          exit.
        </p>
      )}
      {state.error && (
        <p className="inline-alert" role="alert">
          {state.error}
        </p>
      )}
      {selection.state === "hasError" && (
        <p className="inline-alert" role="alert">
          The selection could not be saved. Check the driver status.
        </p>
      )}
      {retry.state === "hasError" && (
        <p className="inline-alert" role="alert">
          The driver could not start. Check permissions and cleanup status.
        </p>
      )}
      <div className="panel-actions">
        {(state.phase === "starting" ||
          state.phase === "switching" ||
          state.cleanupPending) && (
          <IconButton
            icon={<Square size={15} />}
            tone="danger"
            disabled={stopping.state === "loading"}
            onClick={() => detach(stop(), Reason.DomCallback)}
          >
            Stop
          </IconButton>
        )}
        {state.phase !== "ready" && (
          <IconButton
            icon={<Play size={15} />}
            disabled={!state.canRetry || retry.state === "loading"}
            onClick={() => {
              detach(start(), Reason.DomCallback);
            }}
          >
            Retry
          </IconButton>
        )}
        {(state.selectedDriver !== "okou" || state.actual?.id === "cua") && (
          <IconButton
            icon={<RefreshCw size={15} />}
            disabled={busy}
            onClick={() => {
              detach(select("okou"), Reason.DomCallback);
            }}
          >
            Use Okou
          </IconButton>
        )}
      </div>
    </>
  );

  if (!visible) {
    // Account authorization can hide tools while CUA is blocked. Keep explicit
    // recovery in the normal page without exposing the selector or diagnostics.
    return <div aria-label="Computer Use recovery">{recovery}</div>;
  }

  return (
    <Panel title="Computer Use driver">
      <label className="driver-choice">
        <span>Driver</span>
        <select
          aria-label="Computer Use driver"
          value={state.selectedDriver}
          disabled={busy || state.phase === "switching"}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "okou" || value === "cua")
              detach(select(value), Reason.DomCallback);
          }}
        >
          <option value="okou">Okou</option>
          <option value="cua">CUA (Experimental)</option>
        </select>
      </label>
      <div className="driver-status" role="status" aria-live="polite">
        <p>
          Requested:{" "}
          {state.selectedDriver === "cua" ? "CUA (Experimental)" : "Okou"}
        </p>
        <p>
          Actual:{" "}
          {state.actual
            ? `${state.actual.id === "cua" ? "CUA" : "Okou"} · generation ${String(state.actual.generation)}`
            : "No native driver"}{" "}
          · {state.phase}
        </p>
        <p>
          Ready version: {state.actual?.version ?? "Unavailable"} · Packaged
          CUA: {state.expectedCuaVersion} (expected)
        </p>
        <p>Lifecycle elapsed: {state.lifecycleElapsedMs} ms</p>
      </div>
      {recovery}
    </Panel>
  );
}
