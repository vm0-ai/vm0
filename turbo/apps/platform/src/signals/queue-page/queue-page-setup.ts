import { command } from "ccstate";
import { createElement } from "react";
import { ZeroQueuePage } from "../../views/queue-page/zero-queue-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detach, Reason } from "../utils.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { switchActiveAgent$ } from "../zero-page/zero-chat.ts";
import { startQueuePolling$ } from "./queue-signals.ts";

export const setupQueuePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(updatePage$, createElement(ZeroQueuePage));
  set(updateDocumentTitle$, "Queue");
  if (await set(onboardGuard$, signal)) {
    return;
  }

  await set(switchActiveAgent$, null, signal);
  detach(set(startQueuePolling$, signal), Reason.Entrance);
});
