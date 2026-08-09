import { command, computed, state } from "ccstate";
import { onRef, settle } from "./utils.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-page/chat-thread-pane-state.ts";
import { pageSignal$ } from "./page-signal.ts";

export type MermaidDiagramResult =
  | { readonly status: "rendering" }
  | {
      readonly status: "rendered";
      readonly file: File;
      readonly url: string;
    }
  | { readonly status: "error" };

const internalMermaidDiagramResultByKey$ = state<
  Record<string, MermaidDiagramResult>
>({});

export const mermaidDiagramResultByKey$ = computed((get) => {
  return get(internalMermaidDiagramResultByKey$);
});

/**
 * Diagrams are identified by their thread scope, source, and theme. Identical
 * diagrams within one scope share a result, while a thread or theme switch
 * renders a new one.
 */
export function mermaidDiagramKey(
  code: string,
  theme: string,
  scope: string,
): string {
  return `${scope}:${theme}:${code}`;
}

const setMermaidDiagramResult$ = command(
  ({ set }, key: string, result: MermaidDiagramResult) => {
    set(internalMermaidDiagramResultByKey$, (current) => {
      return { ...current, [key]: result };
    });
  },
);

// Rendered entries are refcounted by mounted canvases and dropped once the last
// one detaches. Their object URLs belong to the containing chat panel, but a
// same-thread query navigation can replace that panel while retaining the
// mounted canvas. Defer revocation until both the owner has ended and the last
// canvas has detached so the semantic thread key cannot retain a revoked URL.
const internalMermaidDiagramRefCountByKey$ = state<Record<string, number>>({});
const internalPendingMermaidObjectUrlRevocationsByKey$ = state<
  Record<string, readonly string[]>
>({});

const revokeMermaidObjectUrlWhenUnused$ = command(
  ({ get, set }, key: string, url: string) => {
    const refCount = get(internalMermaidDiagramRefCountByKey$)[key] ?? 0;
    if (refCount === 0) {
      URL.revokeObjectURL(url);
      return;
    }
    set(internalPendingMermaidObjectUrlRevocationsByKey$, (current) => {
      return {
        ...current,
        [key]: [...(current[key] ?? []), url],
      };
    });
  },
);

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
  for (const url of get(internalPendingMermaidObjectUrlRevocationsByKey$)[
    key
  ] ?? []) {
    URL.revokeObjectURL(url);
  }
  set(internalPendingMermaidObjectUrlRevocationsByKey$, (current) => {
    return withoutKey(current, key);
  });
  set(internalMermaidDiagramResultByKey$, (current) => {
    return withoutKey(current, key);
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
 * Keep the rendered SVG as a browser-native file. The containing chat panel or
 * page owns its object URL, while preview surfaces reuse it with File metadata.
 */
function svgFile(markup: string): File {
  return new File([markup], "diagram.svg", { type: "image/svg+xml" });
}

/**
 * Renders one diagram into an SVG file. mermaid 11 isolates concurrent `render`
 * calls, so several diagrams in one message can render in parallel.
 *
 * `el` carries the source and theme to render and retains the shared result for
 * the element's lifetime. The matching chat panel or page owns the object URL;
 * the diagram itself is shown by an <img> and never enters the document.
 */
const renderMermaidDiagram$ = command(
  async ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    const code = el.dataset.mermaidCode ?? "";
    const theme = el.dataset.mermaidTheme === "dark" ? "dark" : "light";
    const scope = el.dataset.mermaidScope ?? "";
    const key = mermaidDiagramKey(code, theme, scope);
    const panelSignal = [
      get(currentLeftThread$),
      get(currentRightThread$),
    ].find((thread) => {
      return thread?.threadId === scope;
    })?.signal;
    const objectUrlSignal = panelSignal ?? get(pageSignal$);

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
    // the only thing that ever shows it is an <img>, where an object URL SVG
    // cannot run scripts or resolve page-level CSS custom properties.
    const host = document.createElement("div");
    host.innerHTML = rendered.value;
    const svg = host.querySelector("svg");
    if (!svg) {
      set(setMermaidDiagramResult$, key, { status: "error" });
      return;
    }

    const file = svgFile(sizeDiagramAndSerialize(svg));
    objectUrlSignal.throwIfAborted();
    const url = URL.createObjectURL(file);
    objectUrlSignal.addEventListener(
      "abort",
      () => {
        set(revokeMermaidObjectUrlWhenUnused$, key, url);
      },
      { once: true },
    );
    set(setMermaidDiagramResult$, key, {
      status: "rendered",
      file,
      url,
    });
  },
);

export const mermaidDiagramRef$ = onRef(renderMermaidDiagram$);
