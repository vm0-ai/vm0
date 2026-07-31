/**
 * Mock mermaid library for tests.
 *
 * The real library measures text with SVG APIs that happy-dom does not
 * implement (`getBBox`, `getComputedTextLength`), so tests render a stub SVG
 * instead. `parse` recognizes the diagram keywords mermaid supports, which is
 * enough to exercise the invalid-syntax fallback path.
 */

const DIAGRAM_KEYWORDS = [
  "architecture-beta",
  "block-beta",
  "classDiagram",
  "erDiagram",
  "flowchart",
  "gantt",
  "gitGraph",
  "graph",
  "journey",
  "mindmap",
  "pie",
  "quadrantChart",
  "requirementDiagram",
  "sequenceDiagram",
  "stateDiagram",
  "timeline",
  "xychart-beta",
];

function isSupportedDiagram(text: string): boolean {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return DIAGRAM_KEYWORDS.some((keyword) => {
    return firstLine.startsWith(keyword);
  });
}

const mermaid = {
  initialize: () => {},
  parse: (text: string) => {
    if (!isSupportedDiagram(text)) {
      return Promise.resolve(false as const);
    }
    return Promise.resolve({ diagramType: "mock" });
  },
  render: (id: string) => {
    return Promise.resolve({
      svg: `<svg data-testid="mermaid-svg" id="${id}"></svg>`,
    });
  },
};

export default mermaid;
