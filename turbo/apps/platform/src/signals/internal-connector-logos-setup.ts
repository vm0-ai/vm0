import { command } from "ccstate";
import { createElement } from "react";
import { InternalConnectorLogos } from "../views/internal-connector-logos.tsx";
import { updatePage$ } from "./react-router.ts";

export const setupInternalConnectorLogos$ = command(({ set }) => {
  set(updatePage$, createElement(InternalConnectorLogos));
});
