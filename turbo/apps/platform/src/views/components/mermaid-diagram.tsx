import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  mermaidDiagramKey,
  mermaidDiagramRef$,
  mermaidDiagramStatusByKey$,
} from "../../signals/mermaid-diagram.ts";
import { theme$ } from "../../signals/theme.ts";

/**
 * Renders a ```mermaid fenced block as a diagram.
 *
 * The canvas element is keyed by theme and source so a theme switch remounts
 * it, which re-runs the render command (and aborts the previous render).
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { t } = useTranslation();
  const theme = useGet(theme$);
  const diagramRef = useSet(mermaidDiagramRef$);
  const statusByKey = useGet(mermaidDiagramStatusByKey$);
  const status = statusByKey[mermaidDiagramKey(code, theme)] ?? "rendering";

  return (
    <div className="mermaid-block" data-mermaid-status={status}>
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
      {status === "error" ? (
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
