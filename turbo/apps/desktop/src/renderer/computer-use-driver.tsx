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
  state,
}: {
  readonly state: DesktopComputerUseDriverState;
}) {
  const [selection, select] = useLoadableSet(selectComputerUseDriver$);
  const [retry, start] = useLoadableSet(startComputerUse$);
  const [stopping, stop] = useLoadableSet(stopComputerUse$);
  const visible =
    state.experimentalCuaEnabled && state.developerAvailability === "available";
  if (
    !visible &&
    state.selectedDriver === "okou" &&
    state.actual?.id !== "cua" &&
    !state.error &&
    !state.cleanupPending &&
    state.phase !== "switching"
  )
    return null;
  const busy = selection.state === "loading";
  return (
    <Panel title="Computer Use driver">
      {visible && (
        <label className="driver-choice">
          <span>Driver</span>
          <select
            aria-label="Computer Use driver"
            value={state.selectedDriver}
            disabled={busy}
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
      )}
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
        {state.cleanupPending && (
          <p>
            Cleanup is still pending. Recovery waits for the previous driver to
            exit.
          </p>
        )}
      </div>
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
    </Panel>
  );
}
