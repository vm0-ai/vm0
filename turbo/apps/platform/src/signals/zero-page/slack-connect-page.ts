import { command } from "ccstate";
import { createElement } from "react";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { ZeroSlackConnectPage } from "../../views/zero-page/zero-slack-connect-page.tsx";
import {
  resetSlackConnectState$,
  initSlackConnectPage$,
} from "./slack-connect-signals.ts";

export const setupSlackConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(resetSlackConnectState$);
    set(updatePage$, createElement(ZeroSlackConnectPage));
    set(updateDocumentTitle$, "Connect Slack");
    await set(initSlackConnectPage$, signal);
  },
);
