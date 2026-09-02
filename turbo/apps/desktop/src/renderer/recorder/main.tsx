import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Deliberately not the app stylesheet: its `:root` paints an opaque page
// background, which in a transparent overlay window covers the screen the user
// is trying to see through.
import "./recorder.css";
import { AreaSelector } from "./area-selector";
import { RecorderBar } from "./recorder-bar";
import { RecordingController } from "./recording-controller";
import { WindowPicker } from "./window-picker";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Recorder overlay is missing its root element");
}

const mode = new URLSearchParams(window.location.search).get("mode");

function overlayForMode(): React.ReactElement {
  if (mode === "area") {
    return <AreaSelector />;
  }
  if (mode === "controller") {
    return <RecordingController />;
  }
  if (mode === "windows") {
    return <WindowPicker />;
  }
  return <RecorderBar />;
}

createRoot(container).render(<StrictMode>{overlayForMode()}</StrictMode>);
