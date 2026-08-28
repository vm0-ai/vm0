import { describe, expect, it } from "vitest";

import {
  createMermaidDiagramSignals,
  type MermaidDiagramImage,
} from "../mermaid-diagram.ts";
import { setTheme$ } from "../theme.ts";
import { testContext, warmMermaidParser } from "./test-helpers.ts";

const context = testContext();
warmMermaidParser();

const FLOWCHART = "flowchart TD\n  A --> B";
const SEQUENCE_DIAGRAM = "sequenceDiagram\n  Alice->>Bob: Hello";

function diagramMarkup(
  image: MermaidDiagramImage | null,
  objectUrls: ReturnType<typeof context.mocks.browser.blobDownload>,
): Promise<string> {
  if (image === null) {
    throw new Error("Expected a rendered diagram");
  }
  const blob = objectUrls.blobForUrl(image.url);
  if (!blob) {
    throw new Error("Expected the diagram to be shown from a blob URL");
  }
  return blob.text();
}

describe("mermaid diagram rendering", () => {
  it("renders sequence diagrams", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    const signals = createMermaidDiagramSignals(
      SEQUENCE_DIAGRAM,
      context.signal,
    );

    const markup = await diagramMarkup(
      await context.store.get(signals.diagram$),
      objectUrls,
    );
    expect(markup).toContain('data-testid="mermaid-svg"');
  });

  // mermaid.initialize mutates module-global configuration. When a theme flip
  // starts a second render while the first is still parsing, the second
  // initialize must not leak its theme into the first render — the first
  // theme's cache entry would otherwise permanently hold the other theme's
  // SVG.
  it("keeps overlapping theme renders on their own theme", async () => {
    const objectUrls = context.mocks.browser.blobDownload();
    const signals = createMermaidDiagramSignals(FLOWCHART, context.signal);

    const light = context.store.get(signals.diagram$);
    context.store.set(setTheme$, "dark");
    const dark = context.store.get(signals.diagram$);

    const lightMarkup = await diagramMarkup(await light, objectUrls);
    const darkMarkup = await diagramMarkup(await dark, objectUrls);

    expect(lightMarkup).toContain('data-mermaid-theme="redux"');
    expect(darkMarkup).toContain('data-mermaid-theme="redux-dark"');

    context.store.set(setTheme$, "light");
  });
});
