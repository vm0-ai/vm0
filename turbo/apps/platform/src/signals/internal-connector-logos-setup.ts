import { command } from "ccstate";
import { createElement } from "react";
import { InternalConnectorLogos } from "../views/internal-connector-logos.tsx";
import { updatePage$ } from "./react-router.ts";
import { hideAppSkeleton$ } from "./app-skeleton.ts";

export const setupInternalConnectorLogos$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(InternalConnectorLogos));
    await set(hideAppSkeleton$, signal);
  },
);
