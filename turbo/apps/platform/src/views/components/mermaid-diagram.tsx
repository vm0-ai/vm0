import { useGet, useLoadable, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  mermaidDiagramKey,
  mermaidDiagramRegisterRef$,
  mermaidDiagramsByKey$,
  type MermaidDiagramSignals,
} from "../../signals/mermaid-diagram.ts";
import { openImageLightbox$ } from "../../signals/zero-page/zero-attachment-chips.ts";

/**
 * Registration-on-mount fallback for trees parsed during render (the
 * standalone `Markdown` surfaces), which have no command of their own to
 * resolve diagram signals ahead of time. It registers through the
 * placeholder's ref and then reads the entry back by key — the chat pipeline
 * never renders this: its trees carry the signals embedded on the node and go
 * straight to `MermaidDiagramView`. This component and its lookup go away with
 * the parse-in-render surfaces.
 */
export function MermaidDiagram({
  code,
  scope,
}: {
  code: string;
  scope: string;
}) {
  const registerRef = useSet(mermaidDiagramRegisterRef$);
  const signals = useGet(mermaidDiagramsByKey$).get(
    mermaidDiagramKey(code, scope),
  );

  if (!signals) {
    return (
      <div
        ref={registerRef}
        className="mermaid-block"
        data-mermaid-status="rendering"
        data-mermaid-code={code}
        data-mermaid-scope={scope}
      >
        <MermaidPendingBox />
      </div>
    );
  }
  return <MermaidDiagramView signals={signals} />;
}

function MermaidPendingBox() {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="mermaid-diagram-expand"
      disabled
      aria-label={t(($) => {
        return $.shared.mermaid.expand;
      })}
    >
      <span className="mermaid-diagram-pending" aria-hidden="true">
        <Loader2 size={18} className="animate-spin" />
      </span>
    </button>
  );
}

/**
 * Renders a ```mermaid fenced block as a diagram from its signals.
 *
 * The diagram is shown by an <img> inside a box whose size is reserved before
 * the render starts, so a message keeps the same height whatever the diagram's
 * own aspect ratio turns out to be, and the render cannot move the thread under
 * a reader. The SVG is letterboxed inside that box and opens at full size in
 * the lightbox.
 */
export function MermaidDiagramView({
  signals,
}: {
  signals: MermaidDiagramSignals;
}) {
  const { t } = useTranslation();
  const openImageLightbox = useSet(openImageLightbox$);
  const loadable = useLoadable(signals.diagram$);
  const status =
    loadable.state === "hasData"
      ? "rendered"
      : loadable.state === "hasError"
        ? "error"
        : "rendering";

  return (
    <div className="mermaid-block" data-mermaid-status={status}>
      {status === "error" ? (
        <pre data-testid="mermaid-diagram-fallback">
          <code>{signals.code}</code>
        </pre>
      ) : (
        <>
          <button
            type="button"
            className="mermaid-diagram-expand"
            disabled={loadable.state !== "hasData"}
            aria-label={t(($) => {
              return $.shared.mermaid.expand;
            })}
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
        </>
      )}
    </div>
  );
}
