import { command } from "ccstate";
import { createElement } from "react";

import { BrowserSessionPage } from "../../views/browser-session/browser-session-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import {
  createBrowserSessionSignals,
  parseBrowserSessionUrl,
} from "../chat-page/browser-session-block.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$ } from "../route.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { setBrowserSessionPageSignals$ } from "./browser-session-page-state.ts";

export const setupBrowserSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const browserId = String(get(pathParams$)?.browserId ?? "");
    const descriptor = parseBrowserSessionUrl(`/browsers/${browserId}`);
    set(
      setBrowserSessionPageSignals$,
      descriptor ? createBrowserSessionSignals(null, descriptor) : null,
    );
    set(updatePage$, createElement(BrowserSessionPage), "minimal");
    set(updateDocumentTitle$, "Live browser");
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    await set(onboardGuard$, signal);
  },
);
