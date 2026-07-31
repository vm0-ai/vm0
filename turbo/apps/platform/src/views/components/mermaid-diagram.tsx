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
 * The canvas element is keyed by theme and source so a theme switch remounts
 * it, which re-runs the render command (and aborts the previous render). The
 * canvas keeps its position in the tree across statuses so the ref is not
 * re-attached when the render finishes.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const diagramRef = useSet(mermaidDiagramRef$);
  const openImageLightbox = useSet(openImageLightbox$);
  const resultByKey = useGet(mermaidDiagramResultByKey$);
  const result: MermaidDiagramResult = resultByKey[
    mermaidDiagramKey(code, theme)
  ] ?? { status: "rendering" };

  return (
    <div className="mermaid-block" data-mermaid-status={result.status}>
      <button
        type="button"
        className="mermaid-diagram-expand"
        disabled={result.status !== "rendered"}
        aria-label={t(($) => {
          return $.shared.mermaid.expand;
        })}
        onClick={() => {
          if (result.status !== "rendered") {
            return;
          }
          openImageLightbox({ url: result.url, filename: "diagram.svg" });
        }}
      >
        <div
          key={`${theme}:${code}`}
          ref={diagramRef}
          data-mermaid-code={code}
          data-mermaid-theme={theme}
          data-testid="mermaid-diagram-canvas"
          className="mermaid-diagram-canvas"
          role="img"
          aria-label={t(($) => {
            return $.shared.mermaid.diagramLabel;
          })}
        />
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
