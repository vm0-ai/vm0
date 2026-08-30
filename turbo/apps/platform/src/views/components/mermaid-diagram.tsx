import { CopyButton } from "@okouai/ui";
import { useLoadable, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MermaidDiagramSignals } from "../../signals/mermaid-diagram.ts";
import { openImageLightbox$ } from "../../signals/okou-page/attachment-chips.ts";
import { IconTooltipButton } from "./icon-tooltip.tsx";

function MermaidCodeBlock({ signals }: { signals: MermaidDiagramSignals }) {
  return (
    <pre>
      <code className="language-mermaid">{signals.code}</code>
      <CopyButton
        type="button"
        text={signals.code}
        showTooltip={false}
        className="copied"
        data-code={signals.code}
      />
    </pre>
  );
}

/**
 * Renders a ```mermaid fenced block as a diagram from its signals.
 *
 * A fence has exactly two presentations: a diagram when the mermaid parser
 * accepts the source, and an ordinary code block when it does not — the same
 * markup any other fence renders as, copy button included. While the diagram
 * is rendering, a box whose size is reserved up front holds its place, so the
 * render cannot move the thread under a reader. The SVG is letterboxed inside
 * that box and opens at full size in the lightbox.
 */
export function MermaidDiagramView({
  signals,
}: {
  signals: MermaidDiagramSignals;
}) {
  const { t } = useTranslation();
  const openImageLightbox = useSet(openImageLightbox$);
  const loadable = useLoadable(signals.diagram$);
  const image = loadable.state === "hasData" ? loadable.data : null;

  if (loadable.state !== "loading" && image === null) {
    return <MermaidCodeBlock signals={signals} />;
  }

  return (
    <div
      className="mermaid-block"
      data-mermaid-status={image ? "rendered" : "rendering"}
    >
      <IconTooltipButton
        type="button"
        className="mermaid-diagram-expand"
        disabled={image === null}
        aria-label={t(($) => {
          return $.shared.mermaid.expand;
        })}
        onClick={() => {
          if (image === null) {
            return;
          }
          // File metadata lets each preview surface present the diagram as
          // diagram.svg with download support.
          openImageLightbox({
            url: image.url,
            file: image.file,
            shareAvailable: false,
          });
        }}
      >
        {image ? (
          <img
            src={image.url}
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
      </IconTooltipButton>
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
