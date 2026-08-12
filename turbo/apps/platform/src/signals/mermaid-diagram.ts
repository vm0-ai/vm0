import { command, computed, state, type Computed } from "ccstate";
import type { Element, Root } from "hast";

import { theme$ } from "./theme.ts";

/**
 * Mermaid diagrams render through a pull model. Each unique diagram source
 * owns one `MermaidDiagramSignals` in a module-scope registry; its `diagram$`
 * computed loads mermaid, lays the diagram out and resolves to an image the
 * view shows in an `<img>` — or to `null` when the parser rejects the source,
 * in which case the fence simply stays a code block. Reading the theme inside
 * the computed makes a theme switch re-render every diagram without any
 * remounting.
 *
 * The command that parses a tree registers each diagram and embeds the
 * returned signals on the marker node, so rendering receives the signals
 * object directly. The registry is content-addressed: the rendered image
 * depends only on the source and the theme, so the same fence in two threads
 * shares one entry.
 *
 * The image is a blob URL owned by the registry entry, so nothing revokes it
 * while the entry lives — which is forever, like the entry itself. A theme
 * switch recomputes `diagram$` and strands the previous blob until page
 * unload; that stranding is bounded by theme flips × diagrams and stays in
 * the tens of kilobytes.
 */
export interface MermaidDiagramImage {
  readonly url: string;
  readonly file: File;
}

export interface MermaidDiagramSignals {
  readonly code: string;
  /** Resolves `null` when the source is not a valid mermaid diagram. */
  readonly diagram$: Computed<Promise<MermaidDiagramImage | null>>;
}

// Declared here rather than in the parse pipeline: the pipeline emits only
// `data.mermaid` ({code}), and this field is written by the signals layer
// afterwards, by `embedMermaidSignals`.
declare module "hast" {
  interface Data {
    mermaidSignals?: MermaidDiagramSignals;
  }
}

/**
 * Resolve every mermaid marker in a freshly parsed tree to its diagram
 * signals and embed them on the node. Rendering then receives the signals
 * object from the tree, the same way cards do.
 */
export function embedMermaidSignals(
  tree: Root,
  resolve: (code: string) => MermaidDiagramSignals,
): void {
  const visitNode = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const mermaid = child.data?.mermaid;
      if (mermaid !== undefined) {
        child.data = { ...child.data, mermaidSignals: resolve(mermaid.code) };
        continue;
      }
      visitNode(child);
    }
  };
  visitNode(tree);
}

const internalMermaidDiagramsByCode$ = state<
  ReadonlyMap<string, MermaidDiagramSignals>
>(new Map());

// mermaid costs ~170 KB gzipped for the first diagram, so it is only fetched
// once a diagram actually needs rendering; the computed memoizes the promise.
const mermaidModule$ = computed(() => {
  return import("mermaid");
});

/**
 * mermaid needs a DOM id per `render` call. Concurrent renders only happen for
 * distinct code+theme pairs — the same pair is one deduplicated computed — so
 * a deterministic hash of both is collision-free where it matters.
 */
function diagramRenderId(seed: string): string {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33) ^ seed.charCodeAt(index);
  }
  return `mermaid-diagram-${(hash >>> 0).toString(36)}`;
}

/** Returns the diagram SVG, or undefined when the source is not valid mermaid. */
async function renderDiagramSvg(
  mermaid: (typeof import("mermaid"))["default"],
  id: string,
  code: string,
): Promise<string | undefined> {
  const parsed = await mermaid.parse(code, { suppressErrors: true });
  if (!parsed) {
    return undefined;
  }
  const { svg } = await mermaid.render(id, code);
  return svg;
}

/**
 * Intrinsic width of the serialized copy. Expanded preview surfaces fit an
 * image into their stage but never scale it above 100%, so a diagram serialized
 * at chat size would open as a thumbnail. SVG is vector, so the enlarged copy
 * stays sharp while the preview scales it down to fit like any other image.
 */
const EXPANDED_SVG_WIDTH = 1600;

function viewBoxSize(
  svg: SVGSVGElement,
): { readonly width: number; readonly height: number } | undefined {
  const viewBox = (svg.getAttribute("viewBox") ?? "").split(/\s+/);
  const width = Number(viewBox[2]);
  const height = Number(viewBox[3]);
  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }
  return { width, height };
}

