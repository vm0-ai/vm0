import { useLoadable, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MermaidDiagramSignals } from "../../signals/mermaid-diagram.ts";
import { openImageLightbox$ } from "../../signals/zero-page/zero-attachment-chips.ts";

/**
 * Renders a ```mermaid fenced block as a diagram from its signals.
 *
 * A rendered diagram or its invalid state is shown inside a box whose size is
 * reserved before the render starts, so a message keeps the same height across
 * every render outcome and the thread cannot move under a reader. A valid SVG
 * is letterboxed inside that box and opens at full size in the lightbox.
 */
export function MermaidDiagramView({
  signals,
}: {
  signals: MermaidDiagramSignals;
}) {
  const { t } = useTranslation();
  const openImageLightbox = useSet(openImageLightbox$);
  const loadable = useLoadable(signals.diagram$);
  const expandDiagram = t(($) => {
    return $.shared.mermaid.expand;
  });
  const invalidDiagram = t(($) => {
    return $.shared.mermaid.invalidDiagram;
  });
  const status =
    loadable.state === "hasData"
      ? "rendered"
      : loadable.state === "hasError"
        ? "error"
        : "rendering";

  return (
    <div className="mermaid-block" data-mermaid-status={status}>
      <button
        type="button"
        className="mermaid-diagram-expand"
        disabled={loadable.state !== "hasData"}
        aria-label={status === "error" ? invalidDiagram : expandDiagram}
        onClick={() => {
          if (loadable.state !== "hasData") {
            return;
          }
          // File metadata lets each preview surface present the diagram as
          // diagram.svg with download support.
          openImageLightbox({
            url: loadable.data.url,
            file: loadable.data.file,
            shareAvailable: false,
          });
        }}
      >
        {loadable.state === "hasData" ? (
          <img
            src={loadable.data.url}
            alt={t(($) => {
              return $.shared.mermaid.diagramLabel;
            })}
            className="mermaid-diagram-image"
          />
        ) : loadable.state === "hasError" ? (
          <span className="mermaid-diagram-invalid">{invalidDiagram}</span>
        ) : (
          <span className="mermaid-diagram-pending" aria-hidden="true">
            <Loader2 size={18} className="animate-spin" />
          </span>
        )}
      </button>
      <details className="mermaid-diagram-source">
        <summary>
          {t(($) => {
            return $.shared.mermaid.viewSource;
          })}
        </summary>
        <pre>
          <code>{signals.code}</code>
        </pre>
      </details>
    </div>
  );
}
