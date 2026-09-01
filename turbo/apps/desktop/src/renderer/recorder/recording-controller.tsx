import { useEffect, useState } from "react";
import { Pause, Play, Square, Trash2 } from "lucide-react";

const recorder = window.vm0DesktopRecorder;

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Controls shown while a recording runs: pause, stop, discard.
 *
 * Lives in its own window placed outside the captured region, so for an area
 * capture it is never part of the video.
 */
export function RecordingController(): React.ReactElement {
  // Narrowed once here so the handlers below need no assertions.
  const bridge = recorder;
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!recorder) {
      return;
    }
    const timer = setInterval(() => {
      void recorder.getState().then((state) => {
        setPaused(state.status === "paused");
        setElapsedMs(state.elapsedMs);
      });
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  function run(action: () => Promise<void>): void {
    setBusy(true);
    void action().finally(() => {
      setBusy(false);
    });
  }

  return (
    <div className="recording-controller">
      <span className="recording-controller__clock">
        <span
          className={
            paused
              ? "recording-controller__dot recording-controller__dot--paused"
              : "recording-controller__dot"
          }
        />
        {formatElapsed(elapsedMs)}
      </span>

      <button
        type="button"
        className="recording-controller__button"
        aria-label={paused ? "Resume" : "Pause"}
        disabled={busy || !bridge}
        onClick={() => {
          if (bridge) {
            run(() => (paused ? bridge.resume() : bridge.pause()));
          }
        }}
      >
        {paused ? <Play size={17} /> : <Pause size={17} />}
      </button>

      <button
        type="button"
        className="recording-controller__button recording-controller__button--stop"
        aria-label="Finish recording"
        disabled={busy || !bridge}
        onClick={() => {
          if (bridge) {
            run(() => bridge.stop());
          }
        }}
      >
        <Square size={15} />
      </button>

      <button
        type="button"
        className="recording-controller__button recording-controller__button--discard"
        aria-label="Delete recording"
        disabled={busy || !bridge}
        onClick={() => {
          if (bridge) {
            run(() => bridge.discard());
          }
        }}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