function setSvgSize(svg: SVGSVGElement, width: number, height: number): void {
  svg.setAttribute("width", String(Math.round(width)));
  svg.setAttribute("height", String(Math.round(height)));
}

/**
 * mermaid sizes its SVG with `width="100%"` plus an inline `max-width`, which an
 * <img> cannot resolve — an expanded preview would stretch the diagram to the
 * stage width. The markup therefore gets an explicit preview-scale pixel size.
 * SVG is vector, so the same copy serves the box in the message, which scales
 * it down, and the lightbox or sidebar, which shows it at full size.
 */
function sizeDiagramAndSerialize(svg: SVGSVGElement): string {
  svg.style.maxWidth = "";
  const size = viewBoxSize(svg);
  if (!size) {
    return new XMLSerializer().serializeToString(svg);
  }

  const scale = Math.max(1, EXPANDED_SVG_WIDTH / size.width);
  setSvgSize(svg, size.width * scale, size.height * scale);
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Keep the rendered SVG as a browser-native file so preview surfaces can
 * present it as diagram.svg with download metadata.
 */
function svgFile(markup: string): File {
  return new File([markup], "diagram.svg", { type: "image/svg+xml" });
}

/**
 * Pure factory for a diagram's signals. Preview trees whose content arrives
 * with the surface create signals per tree; the chat pipeline goes through
 * `registerMermaidDiagram$` instead so a streaming message keeps stable
 * signal identities for fences its growing body re-parses.
 */
export function createMermaidDiagramSignals(
  code: string,
): MermaidDiagramSignals {
  const diagram$ = computed(
    async (get): Promise<MermaidDiagramImage | null> => {
      const theme = get(theme$);
      const { default: mermaid } = await get(mermaidModule$);
      mermaid.initialize({
        startOnLoad: false,
        // "strict" makes mermaid sanitize the generated SVG with DOMPurify and
        // disables click handlers declared inside diagram sources.
        securityLevel: "strict",
        // Without this mermaid injects its own error diagram into the document.
        suppressErrorRendering: true,
        theme: theme === "dark" ? "redux-dark" : "redux",
        // Resolved to a concrete stack rather than passed as `var(...)`: the same
        // SVG is also shown inside an <img> in the lightbox, where page-level CSS
        // custom properties do not resolve.
        fontFamily: getComputedStyle(document.documentElement)
          .getPropertyValue("--font-family-sans")
          .trim(),
        // mermaid's defaults are sized for a standalone page: 16px labels and
        // 50px rank spacing make a five-node flowchart taller than the message
        // around it. These match the chat body text and cut roughly a third of
        // the height.
        themeVariables: { fontSize: "14px" },
        flowchart: { nodeSpacing: 30, rankSpacing: 32, padding: 8 },
      });

      const markup = await renderDiagramSvg(
        mermaid,
        diagramRenderId(`${theme}:${code}`),
        code,
      );
      if (markup === undefined) {
        return null;
      }

      // Parsed in a detached element. The markup never reaches the document, so
      // the only thing that ever shows it is an <img>, where a data URL SVG
      // cannot run scripts or resolve page-level CSS custom properties.
      const host = document.createElement("div");
      host.innerHTML = markup;
      const svg = host.querySelector("svg");
      if (!svg) {
        throw new Error("mermaid renderer produced no svg");
      }

      const serialized = sizeDiagramAndSerialize(svg);
      const file = svgFile(serialized);
      return {
        // A blob URL keeps the multi-kilobyte SVG out of the `src` attribute:
        // assigning a data: URL string of that size showed up in commit-phase
        // profiles as a per-mount cost.
        url: URL.createObjectURL(file),
        file,
      };
    },
  );
  return { code, diagram$ };
}

export const registerMermaidDiagram$ = command(
  ({ get, set }, code: string): MermaidDiagramSignals => {
    const current = get(internalMermaidDiagramsByCode$);
    const existing = current.get(code);
    if (existing !== undefined) {
      return existing;
    }
    const signals = createMermaidDiagramSignals(code);
    const next = new Map(current);
    next.set(code, signals);
    set(internalMermaidDiagramsByCode$, next);
    return signals;
  },
);
