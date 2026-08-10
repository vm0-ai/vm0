import { Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  mermaidDiagramKey,
  mermaidDiagramRef$,
  mermaidDiagramResultByKey$,
  type MermaidDiagramResult,
} from "../../signals/mermaid-diagram.ts";
import { theme$ } from "../../signals/theme.ts";
import { openImageLightbox$ } from "../../signals/zero-page/zero-attachment-chips.ts";

/**
 * Renders a ```mermaid fenced block as a diagram.
 *
 * The diagram is shown by an <img> inside a box whose size is reserved before
 * the render starts, so a message keeps the same height whatever the diagram's
 * own aspect ratio turns out to be, and the render cannot move the thread under
 * a reader. The SVG is letterboxed inside that box and opens at full size in
 * the lightbox.
 *
 * The button is keyed by scope, theme, and source so a semantic input change
 * remounts it, which re-runs the render command and aborts the previous render.
 * It keeps its position in the tree across statuses so the ref is not
 * re-attached when the render finishes — re-attaching would abort the render
 * that just produced the result and start it again.
 */
export function MermaidDiagram({
  code,
  scope,
}: {
  code: string;
  scope: string;
}) {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const diagramRef = useSet(mermaidDiagramRef$);
  const openImageLightbox = useSet(openImageLightbox$);
  const resultByKey = useGet(mermaidDiagramResultByKey$);
  const result: MermaidDiagramResult = resultByKey[
    mermaidDiagramKey(code, theme, scope)
  ] ?? { status: "rendering" };

  return (
    <div className="mermaid-block" data-mermaid-status={result.status}>
      <button
        key={`${scope}:${theme}:${code}`}
        ref={diagramRef}
        type="button"
        data-mermaid-code={code}
        data-mermaid-scope={scope}
        data-mermaid-theme={theme}
        className="mermaid-diagram-expand"
        disabled={result.status !== "rendered"}
        aria-label={t(($) => {
          return $.shared.mermaid.expand;
        })}
        onClick={() => {
          if (result.status !== "rendered") {
            return;
          }
          // The inline image keeps its chat-panel-owned URL. File metadata lets
          // each preview surface create an independently owned URL and present
          // it as diagram.svg.
          openImageLightbox({
            url: result.url,
            file: result.file,
            shareAvailable: false,
          });
        }}
      >
        {result.status === "rendered" ? (
          <img
            src={result.url}
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
      {result.status === "error" ? (
        <pre data-testid="mermaid-diagram-fallback">
          <code>{code}</code>
        </pre>
      ) : (
        <details className="mermaid-diagram-source">
          <summary>
            {t(($) => {
              return $.shared.mermaid.viewSource;
            })}
          </summary>
          <pre>
            <code>{code}</code>
          </pre>
        </details>
      )}
    </div>
  );
}
