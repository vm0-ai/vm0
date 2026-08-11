import { command, computed, state, type Computed } from "ccstate";

import { theme$ } from "./theme.ts";
import { onRef } from "./utils.ts";

/**
 * Mermaid diagrams render through a pull model. Each unique diagram source in
 * a scope owns one `MermaidDiagramSignals` in a module-scope registry; its
 * `diagram$` computed loads mermaid, lays the diagram out and resolves to an
 * image the view shows in an `<img>`. Reading the theme inside the computed
 * makes a theme switch re-render every diagram without any remounting.
 *
 * Registration is a command. The chat pipeline registers diagrams when it
 * parses an event's tree; surfaces that parse during render register on mount
 * through `mermaidDiagramRegisterRef$`, the same dataset-driven `onRef` shape
 * as `imageLoadStatusRef$`.
 *
 * The image is a `data:` URL, so there is nothing to revoke and no lifetime to
 * manage: entries live as long as the registry, keyed by content.
 */
export interface MermaidDiagramImage {
  readonly url: string;
  readonly file: File;
}

export interface MermaidDiagramSignals {
  readonly code: string;
  readonly diagram$: Computed<Promise<MermaidDiagramImage>>;
}

export function mermaidDiagramKey(code: string, scope: string): string {
  return `${scope}:${code}`;
}

const internalMermaidDiagramsByKey$ = state<
  ReadonlyMap<string, MermaidDiagramSignals>
>(new Map());

export const mermaidDiagramsByKey$ = computed(
  (get): ReadonlyMap<string, MermaidDiagramSignals> => {
    return get(internalMermaidDiagramsByKey$);
  },
);

// mermaid costs ~170 KB gzipped for the first diagram, so it is only fetched
// once a diagram actually needs rendering; the computed memoizes the promise.
const mermaidModule$ = computed(() => {
  return import("mermaid");
});

/**
 * mermaid needs a DOM id per `render` call. Concurrent renders only happen for
 * distinct key+theme pairs — the same pair is one deduplicated computed — so a
 * deterministic hash of both is collision-free where it matters.
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

function createMermaidDiagramSignals(
  code: string,
  key: string,
): MermaidDiagramSignals {
  const diagram$ = computed(async (get): Promise<MermaidDiagramImage> => {
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
      diagramRenderId(`${theme}:${key}`),
      code,
    );
    if (markup === undefined) {
      throw new Error("mermaid source failed to parse");
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
    return {
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`,
      file: svgFile(serialized),
    };
  });
  return { code, diagram$ };
}

export const registerMermaidDiagram$ = command(
  ({ get, set }, code: string, scope: string): MermaidDiagramSignals => {
    const current = get(internalMermaidDiagramsByKey$);
    const key = mermaidDiagramKey(code, scope);
    const existing = current.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const signals = createMermaidDiagramSignals(code, key);
    const next = new Map(current);
    next.set(key, signals);
    set(internalMermaidDiagramsByKey$, next);
    return signals;
  },
);

const registerMermaidDiagramOnRef$ = command(
  ({ set }, el: HTMLElement, _signal: AbortSignal): void => {
    const code = el.dataset.mermaidCode;
    if (code !== undefined) {
      set(registerMermaidDiagram$, code, el.dataset.mermaidScope ?? "");
    }
  },
);

/**
 * Mount-time registration for surfaces that parse markdown during render and
 * therefore have no command of their own to register diagrams from. The chat
 * pipeline registers ahead of time, so its placeholders never mount.
 */
export const mermaidDiagramRegisterRef$ = onRef(registerMermaidDiagramOnRef$);
