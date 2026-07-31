import { command, computed, state } from "ccstate";
import { onRef, settle, withCleanup } from "./utils.ts";

export type MermaidDiagramResult =
  | { readonly status: "rendering" }
  | { readonly status: "rendered"; readonly url: string }
  | { readonly status: "error" };

const internalMermaidDiagramResultByKey$ = state<
  Record<string, MermaidDiagramResult>
>({});

export const mermaidDiagramResultByKey$ = computed((get) => {
  return get(internalMermaidDiagramResultByKey$);
});

/**
 * Diagrams are identified by their source and theme: identical diagrams share a
 * result entry, and a theme switch renders a new one.
 */
export function mermaidDiagramKey(code: string, theme: string): string {
  return `${theme}:${code}`;
}

const setMermaidDiagramResult$ = command(
  ({ set }, key: string, result: MermaidDiagramResult) => {
    set(internalMermaidDiagramResultByKey$, (current) => {
      return { ...current, [key]: result };
    });
  },
);

// mermaid costs ~170 KB gzipped for the first diagram, so it is only fetched
// once a diagram actually needs rendering.
const mermaidModule$ = state<Promise<typeof import("mermaid")> | undefined>(
  undefined,
);
const renderSequence$ = state(0);
// mermaid keeps global configuration and DOM state, so renders are serialized.
const renderQueue$ = state<Promise<void>>(Promise.resolve());

const loadMermaid$ = command(
  async ({ get, set }, theme: string, signal: AbortSignal) => {
    const pending = get(mermaidModule$) ?? import("mermaid");
    set(mermaidModule$, pending);
    const { default: mermaid } = await pending;
    signal.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      // "strict" makes mermaid sanitize the generated SVG with DOMPurify and
      // disables click handlers declared inside diagram sources.
      securityLevel: "strict",
      // Without this mermaid injects its own error diagram into the document.
      suppressErrorRendering: true,
      theme: theme === "dark" ? "dark" : "default",
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
    return mermaid;
  },
);

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

interface QueuedDiagram {
  readonly el: HTMLElement;
  readonly key: string;
  readonly code: string;
  readonly theme: string;
}

/**
 * Intrinsic width of the serialized copy. The lightbox fits an image into the
 * stage but never scales it above 100%, so a diagram serialized at chat size
 * would open as a thumbnail. SVG is vector, so the enlarged copy stays sharp
 * and the lightbox scales it down to fit the viewport like any other image.
 */
const LIGHTBOX_SVG_WIDTH = 1600;

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
 * <img> cannot resolve — the lightbox would stretch the diagram to the stage
 * width. Both copies therefore get an explicit pixel size: the markup is
 * serialized at lightbox scale, then the element is restored to the size the
 * message shows inline.
 */
function sizeDiagramAndSerialize(svg: SVGSVGElement): string {
  svg.style.maxWidth = "";
  const size = viewBoxSize(svg);
  if (!size) {
    return new XMLSerializer().serializeToString(svg);
  }

  const scale = Math.max(1, LIGHTBOX_SVG_WIDTH / size.width);
  setSvgSize(svg, size.width * scale, size.height * scale);
  const markup = new XMLSerializer().serializeToString(svg);
  setSvgSize(svg, size.width, size.height);
  return markup;
}

/**
 * The lightbox reuses the attachment image preview, which takes a URL. The
 * rendered SVG never leaves the browser, so it is inlined as a data URL instead
 * of being uploaded.
 */
function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

const renderQueuedDiagram$ = command(
  async ({ get, set }, diagram: QueuedDiagram, signal: AbortSignal) => {
    signal.throwIfAborted();
    const mermaid = await set(loadMermaid$, diagram.theme, signal);
    const sequence = get(renderSequence$) + 1;
    set(renderSequence$, sequence);

    // A diagram that parses can still fail to lay out; both failures fall back
    // to showing the source instead of an empty frame.
    const rendered = await settle(
      renderDiagramSvg(
        mermaid,
        `mermaid-diagram-${String(sequence)}`,
        diagram.code,
      ),
      signal,
    );
    if (!rendered.ok || rendered.value === undefined) {
      set(setMermaidDiagramResult$, diagram.key, { status: "error" });
      return;
    }

    // Safe to assign: mermaid sanitized the markup, and React owns no children
    // inside this element.
    diagram.el.innerHTML = rendered.value;
    const svg = diagram.el.querySelector("svg");
    if (!svg) {
      set(setMermaidDiagramResult$, diagram.key, { status: "error" });
      return;
    }

    set(setMermaidDiagramResult$, diagram.key, {
      status: "rendered",
      url: svgDataUrl(sizeDiagramAndSerialize(svg)),
    });
  },
);

const awaitTurnAndRender$ = command(
  async (
    { set },
    args: { readonly previous: Promise<void>; readonly diagram: QueuedDiagram },
    signal: AbortSignal,
  ) => {
    await args.previous;
    signal.throwIfAborted();
    await set(renderQueuedDiagram$, args.diagram, signal);
  },
);

const renderMermaidDiagram$ = command(
  async ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    const code = el.dataset.mermaidCode ?? "";
    const theme = el.dataset.mermaidTheme === "dark" ? "dark" : "light";
    const key = mermaidDiagramKey(code, theme);

    set(setMermaidDiagramResult$, key, { status: "rendering" });

    const previous = get(renderQueue$);
    const { promise, resolve } = Promise.withResolvers<void>();
    set(renderQueue$, promise);

    // The queue must advance even when this render aborts or fails.
    await withCleanup(
      set(
        awaitTurnAndRender$,
        { previous, diagram: { el, key, code, theme } },
        signal,
      ),
      () => {
        resolve();
      },
    );
  },
);

export const mermaidDiagramRef$ = onRef(renderMermaidDiagram$);
