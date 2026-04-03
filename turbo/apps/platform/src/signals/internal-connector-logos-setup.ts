import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";

export const setupInternalConnectorLogos$ = command(
  async ({ set }, signal: AbortSignal) => {
    const { InternalConnectorLogos } =
      await import("../views/internal-connector-logos.tsx");
    signal.throwIfAborted();
    set(updatePage$, createElement(InternalConnectorLogos));
    await set(hideAppSkeleton$, signal);
  },
);
