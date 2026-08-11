import { command, computed, state, type Command, type Computed } from "ccstate";
import type { Element, Root } from "hast";

import { isImageUrl, isSafeMediaUrl } from "../lib/media-url.ts";

/**
 * Load state of one presented image. The owner that prepares an image for
 * rendering — a parsed tree, a card's signals, a composer attachment — creates
 * or registers the signals and hands them to the view; the view only reports
 * the `<img>` element's load events back and renders from `status$`. There is
 * no keyed lookup anywhere.
 */
export type ImageLoadStatus = "loading" | "loaded" | "error";

export interface ImageLoadSignals {
  readonly status$: Computed<ImageLoadStatus>;
  readonly loaded$: Command<void, []>;
  readonly failed$: Command<void, []>;
}

export function createImageLoadSignals(): ImageLoadSignals {
  const internalStatus$ = state<ImageLoadStatus>("loading");
  return {
    status$: computed((get) => {
      return get(internalStatus$);
    }),
    loaded$: command(({ set }) => {
      set(internalStatus$, "loaded");
    }),
    failed$: command(({ set }) => {
      set(internalStatus$, "error");
    }),
  };
}

const internalImageLoadByUrl$ = state<ReadonlyMap<string, ImageLoadSignals>>(
  new Map(),
);

/**
 * Get-or-create by source URL. Copies of the same image share one entry, and
 * an entry survives the re-parses of a streaming message — the reused `<img>`
 * element never refires its load event, so fresh signals would strand a loaded
 * image behind its placeholder.
 */
export const registerImageLoad$ = command(
  ({ get, set }, url: string): ImageLoadSignals => {
    const current = get(internalImageLoadByUrl$);
    const existing = current.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const signals = createImageLoadSignals();
    const next = new Map(current);
    next.set(url, signals);
    set(internalImageLoadByUrl$, next);
    return signals;
  },
);

// Written by the tree-preparing command alongside `mermaidSignals`; the parse
// pipeline itself never produces it.
declare module "hast" {
  interface Data {
    imageLoadSignals?: ImageLoadSignals;
  }
}

function mediaImageUrl(node: Element): string | undefined {
  if (node.tagName === "img") {
    const src = node.properties.src;
    return typeof src === "string" && isSafeMediaUrl(src) ? src : undefined;
  }
  if (node.tagName === "a") {
    const href = node.properties.href;
    return typeof href === "string" && isSafeMediaUrl(href) && isImageUrl(href)
      ? href
      : undefined;
  }
  return undefined;
}

/**
 * Attach load signals to every node the media renderers show as an inline
 * image preview: `<img>` elements and links whose destination is an image.
 */
export function embedImageLoadSignals(
  tree: Root,
  resolve: (url: string) => ImageLoadSignals,
): void {
  const visitNode = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== "element") {
        continue;
      }
      const url = mediaImageUrl(child);
      if (url !== undefined) {
        child.data = { ...child.data, imageLoadSignals: resolve(url) };
      }
      visitNode(child);
    }
  };
  visitNode(tree);
}
