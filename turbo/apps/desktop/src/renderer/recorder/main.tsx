import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./recorder.css";
import { AreaSelector } from "./area-selector";
import { RecorderBar } from "./recorder-bar";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Recorder overlay is missing its root element");
}

const mode = new URLSearchParams(window.location.search).get("mode");

createRoot(container).render(
  <StrictMode>
    {mode === "area" ? <AreaSelector /> : <RecorderBar />}
  </StrictMode>,
);
