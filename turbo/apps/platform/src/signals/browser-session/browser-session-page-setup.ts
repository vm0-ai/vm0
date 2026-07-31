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
import { i18n } from "../../i18n/index.ts";

export const setupBrowserSessionPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = String(get(pathParams$)?.browserThreadId ?? "");
    const descriptor = parseBrowserSessionUrl(`/browsers/${threadId}`);
    set(
      setBrowserSessionPageSignals$,
      descriptor ? createBrowserSessionSignals(descriptor) : null,
    );
    set(updatePage$, createElement(BrowserSessionPage), "minimal");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.browserSession.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    await set(onboardGuard$, signal);
  },
);
