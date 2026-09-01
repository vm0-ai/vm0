import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  Monitor,
  SquareDashed,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  DesktopRecorderArea,
  DesktopRecorderSource,
} from "../../desktop-recorder-types";

type CaptureChoice =
  | { readonly kind: "area"; readonly area: DesktopRecorderArea | null }
  | { readonly kind: "display"; readonly sourceId: string | null }
  | { readonly kind: "window"; readonly sourceId: string | null };

const recorder = window.vm0DesktopRecorder;

function sourceLabel(source: DesktopRecorderSource): string {
  return source.appName ? `${source.appName} — ${source.title}` : source.title;
}

export function RecorderBar(): React.ReactElement {
  const [sources, setSources] = useState<readonly DesktopRecorderSource[]>([]);
  const [choice, setChoice] = useState<CaptureChoice>({
    kind: "display",
    sourceId: null,
  });
  const [systemAudio, setSystemAudio] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recorder) {
      return;
    }
    void recorder
      .listSources()
      .then((listed) => {
        setSources(listed);
        setChoice((current) => {
          if (current.kind !== "display" || current.sourceId) {
            return current;
          }
          const display = listed.find((source) => {
            return source.kind === "display";
          });
          return { kind: "display", sourceId: display?.id ?? null };
        });
      })
      .catch((listError: unknown) => {
        setError(
          listError instanceof Error
            ? listError.message
            : "Could not read what is on screen",
        );
      });
  }, []);

  const chooseArea = useCallback(() => {
    if (!recorder) {
      return;
    }
    setError(null);
    // The selector takes over the screen, so the bar has nothing useful to show
    // until it comes back with a region.
    void recorder
      .selectArea()
      .then((area) => {
        setChoice({ kind: "area", area });
      })
      .catch((selectError: unknown) => {
        setError(
          selectError instanceof Error
            ? selectError.message
            : "Could not select a region",
        );
      });
  }, []);

  const start = useCallback(() => {
    if (!recorder) {
      return;
    }
    const displayId = sources.find((source) => {
      return source.kind === "display";
    })?.id;
    if (choice.kind === "area") {
      if (!choice.area || !displayId) {
        setError("Select a region first");
        return;
      }
      setBusy(true);
      void recorder
        .startCapture({
          sourceId: displayId,
          sourceKind: "area",
          systemAudio,
          area: choice.area,
        })
        .catch(reportStartFailure);
      return;
    }
    if (!choice.sourceId) {
      setError(
        choice.kind === "display" ? "No display to record" : "Choose a window",
      );
      return;
    }
    setBusy(true);
    void recorder
      .startCapture({
        sourceId: choice.sourceId,
        sourceKind: choice.kind,
        systemAudio,
      })
      .catch(reportStartFailure);

    function reportStartFailure(startError: unknown): void {
      setBusy(false);
      setError(
        startError instanceof Error
          ? startError.message
          : "Could not start recording",
      );
    }
  }, [choice, sources, systemAudio]);

  const windows = sources.filter((source) => {
    return source.kind === "window";
  });
  const chosenWindow =
    choice.kind === "window"
      ? windows.find((source) => {
          return source.id === choice.sourceId;
        })
      : undefined;

  return (
    <div className="recorder-bar">
      <button
        type="button"
        className="recorder-bar__close"
        aria-label="Close"
        onClick={() => {
          void recorder?.cancel();
        }}
      >
        <X size={16} />
      </button>

      <div className="recorder-bar__sources">
        <button
          type="button"
          className="recorder-bar__source"
          aria-pressed={choice.kind === "display"}
          onClick={() => {
            const display = sources.find((source) => {
              return source.kind === "display";
            });
            setChoice({ kind: "display", sourceId: display?.id ?? null });
          }}
        >
          <Monitor size={22} />
          <span className="recorder-bar__source-label">Display</span>
        </button>

        {/* The picker covers the whole tile invisibly, so Window looks and
            sits exactly like the buttons either side of it instead of growing
            a control of its own. */}
        <div
          className="recorder-bar__source recorder-bar__source--window"
          aria-pressed={choice.kind === "window"}
        >
          <AppWindow size={22} />
          <span className="recorder-bar__source-label">
            {chosenWindow ? sourceLabel(chosenWindow) : "Window"}
          </span>
          <select
            className="recorder-bar__window-picker"
            aria-label="Window to record"
            value={choice.kind === "window" ? (choice.sourceId ?? "") : ""}
            onChange={(event) => {
              setChoice({ kind: "window", sourceId: event.target.value });
            }}
          >
            <option value="">Window</option>
            {windows.map((source) => {
              return (
                <option key={source.id} value={source.id}>
                  {sourceLabel(source)}
                </option>
              );
            })}
          </select>
        </div>

        <button
          type="button"
          className="recorder-bar__source"
          aria-pressed={choice.kind === "area"}
          onClick={() => {
            setChoice({ kind: "area", area: null });
            chooseArea();
          }}
        >
          <SquareDashed size={22} />
          <span className="recorder-bar__source-label">
            {choice.kind === "area" && choice.area
              ? `${choice.area.width.toString()} × ${choice.area.height.toString()}`
              : "Area"}
          </span>
        </button>
      </div>

      <span className="recorder-bar__divider" />

      <button
        type="button"
        className="recorder-bar__audio"
        aria-pressed={systemAudio}
        onClick={() => {
          setSystemAudio((enabled) => {
            return !enabled;
          });
        }}
      >
        {systemAudio ? <Volume2 size={18} /> : <VolumeX size={18} />}
        <span>{systemAudio ? "System audio" : "No system audio"}</span>
      </button>

      <button
        type="button"
        className="recorder-bar__start"
        disabled={busy}
        onClick={start}
      >
        {busy ? "Starting…" : "Start recording"}
      </button>

      {error ? <p className="recorder-bar__error">{error}</p> : null}
    </div>
  );
}
