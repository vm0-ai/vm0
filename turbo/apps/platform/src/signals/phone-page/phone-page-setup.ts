import { command } from "ccstate";
import { createElement } from "react";
import { SidebarLayout } from "../../views/zero-page/sidebar-layout.tsx";
import { PhonePage } from "../../views/phone-page/phone-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { onboardGuard$ } from "../zero-page/onboard-guard.ts";
import { reloadChatThreads$ } from "../chat-page/chat-message.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { fetchPhoneStatus$ } from "./phone-signals.ts";

export const setupPhonePage$ = command(async ({ set }, signal: AbortSignal) => {
  set(
    updatePage$,
    createElement(SidebarLayout, null, createElement(PhonePage)),
  );
  set(updateDocumentTitle$, "Phone");
  await set(hideAppSkeleton$, signal);

  if (await set(onboardGuard$, signal)) {
    return;
  }

  set(reloadChatThreads$);
  await set(fetchPhoneStatus$, signal);
});
