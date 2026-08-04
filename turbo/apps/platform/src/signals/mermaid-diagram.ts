import { command, computed, state } from "ccstate";
import { onRef, settle } from "./utils.ts";

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

// A rendered entry holds the whole diagram as a data URL, so entries are
// refcounted by mounted canvas and dropped once the last one detaches.
const internalMermaidDiagramRefCountByKey$ = state<Record<string, number>>({});

const retainMermaidDiagramResult$ = command(({ get, set }, key: string) => {
  const refCount = get(internalMermaidDiagramRefCountByKey$)[key] ?? 0;
  set(internalMermaidDiagramRefCountByKey$, (current) => {
    return { ...current, [key]: refCount + 1 };
  });
  if (get(internalMermaidDiagramResultByKey$)[key]) {
    // An identical diagram is already rendered — the same source in a second
    // message, or the same one whose block remounted. Resetting it to
    // `rendering` would blank a diagram the reader is already looking at.
    return;
  }
  set(setMermaidDiagramResult$, key, { status: "rendering" });
});

function withoutKey<T>(current: Record<string, T>, key: string) {
  if (!(key in current)) {
    return current;
  }
  const next = { ...current };
  delete next[key];
  return next;
}

const releaseMermaidDiagramResult$ = command(({ get, set }, key: string) => {
  const refCount = get(internalMermaidDiagramRefCountByKey$)[key] ?? 0;
  if (refCount > 1) {
    set(internalMermaidDiagramRefCountByKey$, (current) => {
      return { ...current, [key]: refCount - 1 };
    });
    return;
  }

  set(internalMermaidDiagramRefCountByKey$, (current) => {
    return withoutKey(current, key);
  });
  // Dropped one microtask later, not here. A block that only moves in the tree
  // — a run finishing regroups the messages around it — detaches its old
  // element and attaches the replacement inside a single commit, and dropping
  // the result in between blanks the diagram and re-runs mermaid for a source
  // that never changed. A block that is really gone has nothing retaining it
  // when the microtask runs, so its data URL is still released.
  queueMicrotask(() => {
    if ((get(internalMermaidDiagramRefCountByKey$)[key] ?? 0) > 0) {
      return;
    }
    set(internalMermaidDiagramResultByKey$, (current) => {
      return withoutKey(current, key);
    });
  });
});

// mermaid costs ~170 KB gzipped for the first diagram, so it is only fetched
// once a diagram actually needs rendering.
const mermaidModule$ = state<Promise<typeof import("mermaid")> | undefined>(
  undefined,
);
const renderSequence$ = state(0);

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
 * width. The markup therefore gets an explicit pixel size at lightbox scale.
 * SVG is vector, so the same copy serves the box in the message, which scales
 * it down, and the lightbox, which shows it at full size.
 */
function sizeDiagramAndSerialize(svg: SVGSVGElement): string {
  svg.style.maxWidth = "";
  const size = viewBoxSize(svg);
  if (!size) {
    return new XMLSerializer().serializeToString(svg);
  }

  const scale = Math.max(1, LIGHTBOX_SVG_WIDTH / size.width);
  setSvgSize(svg, size.width * scale, size.height * scale);
  return new XMLSerializer().serializeToString(svg);
}

/**
 * The lightbox reuses the attachment image preview, which takes a URL. The
 * rendered SVG never leaves the browser, so it is inlined as a data URL instead
 * of being uploaded.
 */
function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/**
 * Renders one diagram into a data URL. mermaid 11 isolates concurrent `render`
 * calls, so several diagrams in one message can render in parallel.
 *
 * `el` carries the source and theme to render and anchors the render to the
 * element's lifetime; the diagram itself is shown by an <img> and never enters
 * the document.
 */
const renderMermaidDiagram$ = command(
  async ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    const code = el.dataset.mermaidCode ?? "";
    const theme = el.dataset.mermaidTheme === "dark" ? "dark" : "light";
    const key = mermaidDiagramKey(code, theme);

    set(retainMermaidDiagramResult$, key);
    signal.addEventListener(
      "abort",
      () => {
        set(releaseMermaidDiagramResult$, key);
      },
      { once: true },
    );

    if (get(internalMermaidDiagramResultByKey$)[key]?.status === "rendered") {
      // The result is keyed by source and theme, so an existing one is already
      // this element's diagram: a block that remounted, or the same diagram in
      // a second message. Laying it out again would produce the same markup.
      return;
    }

    const mermaid = await set(loadMermaid$, theme, signal);
    const sequence = get(renderSequence$) + 1;
    set(renderSequence$, sequence);

    // A diagram that parses can still fail to lay out; both failures fall back
    // to showing the source instead of an empty frame.
    const rendered = await settle(
      renderDiagramSvg(mermaid, `mermaid-diagram-${String(sequence)}`, code),
      signal,
    );
    if (!rendered.ok || rendered.value === undefined) {
      set(setMermaidDiagramResult$, key, { status: "error" });
      return;
    }

    // Parsed in a detached element. The markup never reaches the document, so
    // the only thing that ever shows it is an <img>, where a data URL SVG
    // cannot run scripts or resolve page-level CSS custom properties.
    const host = document.createElement("div");
    host.innerHTML = rendered.value;
    const svg = host.querySelector("svg");
    if (!svg) {
      set(setMermaidDiagramResult$, key, { status: "error" });
      return;
    }

    set(setMermaidDiagramResult$, key, {
      status: "rendered",
      url: svgDataUrl(sizeDiagramAndSerialize(svg)),
    });
  },
);

export const mermaidDiagramRef$ = onRef(renderMermaidDiagram$);
